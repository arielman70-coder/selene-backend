import type { Request, Response } from 'express';
import { db } from '../db/client';
import { claimWebhookEvent, markFailed, markProcessed } from '../utils/idempotency';
import { reverseCashbackForOrder } from '../services/cashback';
import { logger } from '../utils/logger';

const TOPIC = 'refunds/create';

/**
 * Reverses cashback in proportion to what was actually refunded — a partial
 * refund shouldn't wipe the whole credit, and a full one shouldn't leave the
 * customer holding cashback for a purchase they returned.
 */
export async function handleOrderRefund(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const refundId = payload?.id ? String(payload.id) : null;
  const shopifyOrderId = payload?.order_id ? String(payload.order_id) : null;

  if (!refundId || !shopifyOrderId) {
    res.status(400).json({ error: 'Missing refund or order id' });
    return;
  }

  res.status(200).json({ received: true });

  if (!(await claimWebhookEvent(TOPIC, refundId))) return;

  try {
    const { data: order } = await db
      .from('orders')
      .select('id, subtotal')
      .eq('shopify_order_id', shopifyOrderId)
      .maybeSingle();

    if (!order) {
      logger.warn('Refund for unknown order', { shopifyOrderId, refundId });
      await markProcessed(TOPIC, refundId);
      return;
    }

    // Sum the line-item refunds rather than trusting a single total field;
    // shipping and tax refunds shouldn't claw back product cashback.
    const refundedSubtotal = (payload.refund_line_items ?? []).reduce(
      (sum: number, li: any) => sum + Number.parseFloat(li.subtotal ?? '0'),
      0,
    );

    const orderSubtotal = Number(order.subtotal ?? 0);
    if (orderSubtotal <= 0 || refundedSubtotal <= 0) {
      await markProcessed(TOPIC, refundId);
      return;
    }

    const ratio = Math.min(1, refundedSubtotal / orderSubtotal);
    await reverseCashbackForOrder(order.id, ratio);

    await db.from('orders').update({ financial_status: 'refunded' }).eq('id', order.id);

    await markProcessed(TOPIC, refundId);
    logger.info('Refund processed', { shopifyOrderId, refundId, ratio });
  } catch (err) {
    logger.error('order-refund handler failed', err, { shopifyOrderId, refundId });
    await markFailed(TOPIC, refundId, err);
  }
}
