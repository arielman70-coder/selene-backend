import { env } from '../config/env';
import { logger } from '../utils/logger';

const BASE = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;

const HEADERS: Record<string, string> = {
  'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shopify's REST admin API is leaky-bucket rate limited (2 calls/sec on
 * standard plans). The abandoned-cart job mints a coupon per cart in a loop,
 * so a batch of 50 will hit 429 without this — and a swallowed 429 means a
 * customer gets a reminder naming a discount code that was never created.
 */
async function shopifyFetch<T>(
  path: string,
  init: RequestInit = {},
  attempt = 1,
): Promise<T> {
  const maxAttempts = 4;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= maxAttempts) {
      const body = await res.text();
      throw new ShopifyError(`Shopify ${res.status} after ${attempt} attempts`, res.status, body);
    }
    const retryAfter = Number(res.headers.get('Retry-After'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2 ** attempt * 250;

    logger.warn('Shopify throttled, backing off', { path, status: res.status, backoff, attempt });
    await sleep(backoff);
    return shopifyFetch<T>(path, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ShopifyError(`Shopify ${res.status} on ${path}`, res.status, body.slice(0, 500));
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Price rules & discount codes
// ---------------------------------------------------------------------------

export interface PriceRuleInput {
  title: string;
  valueType: 'percentage' | 'fixed_amount';
  /** Positive magnitude; the sign Shopify wants is applied here. */
  value: number;
  startsAt: string;
  endsAt: string;
  usageLimit?: number;
  /** Restricting to one Shopify customer is what stops a code being shared. */
  shopifyCustomerId?: number | null;
  /** fixed_amount rules need a currency when the shop is multi-currency. */
  currency?: string;
}

export async function createPriceRule(input: PriceRuleInput): Promise<number> {
  const body: Record<string, unknown> = {
    title: input.title,
    target_type: 'line_item',
    target_selection: 'all',
    allocation_method: 'across',
    value_type: input.valueType,
    value: `-${Math.abs(input.value).toFixed(2)}`,
    once_per_customer: true,
    usage_limit: input.usageLimit ?? 1,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  };

  if (input.shopifyCustomerId) {
    body.customer_selection = 'prerequisite';
    body.prerequisite_customer_ids = [input.shopifyCustomerId];
  } else {
    body.customer_selection = 'all';
  }

  const json = await shopifyFetch<{ price_rule: { id: number } }>('/price_rules.json', {
    method: 'POST',
    body: JSON.stringify({ price_rule: body }),
  });

  return json.price_rule.id;
}

export async function createDiscountCode(
  priceRuleId: number,
  code: string,
): Promise<number> {
  const json = await shopifyFetch<{ discount_code: { id: number } }>(
    `/price_rules/${priceRuleId}/discount_codes.json`,
    { method: 'POST', body: JSON.stringify({ discount_code: { code } }) },
  );
  return json.discount_code.id;
}

/**
 * Used to roll back a half-created coupon. Deleting the price rule cascades
 * to its discount codes, so this is the only cleanup call needed.
 */
export async function deletePriceRule(priceRuleId: number): Promise<void> {
  await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface ShopifyWebhook {
  id: number;
  topic: string;
  address: string;
}

export async function listWebhooks(): Promise<ShopifyWebhook[]> {
  const json = await shopifyFetch<{ webhooks: ShopifyWebhook[] }>('/webhooks.json?limit=250');
  return json.webhooks ?? [];
}

export async function createWebhook(topic: string, address: string): Promise<ShopifyWebhook> {
  const json = await shopifyFetch<{ webhook: ShopifyWebhook }>('/webhooks.json', {
    method: 'POST',
    body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
  });
  return json.webhook;
}

export async function deleteWebhook(id: number): Promise<void> {
  await shopifyFetch(`/webhooks/${id}.json`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function findShopifyCustomerByEmail(email: string): Promise<number | null> {
  const json = await shopifyFetch<{ customers: Array<{ id: number }> }>(
    `/customers/search.json?query=${encodeURIComponent(`email:${email}`)}&limit=1`,
  );
  return json.customers?.[0]?.id ?? null;
}
