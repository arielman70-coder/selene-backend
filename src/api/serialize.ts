import type { Customer } from '../db/schema';

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
