import type { Request, Response } from 'express';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { ClubRequest } from './middleware';

/**
 * Every live coupon belonging to the caller, so the account page can show
 * "you have a code waiting" instead of the customer losing it in WhatsApp.
 */
export async function getActiveCoupons(req: Request, res: Response): Promise<void> {
  const customer = (req as ClubRequest).customer!;

  try {
    const { data, error } = await db
      .from('dynamic_coupons')
      .select('code, type, discount_type, discount_value, expires_at, created_at')
      .eq('customer_id', customer.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    res.json({
      coupons: (data ?? []).map((c) => ({
        code: c.code,
        type: c.type,
        discount_type: c.discount_type,
        discount_value: Number(c.discount_value),
        expires_at: c.expires_at,
        // Saves the frontend recomputing this against a possibly-skewed clock.
        expires_in_hours: Math.max(
          0,
          Math.round((new Date(c.expires_at!).getTime() - Date.now()) / 3600_000),
        ),
      })),
    });
  } catch (err) {
    logger.error('getActiveCoupons failed', err, { customerId: customer.id });
    res.status(500).json({ error: 'שגיאה בטעינת הקופונים' });
  }
}
