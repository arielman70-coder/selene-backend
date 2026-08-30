import { db } from '../db/client';
import { logger } from '../utils/logger';

export interface ExpireResult {
  couponsExpired: number;
  checkoutsExpired: number;
}

/**
 * Hourly housekeeping. Shopify enforces the end date on its own, so this is
 * about keeping our view accurate — /api/customer/active-coupon reads
 * status='active', and a stale row there shows the customer a dead code.
 */
export async function expireCoupons(): Promise<ExpireResult> {
  const now = new Date().toISOString();
  const result: ExpireResult = { couponsExpired: 0, checkoutsExpired: 0 };

  const { data: expired, error } = await db
    .from('dynamic_coupons')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', now)
    .select('id');

  if (error) {
    logger.error('Coupon expiry sweep failed', error);
  } else {
    result.couponsExpired = expired?.length ?? 0;
  }

  const { data: staleCount, error: staleError } = await db.rpc('expire_stale_checkouts', {
    p_days: 7,
  });

  if (staleError) {
    logger.error('Checkout expiry sweep failed', staleError);
  } else {
    result.checkoutsExpired = Number(staleCount ?? 0);
  }

  await db.rpc('prune_rate_limits');

  logger.info('Expiry sweep finished', { ...result });
  return result;
}
