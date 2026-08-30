import type { Request, Response } from 'express';
import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { createCashbackCoupon, revokeCoupon } from '../services/coupon';
import { sendEmail } from '../services/email';
import { sendWhatsApp } from '../services/whatsapp';
import {
  buildCashbackCodeEmail,
  buildCashbackCodeSubject,
  buildCashbackCodeWhatsApp,
} from '../templates/cashback-code';
import { maskEmail, maskPhone } from '../utils/phone';
import type { ClubRequest } from './middleware';

/**
 * Converts a cashback balance into a fixed-amount Shopify discount code.
 *
 * Order of operations matters and is the reverse of the obvious one:
 *
 *   debit the balance  ->  mint the coupon  ->  write the ledger row
 *
 * Minting first (as the spec sketched it) means a failed or slow debit leaves
 * a live, redeemable code in Shopify that was never paid for — free money,
 * and nothing reconciles it afterwards. Debiting first means the worst case
 * is a failed mint, which we refund immediately and the customer retries.
 *
 * The code itself is NOT returned in the response — it is sent to the email
 * or WhatsApp number already on the customer record. A club session only
 * proves someone typed an email, not that they own it, so echoing the code
 * back would let a stranger convert another person's balance into a discount
 * they could spend. Delivering out-of-band means the worst a stranger can do
 * is move someone's balance into a code only that person receives.
 */
export async function redeemCashback(req: Request, res: Response): Promise<void> {
  const customer = (req as ClubRequest).customer!;

  const amount = Math.round(Number(req.body?.amount) * 100) / 100;

  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'סכום לא תקין' });
    return;
  }

  if (amount < env.CASHBACK_MIN_REDEEM) {
    res.status(400).json({
      error: `מינימום מימוש: ₪${env.CASHBACK_MIN_REDEEM}`,
      minimum: env.CASHBACK_MIN_REDEEM,
    });
    return;
  }

  // Advisory check for a clean error message. The authoritative guard is the
  // `cashback_balance >= p_amount` predicate inside decrement_cashback — this
  // read can go stale between here and the debit, and that's fine.
  if (Number(customer.cashback_balance) < amount) {
    res.status(400).json({
      error: 'יתרה לא מספיקה',
      available: Number(customer.cashback_balance),
    });
    return;
  }

  // One live redemption code at a time, so a customer can't shred a large
  // balance into many small codes and stack them.
  const { data: existing } = await db
    .from('dynamic_coupons')
    .select('code, discount_value, expires_at')
    .eq('customer_id', customer.id)
    .eq('type', 'cashback_redeem')
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (existing) {
    // Same reasoning as below: the amount and expiry are safe to show, the
    // code is not.
    res.status(409).json({
      error: 'יש לך כבר קופון קאשבק פעיל — הקוד נשלח אליך',
      existing_coupon: {
        amount: Number(existing.discount_value),
        expires_at: existing.expires_at,
      },
    });
    return;
  }

  // --- 1. Debit -----------------------------------------------------------
  const { data: newBalanceRaw, error: debitError } = await db.rpc('decrement_cashback', {
    p_customer_id: customer.id,
    p_amount: amount,
  });

  if (debitError) {
    // Raised by the function when the balance predicate fails — i.e. a
    // concurrent redemption won the race.
    if (debitError.message?.includes('Insufficient')) {
      res.status(400).json({ error: 'יתרה לא מספיקה' });
      return;
    }
    logger.error('decrement_cashback failed', debitError, { customerId: customer.id });
    res.status(500).json({ error: 'שגיאה במימוש הקאשבק' });
    return;
  }

  const newBalance = Number(newBalanceRaw ?? 0);

  // --- 2. Mint ------------------------------------------------------------
  let coupon: { code: string; expiresAt: string; priceRuleId: number };
  try {
    coupon = await createCashbackCoupon({
      customerId: customer.id,
      shopifyCustomerId: customer.shopify_id,
      amount,
    });
  } catch (err) {
    logger.error('Coupon creation failed after debit; refunding', err, {
      customerId: customer.id, amount,
    });

    const { error: refundError } = await db.rpc('increment_cashback', {
      p_customer_id: customer.id,
      p_earn_amount: amount,
      p_total_amount: 0,
    });

    if (refundError) {
      // The one case that needs a human: money left the balance and no coupon
      // exists. Logged loudly and written to the ledger so it's recoverable.
      logger.error('CRITICAL: refund after failed mint also failed', refundError, {
        customerId: customer.id, amount,
      });
      await db.from('cashback_transactions').insert({
        customer_id: customer.id,
        type: 'adjust',
        amount: 0,
        balance_after: newBalance,
        description: `נדרש תיקון ידני: חיוב ₪${amount} ללא קופון`,
      });
    }

    res.status(502).json({ error: 'שגיאה ביצירת קוד ההנחה. היתרה לא חויבה.' });
    return;
  }

  // --- 3. Ledger ----------------------------------------------------------
  const { error: ledgerError } = await db.from('cashback_transactions').insert({
    customer_id: customer.id,
    type: 'redeem',
    amount: -amount,
    balance_after: newBalance,
    description: `מימוש קאשבק — קוד ${coupon.code}`,
    coupon_code: coupon.code,
  });

  if (ledgerError) {
    // Balance and coupon are consistent with each other; only the audit row
    // is missing. Undo the whole thing rather than leave an unexplained debit.
    logger.error('Ledger write failed; rolling back redemption', ledgerError, {
      customerId: customer.id, code: coupon.code,
    });
    await revokeCoupon(coupon.code, coupon.priceRuleId);
    await db.rpc('increment_cashback', {
      p_customer_id: customer.id,
      p_earn_amount: amount,
      p_total_amount: 0,
    });
    res.status(500).json({ error: 'שגיאה במימוש הקאשבק. היתרה לא חויבה.' });
    return;
  }

  logger.info('Cashback redeemed', { customerId: customer.id, amount, code: coupon.code });

  // --- 4. Deliver out-of-band --------------------------------------------
  const ctx = {
    firstName: customer.first_name,
    code: coupon.code,
    amount,
    expiresAt: coupon.expiresAt,
    storefrontUrl: env.SHOPIFY_STOREFRONT_URL,
  };

  const destinations: string[] = [];

  if (customer.email) {
    const sent = await sendEmail({
      to: customer.email,
      subject: buildCashbackCodeSubject(ctx),
      html: buildCashbackCodeEmail(ctx),
      customerId: customer.id,
      type: 'cashback_code',
    });
    if (sent.status === 'sent') destinations.push(maskEmail(customer.email));
  }

  if (customer.phone && customer.opted_in_whatsapp !== false) {
    const sent = await sendWhatsApp({
      phone: customer.phone,
      message: buildCashbackCodeWhatsApp(ctx),
      customerId: customer.id,
      type: 'cashback_code',
    });
    if (sent.status === 'sent') destinations.push(maskPhone(customer.phone));
  }

  if (destinations.length === 0) {
    // The balance is spent and a valid code exists, but nothing reached the
    // customer. Surfaced loudly so support can hand it over manually rather
    // than the money just vanishing.
    logger.error('Cashback code minted but undeliverable', undefined, {
      customerId: customer.id, code: coupon.code, amount,
    });
    res.status(200).json({
      discount_amount: amount,
      expires_at: coupon.expiresAt,
      new_balance: newBalance,
      delivered_to: [],
      message: 'הקוד נוצר אך לא הצלחנו לשלוח אותו. פנה אלינו ונעביר לך אותו.',
    });
    return;
  }

  res.json({
    discount_amount: amount,
    expires_at: coupon.expiresAt,
    new_balance: newBalance,
    delivered_to: destinations,
    message: `הקוד נשלח אל ${destinations.join(' ו-')}. תוקף: ${env.CASHBACK_COUPON_TTL_DAYS} ימים`,
  });
}
