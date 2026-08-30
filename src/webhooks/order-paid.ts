import type { Request, Response } from 'express';
import { db } from '../db/client';
import { claimWebhookEvent, markFailed, markProcessed } from '../utils/idempotency';
import { logger } from '../utils/logger';

const TOPIC = 'orders/paid';

/**
 * Payment confirmation only updates status. Cashback is credited on
 * orders/create, not here — crediting in both places would double-pay, and
 * the ledger's one-earn-per-order index would then reject the second write
 * and mask the bug as a silent no-op.
 */
export async function handleOrderPaid(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const shopifyOrderId = payload?.id ? String(payload.id) : null;

  if (!shopifyOrderId) {
    res.status(400).json({ error: 'Missing order id' });
    return;
  }

  res.status(200).json({ received: true });

  if (!(await claimWebhookEvent(TOPIC, shopifyOrderId))) return;

  try {
    const { error } = await db
      .from('orders')
      .update({
        financial_status: payload.financial_status ?? 'paid',
        fulfillment_status: payload.fulfillment_status ?? null,
      })
      .eq('shopify_order_id', shopifyOrderId);

    if (error) throw new Error(error.message);

    await markProcessed(TOPIC, shopifyOrderId);
  } catch (err) {
    logger.error('order-paid handler failed', err, { shopifyOrderId });
    await markFailed(TOPIC, shopifyOrderId, err);
  }
}
