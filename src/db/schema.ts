/**
 * Hand-maintained mirror of supabase/migrations/*.sql.
 *
 * Regenerate instead with:
 *   npx supabase gen types typescript --project-id <ref> > src/db/generated.ts
 * once the project is linked; until then keep this in step with the SQL.
 */

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';

export interface TierConfig {
  tier: Tier;
  display_name: string;
  min_spent: number;
  cashback_pct: number;
  sort_order: number;
}

export interface Customer {
  id: string;
  shopify_id: number | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  tier: Tier;
  total_spent: number;
  cashback_balance: number;
  cashback_earned: number;
  cashback_redeemed: number;
  opted_in_whatsapp: boolean;
  opted_in_email: boolean;
  created_at: string;
  updated_at: string;
}

export interface LineItem {
  product_id: number | null;
  variant_id: number | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  price: string;
  image_url?: string | null;
}

export interface Order {
  id: string;
  shopify_order_id: number;
  shopify_order_name: string | null;
  customer_id: string | null;
  email: string | null;
  phone: string | null;
  subtotal: number;
  total: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  cashback_earned: number;
  cashback_reversed: number;
  line_items: LineItem[];
  created_at: string;
  updated_at: string;
}

export type CheckoutStatus = 'pending' | 'reminder_sent' | 'converted' | 'expired';

export interface AbandonedCheckout {
  id: string;
  shopify_checkout_id: string;
  shopify_checkout_url: string | null;
  customer_id: string | null;
  email: string | null;
  phone: string | null;
  cart_items: LineItem[];
  subtotal: number;
  currency: string;
  status: CheckoutStatus;
  reminder_count: number;
  last_reminder_at: string | null;
  whatsapp_sent_at: string | null;
  email_sent_at: string | null;
  coupon_code: string | null;
  coupon_expires_at: string | null;
  converted_at: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present when the row was selected with the `customers(*)` join. */
  customers?: Customer | null;
}

export type CashbackTxType = 'earn' | 'redeem' | 'reverse' | 'adjust' | 'expire';

export interface CashbackTransaction {
  id: string;
  customer_id: string;
  order_id: string | null;
  type: CashbackTxType;
  amount: number;
  balance_after: number;
  description: string | null;
  coupon_code: string | null;
  created_at: string;
}

export type CouponType = 'abandoned_cart' | 'cashback_redeem' | 'upsell' | 'manual';
export type CouponStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface DynamicCoupon {
  id: string;
  code: string;
  shopify_price_rule_id: number | null;
  shopify_discount_id: number | null;
  type: CouponType;
  customer_id: string | null;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  max_uses: number;
  used_count: number;
  status: CouponStatus;
  expires_at: string | null;
  used_at: string | null;
  created_at: string;
}

export interface UpsellOffer {
  id: string;
  name: string;
  trigger_product_ids: number[];
  offer_product_id: number | null;
  offer_product_title: string;
  offer_product_url: string;
  discount_pct: number;
  priority: number;
  active: boolean;
}

export type UpsellStatus = 'pending' | 'sent' | 'skipped' | 'failed';

export interface UpsellQueueItem {
  id: string;
  order_id: string;
  customer_id: string | null;
  phone: string | null;
  email: string | null;
  line_items: LineItem[];
  scheduled_for: string;
  status: UpsellStatus;
  attempts: number;
  error_message: string | null;
  claimed_at: string | null;
  created_at: string;
  sent_at: string | null;
}
