import type { Request, Response } from 'express';
import { db } from '../db/client';
import { env } from '../config/env';
import { claimWebhookEvent, markFailed, markProcessed } from '../utils/idempotency';
import {
  calculateAndApplyCashback,
  recalculateTier,
  upsertCustomer,
} from '../services/cashback';
import { enqueueUpsell } from '../jobs/upsell-sender';
import { logger } from '../utils/logger';
import { extractContact, extractLineItems } from './checkout-create';
import type { Order } from '../db/schema';

const TOPIC = 'orders/create';

/**
 * The critical path: customer identity, order record, cart conversion,
 * cashback, tier, upsell scheduling.
 *
 * Ordering is deliberate. Cashback is credited before the upsell is queued so
 * a failure in offer-matching can never cost the customer their cashback.
 */
export async function handleOrderCreate(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const shopifyOrderId = payload?.id ? String(payload.id) : null;

  if (!shopifyOrderId) {
    res.status(400).json({ error: 'Missing order id' });
    return;
  }

  res.status(200).json({ received: true });

  if (!(await claimWebhookEvent(TOPIC, shopifyOrderId))) return;

  try {
    const { email, phone } = extractContact(payload);

    const customer = await upsertCustomer({
      email,
      phone,
      shopify_id: payload.customer?.id ?? null,
      first_name: payload.billing_address?.first_name ?? payload.customer?.first_name ?? null,
      last_name: payload.billing_address?.last_name ?? payload.customer?.last_name ?? null,
    });

    if (!customer) {
      logger.warn('Order has no reachable customer; recording order only', { shopifyOrderId });
    }

    const subtotal = Number.parseFloat(payload.subtotal_price ?? '0');
    const total = Number.parseFloat(payload.total_price ?? '0');

    // shopify_order_id is a bigint column. Passing a JS BigInt here would
    // throw ("Do not know how to serialize a BigInt") — send the string and
    // let Postgres coerce it.
    const { data: order, error: orderError } = await db
      .from('orders')
      .upsert(
        {
          shopify_order_id: shopifyOrderId,
          shopify_order_name: payload.name ?? null,
          customer_id: customer?.id ?? null,
          email,
          phone,
          subtotal,
          total,
          currency: payload.currency ?? 'ILS',
          financial_status: payload.financial_status ?? null,
          fulfillment_status: payload.fulfillment_status ?? null,
          line_items: extractLineItems(payload),
          raw_payload: payload,
        },
        { onConflict: 'shopify_order_id' },
      )
      .select()
      .single();

    if (orderError || !order) {
      throw new Error(`Failed to record order: ${orderError?.message ?? 'no row returned'}`);
    }

    await markCheckoutConverted(payload, email, phone);

    if (customer) {
      await calculateAndApplyCashback(customer, order as Order, subtotal);
      await recalculateTier(customer.id);

      await enqueueUpsell({
        orderId: (order as Order).id,
        customerId: customer.id,
        phone,
        email,
        lineItems: extractLineItems(payload),
        scheduledFor: new Date(Date.now() + env.UPSELL_DELAY_MINUTES * 60_000),
      });
    }

    await markProcessed(TOPIC, shopifyOrderId);
    logger.info('Order processed', { shopifyOrderId, customerId: customer?.id, subtotal });
  } catch (err) {
    logger.error('order-create handler failed', err, { shopifyOrderId });
    await markFailed(TOPIC, shopifyOrderId, err);
  }
}

/**
 * Stops the abandoned-cart job chasing someone who already bought.
 *
 * Matched on the checkout token when Shopify gives us one, and only then
 * falling back to email/phone. Matching on email alone is what the naive
 * version does, and with a null email that becomes `.eq('email', undefined)` —
 * which PostgREST turns into a filter that can sweep unrelated rows.
 */
async function markCheckoutConverted(
  payload: any,
  email: string | null,
  phone: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const token = payload.checkout_token ? String(payload.checkout_token) : null;

  if (token) {
    const { data } = await db
      .from('abandoned_checkouts')
      .update({ status: 'converted', converted_at: now })
      .eq('shopify_checkout_id', token)
      .eq('status', 'pending')
      .select('id');

    if (data && data.length > 0) return;
  }

  if (!email && !phone) return;

  const query = db
    .from('abandoned_checkouts')
    .update({ status: 'converted', converted_at: now })
    .in('status', ['pending', 'reminder_sent']);

  if (email) {
    await query.eq('email', email);
  } else if (phone) {
    await query.eq('phone', phone);
  }
}
