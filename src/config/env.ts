import 'dotenv/config';
import { z } from 'zod';

/**
 * Validated at import time. A missing var kills the process at boot rather
 * than surfacing as a 3am "why did no reminders go out" — which is the whole
 * point of doing this here instead of reading process.env at each call site.
 */
const envSchema = z.object({
  // ---------- Supabase ----------
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  SUPABASE_ANON_KEY: z.string().min(10).optional(),
  API_TOKEN_SECRET: z.string().min(16, 'signs club session tokens — use at least 16 chars'),

  // ---------- Shopify ----------
  SHOPIFY_STORE_DOMAIN: z.string().regex(
    /^[a-z0-9-]+\.myshopify\.com$/,
    'must be the *.myshopify.com admin domain, not the storefront domain',
  ),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(8),
  SHOPIFY_API_VERSION: z.string().default('2024-10'),
  SHOPIFY_STOREFRONT_URL: z.string().url(),

  // ---------- WhatsApp ----------
  GREEN_API_INSTANCE_ID: z.string().min(1),
  GREEN_API_TOKEN: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  // ---------- Email ----------
  RESEND_API_KEY: z.string().startsWith('re_'),
  SES_ACCESS_KEY_ID: z.string().optional(),
  SES_SECRET_ACCESS_KEY: z.string().optional(),
  SES_REGION: z.string().optional(),

  FROM_EMAIL: z.string().email(),
  FROM_NAME: z.string().min(1),
  FROM_WHATSAPP_NAME: z.string().min(1).optional(),

  // ---------- Business rules ----------
  ABANDONED_CART_DELAY_MINUTES: z.coerce.number().int().positive().default(30),
  ABANDONED_CART_MAX_REMINDERS: z.coerce.number().int().min(0).default(2),
  ABANDONED_CART_DEDUP_HOURS: z.coerce.number().int().positive().default(6),
  ABANDONED_CART_COUPON_PCT: z.coerce.number().min(1).max(90).default(10),
  ABANDONED_CART_COUPON_HOURS: z.coerce.number().int().positive().default(24),
  ABANDONED_CART_REMINDER_GAP_HOURS: z.coerce.number().int().positive().default(24),

  CASHBACK_COUPON_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CASHBACK_MIN_REDEEM: z.coerce.number().positive().default(10),
  REDEEM_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(3),
  // Balance lookup is unauthenticated, so this is the only thing standing
  // between a scraper and the whole customer list. Keep it tight.
  LOOKUP_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  CLUB_SESSION_MINUTES: z.coerce.number().int().positive().default(30),

  UPSELL_DELAY_MINUTES: z.coerce.number().int().min(0).default(2),
  UPSELL_OFFER_TTL_HOURS: z.coerce.number().int().positive().default(48),
  UPSELL_COUPON_PCT: z.coerce.number().min(1).max(90).default(15),

  // ---------- Runtime ----------
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CRON_SECRET: z.string().min(16, 'use at least 16 chars — this guards every job endpoint'),
  CORS_ORIGINS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Twilio is optional; whatsapp.ts only reaches for it when fully configured. */
export const twilioConfigured = Boolean(
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM,
);

/** Same for SES. */
export const sesConfigured = Boolean(
  env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY && env.SES_REGION,
);
