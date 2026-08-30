import { env, shopifyClientCredentials } from '../config/env';
import { logger } from '../utils/logger';

const BASE = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;
const TOKEN_URL = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

/**
 * Access token, obtained one of two ways:
 *
 *   - SHOPIFY_ADMIN_ACCESS_TOKEN, used as-is
 *   - SHOPIFY_CLIENT_ID/SECRET, exchanged via the client_credentials grant
 *
 * The exchanged token is cached in memory. Shopify returns `expires_in` for
 * tokens that expire; when it does, we refresh a minute early rather than
 * waiting to be surprised mid-request. When it doesn't, the token is treated
 * as long-lived and only refreshed if a call comes back 401.
 *
 * Cached per process, so a restart just re-fetches. There is no persistence
 * here on purpose — a token in the database is one more secret to protect.
 */
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inFlight: Promise<string> | null = null;

async function exchangeClientCredentials(): Promise<string> {
  const creds = shopifyClientCredentials!;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ShopifyError(
      `Shopify token exchange failed (${res.status})`,
      res.status,
      text.slice(0, 300),
    );
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new ShopifyError('Shopify token exchange returned non-JSON', res.status, text.slice(0, 300));
  }

  if (!parsed.access_token) {
    throw new ShopifyError('Shopify token exchange returned no access_token', res.status, text.slice(0, 300));
  }

  // 60s of slack so a token can't expire between the check and the request.
  tokenExpiresAt = parsed.expires_in
    ? Date.now() + Math.max(0, parsed.expires_in - 60) * 1000
    : Number.POSITIVE_INFINITY;

  cachedToken = parsed.access_token;

  logger.info('Shopify access token obtained', {
    expiresIn: parsed.expires_in ?? 'not specified',
  });

  return cachedToken;
}

async function getAccessToken(): Promise<string> {
  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) return env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  // Single-flight: the abandoned-cart job fires many calls at once, and
  // without this a cold cache would trigger one exchange per call.
  if (!inFlight) {
    inFlight = exchangeClientCredentials().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Drops the cached token so the next call re-exchanges. */
function invalidateToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

async function buildHeaders(): Promise<Record<string, string>> {
  return {
    'X-Shopify-Access-Token': await getAccessToken(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

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
  didRefresh = false,
): Promise<T> {
  const maxAttempts = 4;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(await buildHeaders()), ...(init.headers as Record<string, string> | undefined) },
  });

  // An exchanged token can be revoked or expire without an expires_in hint.
  // Refresh once and retry before treating it as a real failure.
  if (res.status === 401 && shopifyClientCredentials && !env.SHOPIFY_ADMIN_ACCESS_TOKEN && !didRefresh) {
    logger.warn('Shopify returned 401; refreshing access token', { path });
    invalidateToken();
    return shopifyFetch<T>(path, init, attempt, true);
  }

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
    return shopifyFetch<T>(path, init, attempt + 1, didRefresh);
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
