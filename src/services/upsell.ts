import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { LineItem, UpsellOffer } from '../db/schema';

/**
 * Picks the offer to pitch after a purchase.
 *
 * Two rules that matter more than the matching itself:
 *  - never pitch something already in the order (reads as a bot that didn't
 *    look at what you bought)
 *  - an offer with an empty trigger list is a catch-all, and only wins when
 *    no targeted offer matched
 */
export async function matchUpsellOffer(lineItems: LineItem[]): Promise<UpsellOffer | null> {
  const { data, error } = await db
    .from('upsell_offers')
    .select('*')
    .eq('active', true)
    .order('priority', { ascending: false });

  if (error) {
    logger.error('Failed to load upsell offers', error);
    return null;
  }

  const offers = (data ?? []) as UpsellOffer[];
  if (offers.length === 0) return null;

  const purchased = new Set(
    lineItems.map((li) => li.product_id).filter((id): id is number => typeof id === 'number'),
  );

  const eligible = offers.filter(
    (o) => !(o.offer_product_id && purchased.has(o.offer_product_id)),
  );

  const targeted = eligible.find(
    (o) => o.trigger_product_ids.length > 0
      && o.trigger_product_ids.some((id) => purchased.has(id)),
  );
  if (targeted) return targeted;

  return eligible.find((o) => o.trigger_product_ids.length === 0) ?? null;
}
