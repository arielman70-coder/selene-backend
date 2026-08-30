import { db } from '../db/client';
import { logger } from './logger';

/**
 * Shopify retries a webhook until it gets a 2xx, and will happily deliver the
 * same event twice even after one. Every handler gates on this.
 *
 * The claim is atomic in Postgres (see claim_webhook_event in 002_functions),
 * not a read-then-write here — two simultaneous deliveries of orders/create
 * would both pass a naive `select ... if (!found)` check and double-credit
 * cashback.
 *
 * @returns true when the caller owns this event and should process it.
 */
export async function claimWebhookEvent(topic: string, shopifyId: string): Promise<boolean> {
  const { data, error } = await db.rpc('claim_webhook_event', {
    p_topic: topic,
    p_id: shopifyId,
  });

  if (error) {
    // Fail closed: if we can't prove this is new, don't risk a double send.
    logger.error('claim_webhook_event failed', error, { topic, shopifyId });
    return false;
  }

  return data === true;
}

export async function markProcessed(topic: string, shopifyId: string): Promise<void> {
  const { error } = await db
    .from('webhook_events')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('shopify_topic', topic)
    .eq('shopify_id', shopifyId);

  if (error) logger.error('markProcessed failed', error, { topic, shopifyId });
}

/**
 * Leaves the event unprocessed so the staleness window in claim_webhook_event
 * lets a later delivery retry it.
 */
export async function markFailed(
  topic: string,
  shopifyId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await db
    .from('webhook_events')
    .update({ error_message: message.slice(0, 1000) })
    .eq('shopify_topic', topic)
    .eq('shopify_id', shopifyId);

  if (error) logger.error('markFailed failed', error, { topic, shopifyId });
}
