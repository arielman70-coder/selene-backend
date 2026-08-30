import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { Customer, Order, Tier, TierConfig } from '../db/schema';

export interface UpsertCustomerInput {
  email?: string | null;
  phone?: string | null;
  shopify_id?: number | null;
  first_name?: string | null;
  last_name?: string | null;
}

/**
 * Identity resolution: email first, then phone, then Shopify customer id.
 *
 * Order matters — a guest checkout may carry only a phone, and the same
 * person's later account order carries an email. Matching in a fixed order
 * keeps them on one row instead of splitting their cashback balance.
 */
export async function upsertCustomer(data: UpsertCustomerInput): Promise<Customer | null> {
  const email = data.email?.toLowerCase().trim() || null;
  const phone = data.phone || null;

  if (!email && !phone && !data.shopify_id) return null;

  let existing: Customer | null = null;

  if (email) {
    const { data: found } = await db
      .from('customers').select('*').eq('email', email).maybeSingle();
    existing = found as Customer | null;
  }
  if (!existing && phone) {
    const { data: found } = await db
      .from('customers').select('*').eq('phone', phone).maybeSingle();
    existing = found as Customer | null;
  }
  if (!existing && data.shopify_id) {
    const { data: found } = await db
      .from('customers').select('*').eq('shopify_id', data.shopify_id).maybeSingle();
    existing = found as Customer | null;
  }

  if (existing) {
    // Only fill blanks. Shopify payloads are frequently partial, and letting
    // a checkout webhook with no name blank out a name we already have is a
    // silent data-loss bug.
    const updates: Record<string, unknown> = {};
    if (data.shopify_id && !existing.shopify_id) updates.shopify_id = data.shopify_id;
    if (data.first_name && !existing.first_name) updates.first_name = data.first_name;
    if (data.last_name && !existing.last_name) updates.last_name = data.last_name;
    if (email && !existing.email) updates.email = email;
    if (phone && !existing.phone) updates.phone = phone;

    if (Object.keys(updates).length === 0) return existing;

    const { data: updated, error } = await db
      .from('customers').update(updates).eq('id', existing.id).select().single();

    if (error) {
      // A unique-violation here means the new email/phone already belongs to
      // another row — two records for one human. Keep the match we have and
      // flag it rather than failing the whole webhook.
      logger.warn('Customer merge conflict; keeping existing record', {
        customerId: existing.id,
        error: error.message,
      });
      return existing;
    }
    return updated as Customer;
  }

  // The customers_contactable CHECK requires one of these; an order with
  // neither (rare, but Shopify allows it) gets no customer row rather than a
  // constraint violation surfacing as a failed webhook.
  if (!email && !phone) return null;

  const { data: created, error } = await db
    .from('customers')
    .insert({
      email,
      phone,
      shopify_id: data.shopify_id ?? null,
      first_name: data.first_name ?? null,
      last_name: data.last_name ?? null,
      tier: 'bronze',
    })
    .select()
    .single();

  if (error) {
    // Lost a race with a concurrent webhook for the same person — read the
    // winner's row instead of throwing.
    if (error.code === '23505') {
      const { data: raced } = await db
        .from('customers')
        .select('*')
        .or([
          email ? `email.eq.${email}` : null,
          phone ? `phone.eq.${phone}` : null,
        ].filter(Boolean).join(','))
        .maybeSingle();
      if (raced) return raced as Customer;
    }
    throw new Error(`Failed to create customer: ${error.message}`);
  }

  return created as Customer;
}

async function getTierConfig(tier: Tier): Promise<TierConfig | null> {
  const { data } = await db.from('tier_config').select('*').eq('tier', tier).maybeSingle();
  return data as TierConfig | null;
}

/**
 * Credits cashback for an order and writes the ledger row.
 *
 * The unique index `cashback_tx_one_earn_per_order` is the real guard against
 * double-crediting: if a replayed webhook slips past the idempotency claim,
 * the ledger insert fails with 23505 and we leave the balance alone.
 */
export async function calculateAndApplyCashback(
  customer: Customer,
  order: Order,
  subtotal: number,
): Promise<number> {
  const tierConf = await getTierConfig(customer.tier);
  const pct = tierConf?.cashback_pct ?? 0.02;

  // Round to agorot. Bankers' rounding isn't worth the complexity at this size.
  const earned = Math.round(subtotal * pct * 100) / 100;
  if (earned <= 0) return 0;

  // Claim the ledger slot BEFORE moving money. If this row already exists the
  // order was already credited and we stop here without touching the balance.
  const { error: claimError } = await db.from('cashback_transactions').insert({
    customer_id: customer.id,
    order_id: order.id,
    type: 'earn',
    amount: earned,
    balance_after: 0, // backfilled below once the RPC returns the true balance
    description: `הזמנה ${order.shopify_order_name ?? ''} — ${(pct * 100).toFixed(1)}% קאשבק`,
  });

  if (claimError) {
    if (claimError.code === '23505') {
      logger.info('Cashback already credited for order; skipping', { orderId: order.id });
      return 0;
    }
    throw new Error(`Failed to write cashback ledger: ${claimError.message}`);
  }

  const { data: updated, error: rpcError } = await db.rpc('increment_cashback', {
    p_customer_id: customer.id,
    p_earn_amount: earned,
    p_total_amount: subtotal,
  });

  if (rpcError) {
    // Roll the ledger claim back so a retry can credit properly.
    await db.from('cashback_transactions')
      .delete().eq('order_id', order.id).eq('type', 'earn');
    throw new Error(`increment_cashback failed: ${rpcError.message}`);
  }

  const balanceAfter = (updated as Customer | null)?.cashback_balance ?? 0;

  await db.from('cashback_transactions')
    .update({ balance_after: balanceAfter })
    .eq('order_id', order.id)
    .eq('type', 'earn');

  await db.from('orders').update({ cashback_earned: earned }).eq('id', order.id);

  logger.info('Cashback credited', {
    customerId: customer.id,
    orderId: order.id,
    earned,
    balanceAfter,
  });

  return earned;
}

/** Claws back cashback when an order is refunded. */
export async function reverseCashbackForOrder(
  orderId: string,
  refundRatio: number,
): Promise<void> {
  const { data: order } = await db
    .from('orders')
    .select('id, customer_id, subtotal, cashback_earned, cashback_reversed, shopify_order_name')
    .eq('id', orderId)
    .maybeSingle();

  if (!order?.customer_id) return;

  const alreadyReversed = Number(order.cashback_reversed ?? 0);
  const target = Math.round(Number(order.cashback_earned ?? 0) * refundRatio * 100) / 100;
  const toReverse = Math.round((target - alreadyReversed) * 100) / 100;
  if (toReverse <= 0) return;

  const spendToReverse = Math.round(Number(order.subtotal ?? 0) * refundRatio * 100) / 100;

  const { data: newBalance, error } = await db.rpc('reverse_cashback', {
    p_customer_id: order.customer_id,
    p_amount: toReverse,
    p_spend_amount: spendToReverse,
  });

  if (error) {
    logger.error('reverse_cashback failed', error, { orderId });
    return;
  }

  await db.from('cashback_transactions').insert({
    customer_id: order.customer_id,
    order_id: order.id,
    type: 'reverse',
    amount: -toReverse,
    balance_after: Number(newBalance ?? 0),
    description: `החזר על הזמנה ${order.shopify_order_name ?? ''}`,
  });

  await db.from('orders')
    .update({ cashback_reversed: alreadyReversed + toReverse })
    .eq('id', order.id);

  await recalculateTier(order.customer_id);

  logger.info('Cashback reversed', { orderId, toReverse });
}

/**
 * Recomputes tier from lifetime spend. Tiers only ever move up here —
 * demoting someone because of a refund is a support ticket waiting to happen.
 */
export async function recalculateTier(customerId: string): Promise<Tier | null> {
  const { data: customer } = await db
    .from('customers').select('total_spent, tier').eq('id', customerId).maybeSingle();
  if (!customer) return null;

  const { data: tiers } = await db
    .from('tier_config')
    .select('tier, min_spent, sort_order')
    .order('min_spent', { ascending: false });

  const current = (tiers ?? []).find((t) => t.tier === customer.tier);
  const earned = (tiers ?? []).find((t) => Number(customer.total_spent) >= Number(t.min_spent));

  if (!earned || earned.tier === customer.tier) return customer.tier as Tier;
  if (current && Number(earned.sort_order) < Number(current.sort_order)) {
    return customer.tier as Tier;
  }

  await db.from('customers').update({ tier: earned.tier }).eq('id', customerId);
  logger.info('Tier upgraded', { customerId, from: customer.tier, to: earned.tier });

  return earned.tier as Tier;
}
