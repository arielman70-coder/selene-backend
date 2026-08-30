import { randomInt } from 'crypto';
import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  createDiscountCode,
  createPriceRule,
  deletePriceRule,
} from './shopify';
import type { CouponType } from '../db/schema';

/**
 * Crypto-random, not Math.random. These codes are bearer instruments — a
 * predictable generator means anyone can mint themselves a discount by
 * guessing forward from a code they were legitimately issued.
 *
 * Alphabet omits I/O/0/1 so codes survive being read off a phone screen.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(prefix: string, length = 8): string {
  let body = '';
  for (let i = 0; i < length; i++) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${prefix}-${body}`;
}

interface CreatedCoupon {
  code: string;
  expiresAt: string;
  priceRuleId: number;
  discountId: number;
}

/**
 * Creates the Shopify price rule + code, then records it locally.
 *
 * If the local insert fails we delete the Shopify price rule. A coupon that
 * exists in Shopify but not in our DB is worse than no coupon: it's live and
 * redeemable, and nothing will ever expire or reconcile it.
 */
async function mintCoupon(params: {
  prefix: string;
  title: string;
  type: CouponType;
  discountType: 'percentage' | 'fixed_amount';
  value: number;
  ttlMs: number;
  customerId?: string | null;
  shopifyCustomerId?: number | null;
}): Promise<CreatedCoupon> {
  const code = generateCode(params.prefix);
  const startsAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + params.ttlMs).toISOString();

  const priceRuleId = await createPriceRule({
    title: `${params.title} - ${code}`,
    valueType: params.discountType,
    value: params.value,
    startsAt,
    endsAt: expiresAt,
    usageLimit: 1,
    shopifyCustomerId: params.shopifyCustomerId ?? null,
  });

  let discountId: number;
  try {
    discountId = await createDiscountCode(priceRuleId, code);
  } catch (err) {
    await deletePriceRule(priceRuleId).catch((cleanupErr) =>
      logger.error('Failed to clean up orphaned price rule', cleanupErr, { priceRuleId }),
    );
    throw err;
  }

  const { error } = await db.from('dynamic_coupons').insert({
    code,
    shopify_price_rule_id: priceRuleId,
    shopify_discount_id: discountId,
    type: params.type,
    customer_id: params.customerId ?? null,
    discount_type: params.discountType,
    discount_value: params.value,
    max_uses: 1,
    expires_at: expiresAt,
    status: 'active',
  });

  if (error) {
    await deletePriceRule(priceRuleId).catch((cleanupErr) =>
      logger.error('Failed to revoke coupon after DB insert failure', cleanupErr, {
        priceRuleId,
        code,
      }),
    );
    throw new Error(`Failed to record coupon ${code}: ${error.message}`);
  }

  logger.info('Coupon created', { code, type: params.type, expiresAt });
  return { code, expiresAt, priceRuleId, discountId };
}

export async function createAbandonedCartCoupon(params: {
  customerId?: string | null;
  shopifyCustomerId?: number | null;
  discountPct?: number;
  ttlHours?: number;
}): Promise<CreatedCoupon> {
  return mintCoupon({
    prefix: 'CART',
    title: 'Abandoned Cart Recovery',
    type: 'abandoned_cart',
    discountType: 'percentage',
    value: params.discountPct ?? env.ABANDONED_CART_COUPON_PCT,
    ttlMs: (params.ttlHours ?? env.ABANDONED_CART_COUPON_HOURS) * 3600 * 1000,
    customerId: params.customerId,
    shopifyCustomerId: params.shopifyCustomerId,
  });
}

export async function createCashbackCoupon(params: {
  customerId: string;
  shopifyCustomerId?: number | null;
  /** Fixed ILS amount. */
  amount: number;
}): Promise<CreatedCoupon> {
  return mintCoupon({
    prefix: 'CB',
    title: 'Cashback Redemption',
    type: 'cashback_redeem',
    discountType: 'fixed_amount',
    value: params.amount,
    ttlMs: env.CASHBACK_COUPON_TTL_DAYS * 24 * 3600 * 1000,
    customerId: params.customerId,
    shopifyCustomerId: params.shopifyCustomerId,
  });
}

export async function createUpsellCoupon(params: {
  customerId?: string | null;
  shopifyCustomerId?: number | null;
  discountPct?: number;
}): Promise<CreatedCoupon> {
  return mintCoupon({
    prefix: 'PLUS',
    title: 'Post-Purchase Upsell',
    type: 'upsell',
    discountType: 'percentage',
    value: params.discountPct ?? env.UPSELL_COUPON_PCT,
    ttlMs: env.UPSELL_OFFER_TTL_HOURS * 3600 * 1000,
    customerId: params.customerId,
    shopifyCustomerId: params.shopifyCustomerId,
  });
}

/**
 * Best-effort revocation, used when a redemption debit fails after the coupon
 * was already minted. Marks it revoked locally even if the Shopify call fails
 * so it stops being offered to the customer.
 */
export async function revokeCoupon(code: string, priceRuleId: number | null): Promise<void> {
  if (priceRuleId) {
    await deletePriceRule(priceRuleId).catch((err) =>
      logger.error('Shopify price rule deletion failed during revoke', err, { code, priceRuleId }),
    );
  }
  await db.from('dynamic_coupons').update({ status: 'revoked' }).eq('code', code);
}
