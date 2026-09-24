import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ExpireResult {
  couponsExpired: number;
  checkoutsExpired: number;
  cashbackBalancesExpired: number;
}

/**
 * Hourly housekeeping, in four parts: expire coupons, expire stale carts,
 * expire dormant cashback balances, prune the throwaway tables.
 *
 * Coupon expiry is bookkeeping — Shopify enforces the end date on its own, so
 * this only keeps our view accurate: /api/customer/active-coupon reads
 * status='active', and a stale row there shows the customer a dead code.
 *
 * Cashback expiry is NOT bookkeeping. It is the only thing in the codebase
 * that takes money off a customer without them asking, so it is the one step
 * here that must never run on a half-applied schema — see 005.
 *
 * Each step reports its own failure and the sweep continues: one broken
 * query shouldn't stop the other three from running for another hour.
 */
export async function expireCoupons(): Promise<ExpireResult> {
  const now = new Date().toISOString();
  const result: ExpireResult = {
    couponsExpired: 0,
    checkoutsExpired: 0,
    cashbackBalancesExpired: 0,
  };

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

  // Cashback that has sat untouched past the window. The whole operation —
  // zeroing the balance and writing the 'expire' ledger row — happens inside
  // expire_stale_cashback so a balance can never be cleared without a row
  // explaining it.
  const { data: cashbackCount, error: cashbackError } = await db.rpc('expire_stale_cashback', {
    p_months: env.CASHBACK_EXPIRY_MONTHS,
  });

  if (cashbackError) {
    logger.error('Cashback expiry sweep failed', cashbackError);
  } else {
    result.cashbackBalancesExpired = Number(cashbackCount ?? 0);
    if (result.cashbackBalancesExpired > 0) {
      // Money leaving customer accounts is worth its own line, not just a
      // number folded into the summary below.
      logger.warn('Cashback balances expired', {
        customers: result.cashbackBalancesExpired,
        afterMonths: env.CASHBACK_EXPIRY_MONTHS,
      });
    }
  }

  await db.rpc('prune_rate_limits');
  await db.rpc('prune_login_codes');

  logger.info('Expiry sweep finished', { ...result });
  return result;
}
