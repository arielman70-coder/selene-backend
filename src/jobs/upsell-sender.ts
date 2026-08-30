import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { sendWhatsApp } from '../services/whatsapp';
import { sendEmail } from '../services/email';
import { createUpsellCoupon } from '../services/coupon';
import { matchUpsellOffer } from '../services/upsell';
import { buildUpsellWhatsApp } from '../templates/whatsapp/upsell';
import { buildUpsellEmail, buildUpsellSubject } from '../templates/email/upsell';
import type { UpsellContext } from '../templates/whatsapp/upsell';
import type { Customer, LineItem, UpsellQueueItem } from '../db/schema';
import type { JobResult } from './abandoned-cart';

export interface EnqueueUpsellInput {
  orderId: string;
  customerId: string | null;
  phone: string | null;
  email: string | null;
  lineItems: LineItem[];
  scheduledFor: Date;
}

/**
 * Queues rather than setTimeout: a dyno restart between the order and the
 * send would silently drop an in-memory timer, and nobody would ever notice
 * the upsells stopped going out.
 */
export async function enqueueUpsell(input: EnqueueUpsellInput): Promise<void> {
  const { error } = await db.from('upsell_queue').upsert(
    {
      order_id: input.orderId,
      customer_id: input.customerId,
      phone: input.phone,
      email: input.email,
      line_items: input.lineItems,
      scheduled_for: input.scheduledFor.toISOString(),
      status: 'pending',
    },
    { onConflict: 'order_id', ignoreDuplicates: true },
  );

  if (error) {
    logger.error('Failed to enqueue upsell', error, { orderId: input.orderId });
    return;
  }

  logger.info('Upsell queued', { orderId: input.orderId, at: input.scheduledFor.toISOString() });
}

/** Drained every minute by the cron endpoint. */
export async function processUpsellQueue(): Promise<JobResult> {
  const result: JobResult = { claimed: 0, sent: 0, skipped: 0, failed: 0 };

  const { data, error } = await db.rpc('claim_upsell_jobs', { p_limit: 25 });
  if (error) {
    logger.error('claim_upsell_jobs failed', error);
    return result;
  }

  const jobs = (data ?? []) as UpsellQueueItem[];
  result.claimed = jobs.length;
  if (jobs.length === 0) return result;

  for (const job of jobs) {
    try {
      const outcome = await processOneUpsell(job);
      if (outcome === 'sent') result.sent += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error('Upsell send failed', err, { jobId: job.id, orderId: job.order_id });

      // claim_upsell_jobs already incremented attempts; at 3 it stops being
      // claimed, so mark it terminally failed rather than leaving it pending.
      await db.from('upsell_queue').update({
        status: job.attempts >= 3 ? 'failed' : 'pending',
        claimed_at: null,
        error_message: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      }).eq('id', job.id);
    }
  }

  logger.info('Upsell job finished', { ...result });
  return result;
}

async function processOneUpsell(job: UpsellQueueItem): Promise<'sent' | 'skipped'> {
  const offer = await matchUpsellOffer(job.line_items ?? []);

  if (!offer) {
    await db.from('upsell_queue')
      .update({ status: 'skipped', claimed_at: null, error_message: 'no matching offer' })
      .eq('id', job.id);
    return 'skipped';
  }

  let customer: Customer | null = null;
  if (job.customer_id) {
    const { data } = await db.from('customers').select('*').eq('id', job.customer_id).maybeSingle();
    customer = data as Customer | null;
  }

  const wantsWhatsApp = Boolean(job.phone) && customer?.opted_in_whatsapp !== false;
  const wantsEmail = Boolean(job.email) && customer?.opted_in_email !== false;

  if (!wantsWhatsApp && !wantsEmail) {
    await db.from('upsell_queue')
      .update({ status: 'skipped', claimed_at: null, error_message: 'no opted-in channel' })
      .eq('id', job.id);
    return 'skipped';
  }

  const { data: order } = await db
    .from('orders').select('shopify_order_name').eq('id', job.order_id).maybeSingle();

  // Minted only once we know we have somewhere to send it — otherwise every
  // skipped job would leave a live discount code behind in Shopify.
  const coupon = await createUpsellCoupon({
    customerId: job.customer_id,
    shopifyCustomerId: customer?.shopify_id ?? null,
    discountPct: Number(offer.discount_pct),
  });

  const ctx: UpsellContext = {
    firstName: customer?.first_name ?? null,
    orderName: order?.shopify_order_name ?? '',
    offerProductTitle: offer.offer_product_title,
    offerProductUrl: offer.offer_product_url,
    discountPct: Number(offer.discount_pct),
    couponCode: coupon.code,
    ttlHours: env.UPSELL_OFFER_TTL_HOURS,
  };

  let delivered = false;

  if (wantsWhatsApp) {
    const res = await sendWhatsApp({
      phone: job.phone,
      message: buildUpsellWhatsApp(ctx),
      customerId: job.customer_id,
      type: 'upsell_offer',
    });
    if (res.status === 'sent') delivered = true;
  }

  if (wantsEmail) {
    const res = await sendEmail({
      to: job.email,
      subject: buildUpsellSubject(ctx),
      html: buildUpsellEmail(ctx),
      customerId: job.customer_id,
      type: 'upsell_offer',
    });
    if (res.status === 'sent') delivered = true;
  }

  if (!delivered) throw new Error('all upsell channels failed');

  await db.from('upsell_queue')
    .update({ status: 'sent', sent_at: new Date().toISOString(), claimed_at: null })
    .eq('id', job.id);

  return 'sent';
}
