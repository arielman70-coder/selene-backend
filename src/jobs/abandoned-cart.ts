import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { sendWhatsApp } from '../services/whatsapp';
import { sendEmail } from '../services/email';
import { createAbandonedCartCoupon } from '../services/coupon';
import { buildAbandonedCartWhatsApp } from '../templates/whatsapp/abandoned-cart';
import {
  buildAbandonedCartEmail,
  buildAbandonedCartSubject,
} from '../templates/email/abandoned-cart';
import type { AbandonedCartContext } from '../templates/whatsapp/abandoned-cart';
import type { AbandonedCheckout, Customer } from '../db/schema';

export interface JobResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Runs every 5 minutes. Rows are claimed atomically in Postgres
 * (claim_abandoned_checkouts) rather than plain-selected, so a run that takes
 * longer than the cron interval can't have its carts picked up a second time
 * by the next run — which would send the same person the same reminder twice.
 */
export async function processAbandonedCarts(): Promise<JobResult> {
  const result: JobResult = { claimed: 0, sent: 0, skipped: 0, failed: 0 };

  const { data, error } = await db.rpc('claim_abandoned_checkouts', {
    p_delay_minutes: env.ABANDONED_CART_DELAY_MINUTES,
    p_max_reminders: env.ABANDONED_CART_MAX_REMINDERS,
    p_gap_hours: env.ABANDONED_CART_REMINDER_GAP_HOURS,
    p_limit: 50,
  });

  if (error) {
    logger.error('claim_abandoned_checkouts failed', error);
    return result;
  }

  const checkouts = (data ?? []) as AbandonedCheckout[];
  result.claimed = checkouts.length;
  if (checkouts.length === 0) return result;

  // The claim RPC returns bare abandoned_checkouts rows, so the customer join
  // PostgREST would have given us isn't there. One batched lookup beats a
  // query per cart.
  await attachCustomers(checkouts);

  // Sequential, not Promise.all: Shopify's REST API allows ~2 calls/sec and
  // each cart mints a coupon. Firing 50 in parallel just trips the limiter.
  for (const checkout of checkouts) {
    try {
      const outcome = await processOneCheckout(checkout);
      if (outcome === 'sent') result.sent += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error('Abandoned cart processing failed', err, { checkoutId: checkout.id });
      // Release the claim so the next run can retry this cart.
      await db.from('abandoned_checkouts')
        .update({ claimed_at: null })
        .eq('id', checkout.id);
    }
  }

  logger.info('Abandoned cart job finished', { ...result });
  return result;
}

async function processOneCheckout(checkout: AbandonedCheckout): Promise<'sent' | 'skipped'> {
  const customer = (checkout.customers ?? null) as Customer | null;
  const email = checkout.email;
  const phone = checkout.phone;

  // Cross-checkout dedup: someone who abandons three carts in an afternoon
  // gets one message, not three.
  if (await recentlyNotified(email, phone)) {
    logger.info('Skipping recently-notified checkout', { checkoutId: checkout.id });
    await db.from('abandoned_checkouts')
      .update({ claimed_at: null, last_reminder_at: new Date().toISOString() })
      .eq('id', checkout.id);
    return 'skipped';
  }

  if (!checkout.shopify_checkout_url) {
    logger.warn('Checkout has no recovery URL; nothing to link to', { checkoutId: checkout.id });
    await db.from('abandoned_checkouts').update({ status: 'expired' }).eq('id', checkout.id);
    return 'skipped';
  }

  // Reuse the coupon across reminders so the second message doesn't invalidate
  // the code the first one gave out.
  let couponCode = checkout.coupon_code;
  let couponExpiresAt = checkout.coupon_expires_at;

  const stillValid = couponExpiresAt && new Date(couponExpiresAt) > new Date();

  if (!couponCode || !stillValid) {
    const coupon = await createAbandonedCartCoupon({
      customerId: checkout.customer_id,
      shopifyCustomerId: customer?.shopify_id ?? null,
    });
    couponCode = coupon.code;
    couponExpiresAt = coupon.expiresAt;

    await db.from('abandoned_checkouts')
      .update({ coupon_code: couponCode, coupon_expires_at: couponExpiresAt })
      .eq('id', checkout.id);
  }

  const ctx: AbandonedCartContext = {
    firstName: customer?.first_name ?? null,
    cartItems: checkout.cart_items ?? [],
    subtotal: Number(checkout.subtotal ?? 0),
    currency: checkout.currency ?? 'ILS',
    couponCode,
    couponExpiresAt: couponExpiresAt!,
    recoveryUrl: checkout.shopify_checkout_url,
    discountPct: env.ABANDONED_CART_COUPON_PCT,
  };

  const updates: Record<string, unknown> = {};
  let delivered = false;

  if (phone && customer?.opted_in_whatsapp !== false) {
    const res = await sendWhatsApp({
      phone,
      message: buildAbandonedCartWhatsApp(ctx),
      customerId: checkout.customer_id,
      type: 'abandoned_cart_reminder',
    });
    if (res.status === 'sent') {
      updates.whatsapp_sent_at = new Date().toISOString();
      delivered = true;
    }
  }

  if (email && customer?.opted_in_email !== false) {
    const res = await sendEmail({
      to: email,
      subject: buildAbandonedCartSubject(ctx),
      html: buildAbandonedCartEmail(ctx),
      customerId: checkout.customer_id,
      type: 'abandoned_cart_reminder',
    });
    if (res.status === 'sent') {
      updates.email_sent_at = new Date().toISOString();
      delivered = true;
    }
  }

  // Only count a reminder that actually went out. Incrementing on a failed
  // send burns the customer's one remaining attempt on nothing.
  if (delivered) {
    await db.from('abandoned_checkouts').update({
      ...updates,
      status: 'reminder_sent',
      reminder_count: (checkout.reminder_count ?? 0) + 1,
      last_reminder_at: new Date().toISOString(),
      claimed_at: null,
    }).eq('id', checkout.id);
    return 'sent';
  }

  await db.from('abandoned_checkouts').update({ claimed_at: null }).eq('id', checkout.id);
  return 'skipped';
}

async function attachCustomers(checkouts: AbandonedCheckout[]): Promise<void> {
  const ids = [...new Set(
    checkouts.map((c) => c.customer_id).filter((id): id is string => Boolean(id)),
  )];
  if (ids.length === 0) return;

  const { data, error } = await db.from('customers').select('*').in('id', ids);
  if (error) {
    logger.error('Failed to load customers for claimed checkouts', error);
    return;
  }

  const byId = new Map((data as Customer[]).map((c) => [c.id, c]));
  for (const checkout of checkouts) {
    checkout.customers = checkout.customer_id ? byId.get(checkout.customer_id) ?? null : null;
  }
}

async function recentlyNotified(
  email: string | null,
  phone: string | null,
): Promise<boolean> {
  const since = new Date(
    Date.now() - env.ABANDONED_CART_DEDUP_HOURS * 3600_000,
  ).toISOString();

  const recipients = [email, phone].filter((r): r is string => Boolean(r));
  if (recipients.length === 0) return false;

  const { count, error } = await db
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'abandoned_cart_reminder')
    .eq('status', 'sent')
    .in('recipient', recipients)
    .gt('sent_at', since);

  if (error) {
    logger.error('Dedup lookup failed; treating as not-notified', error);
    return false;
  }

  return (count ?? 0) > 0;
}
