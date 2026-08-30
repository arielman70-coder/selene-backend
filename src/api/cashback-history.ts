import type { Request, Response } from 'express';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { ClubRequest } from './middleware';

const MAX_LIMIT = 100;

/**
 * Paginated ledger. Scoped to the authenticated customer's id — the client
 * cannot pass a customer_id, so there's no way to page through someone else's
 * history.
 */
export async function getCashbackHistory(req: Request, res: Response): Promise<void> {
  const customer = (req as ClubRequest).customer!;

  const limit = Math.min(
    Number.parseInt(String(req.query.limit ?? '20'), 10) || 20,
    MAX_LIMIT,
  );
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  try {
    const { data, error, count } = await db
      .from('cashback_transactions')
      .select('id, type, amount, balance_after, description, coupon_code, created_at', {
        count: 'exact',
      })
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);

    res.json({
      balance: Number(customer.cashback_balance ?? 0),
      total_earned: Number(customer.cashback_earned ?? 0),
      total_redeemed: Number(customer.cashback_redeemed ?? 0),
      transactions: (data ?? []).map((t) => ({
        ...t,
        amount: Number(t.amount),
        balance_after: Number(t.balance_after),
      })),
      pagination: {
        limit,
        offset,
        total: count ?? 0,
        has_more: (count ?? 0) > offset + limit,
      },
    });
  } catch (err) {
    logger.error('getCashbackHistory failed', err, { customerId: customer.id });
    res.status(500).json({ error: 'שגיאה בטעינת ההיסטוריה' });
  }
}
