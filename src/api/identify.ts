import type { Request, Response } from 'express';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';
import { issueClubSession } from './middleware';
import type { Customer } from '../db/schema';

/**
 * Customer club lookup: the shopper types the email they ordered with and
 * sees their cashback balance.
 *
 * There is no signup and no password — customer rows are created by the
 * Shopify webhooks, and this only reads one back. It returns a short-lived
 * session token so the other read endpoints don't each re-accept an email.
 *
 * Deliberately returns only what the club page renders. No phone, no order
 * history, no Shopify ids: the endpoint is unauthenticated, so anything in
 * this response is readable by anyone who guesses the address.
 */
export async function identify(req: Request, res: Response): Promise<void> {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const email = rawEmail.toLowerCase().trim();

  // Accepted as an alternative for guest checkouts that never gave an email.
  const phone = normalizePhone(typeof req.body?.phone === 'string' ? req.body.phone : null);

  if (!email && !phone) {
    res.status(400).json({ error: 'נדרש אימייל' });
    return;
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    return;
  }

  try {
    let customer: Customer | null = null;

    // Errors are checked, not swallowed. Ignoring them would make a Supabase
    // outage indistinguishable from "no such customer", and every shopper
    // would be told they have no orders.
    if (email) {
      const { data, error } = await db
        .from('customers').select('*').eq('email', email).maybeSingle();
      if (error) throw new Error(error.message);
      customer = data as Customer | null;
    }
    if (!customer && phone) {
      const { data, error } = await db
        .from('customers').select('*').eq('phone', phone).maybeSingle();
      if (error) throw new Error(error.message);
      customer = data as Customer | null;
    }

    if (!customer) {
      // 404 rather than a fabricated empty profile, so the page can say
      // "we couldn't find orders for this address" instead of showing ₪0 to
      // someone who does have a balance under a different email.
      res.status(404).json({
        error: 'לא נמצאו הזמנות לכתובת הזו',
        code: 'NOT_FOUND',
      });
      return;
    }

    const session = issueClubSession(customer.id);

    logger.info('Club lookup', { customerId: customer.id });

    res.json({
      session_token: session.token,
      expires_in: session.expiresIn,
      customer: clubProfile(customer),
    });
  } catch (err) {
    logger.error('identify failed', err);
    res.status(500).json({ error: 'שגיאה בטעינת הפרטים' });
  }
}

/**
 * The only shape a customer record is ever returned in. Contact details are
 * omitted on purpose — see the note on identify().
 */
export function clubProfile(c: Customer) {
  return {
    first_name: c.first_name,
    tier: c.tier,
    total_spent: Number(c.total_spent ?? 0),
    cashback_balance: Number(c.cashback_balance ?? 0),
    cashback_earned: Number(c.cashback_earned ?? 0),
    cashback_redeemed: Number(c.cashback_redeemed ?? 0),
    opted_in_whatsapp: c.opted_in_whatsapp,
    opted_in_email: c.opted_in_email,
  };
}
