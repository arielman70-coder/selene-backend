import type { Request, Response } from 'express';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { clubProfile } from './identify';
import type { ClubRequest } from './middleware';
import type { TierConfig } from '../db/schema';

/**
 * Profile plus tier progress. The frontend renders a "₪X to gold" bar, so the
 * next threshold is computed here rather than hardcoding the ladder in
 * Lovable where it would drift from tier_config.
 */
export async function getCustomerProfile(req: Request, res: Response): Promise<void> {
  const customer = (req as ClubRequest).customer!;

  try {
    const { data: tiers } = await db
      .from('tier_config').select('*').order('sort_order', { ascending: true });

    const ladder = (tiers ?? []) as TierConfig[];
    const current = ladder.find((t) => t.tier === customer.tier) ?? null;
    const next = ladder.find((t) => Number(t.min_spent) > Number(customer.total_spent)) ?? null;

    res.json({
      customer: clubProfile(customer),
      tier: current && {
        tier: current.tier,
        display_name: current.display_name,
        cashback_pct: Number(current.cashback_pct),
      },
      next_tier: next && {
        tier: next.tier,
        display_name: next.display_name,
        cashback_pct: Number(next.cashback_pct),
        min_spent: Number(next.min_spent),
        remaining: Math.max(0, Number(next.min_spent) - Number(customer.total_spent)),
      },
    });
  } catch (err) {
    logger.error('getCustomerProfile failed', err, { customerId: customer.id });
    res.status(500).json({ error: 'שגיאה בטעינת הפרופיל' });
  }
}

/** Marketing opt-outs. The only fields a customer may change about themselves. */
export async function updatePreferences(req: Request, res: Response): Promise<void> {
  const customer = (req as ClubRequest).customer!;

  const updates: Record<string, boolean> = {};
  if (typeof req.body?.opted_in_whatsapp === 'boolean') {
    updates.opted_in_whatsapp = req.body.opted_in_whatsapp;
  }
  if (typeof req.body?.opted_in_email === 'boolean') {
    updates.opted_in_email = req.body.opted_in_email;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'לא נשלחו שינויים' });
    return;
  }

  const { data, error } = await db
    .from('customers').update(updates).eq('id', customer.id).select().single();

  if (error) {
    logger.error('updatePreferences failed', error, { customerId: customer.id });
    res.status(500).json({ error: 'שגיאה בעדכון ההעדפות' });
    return;
  }

  res.json({ customer: clubProfile(data) });
}
