import type { Request, Response } from 'express';
import { db } from '../db/client';
import { claimWebhookEvent, markFailed, markProcessed } from '../utils/idempotency';
import { upsertCustomer } from '../services/cashback';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import type { LineItem } from '../db/schema';

export function extractLineItems(payload: any): LineItem[] {
  return (payload.line_items ?? []).map((item: any) => ({
    product_id: item.product_id ?? null,
    variant_id: item.variant_id ?? null,
    title: item.title ?? '',
    variant_title: item.variant_title ?? null,
    quantity: item.quantity ?? 1,
    price: String(item.price ?? '0'),
    image_url: item.image_url ?? item.image?.src ?? null,
  }));
}

export function extractContact(payload: any): { email: string | null; phone: string | null } {
  const email = payload.email?.toLowerCase()?.trim() || null;
  const phone = normalizePhone(
    payload.phone
      ?? payload.billing_address?.phone
      ?? payload.shipping_address?.phone
      ?? payload.customer?.phone,
  );
  return { email, phone };
}

/**
 * checkouts/create and checkouts/update share this handler — Shopify fires
 * update as the customer fills in their details, and it's usually the update
 * that first carries an email or phone we can actually reach them on.
 */
export async function handleCheckoutUpsert(
  req: Request,
  res: Response,
  topic: 'checkouts/create' | 'checkouts/update',
): Promise<void> {
  const payload = req.body;
  const checkoutToken = payload?.token ? String(payload.token) : null;

  if (!checkoutToken) {
    res.status(400).json({ error: 'Missing checkout token' });
    return;
  }

  // Ack before doing the work. Shopify's delivery timeout is 5 seconds and it
  // retries on timeout, so slow work here turns into duplicate deliveries.
  res.status(200).json({ received: true });

  // checkouts/update fires repeatedly for one checkout, so the dedup key
  // includes updated_at — otherwise only the first edit would ever land.
  const eventKey = topic === 'checkouts/update'
    ? `${checkoutToken}:${payload.updated_at ?? ''}`
    : checkoutToken;

  if (!(await claimWebhookEvent(topic, eventKey))) return;

  try {
    const { email, phone } = extractContact(payload);

    const customer = (email || phone)
      ? await upsertCustomer({
          email,
          phone,
          shopify_id: payload.customer?.id ?? null,
          first_name: payload.billing_address?.first_name ?? payload.customer?.first_name ?? null,
          last_name: payload.billing_address?.last_name ?? payload.customer?.last_name ?? null,
        })
      : null;

    const { error } = await db.from('abandoned_checkouts').upsert(
      {
        shopify_checkout_id: checkoutToken,
        shopify_checkout_url: payload.abandoned_checkout_url ?? null,
        customer_id: customer?.id ?? null,
        email,
        phone,
        cart_items: extractLineItems(payload),
        subtotal: Number.parseFloat(payload.subtotal_price ?? '0'),
        currency: payload.currency ?? 'ILS',
        raw_payload: payload,
      },
      { onConflict: 'shopify_checkout_id', ignoreDuplicates: false },
    );

    if (error) throw new Error(error.message);

    await markProcessed(topic, eventKey);
  } catch (err) {
    logger.error('checkout upsert handler failed', err, { topic, checkoutToken });
    await markFailed(topic, eventKey, err);
    // Deliberately not rethrown — the 200 has already gone out.
  }
}

export function handleCheckoutCreate(req: Request, res: Response): Promise<void> {
  return handleCheckoutUpsert(req, res, 'checkouts/create');
}
