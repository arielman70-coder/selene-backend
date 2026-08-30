import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/** Set by the express.json({ verify }) hook in index.ts. */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Verifies Shopify's HMAC over the exact bytes received.
 *
 * Two things the obvious implementation gets wrong:
 *
 *  1. timingSafeEqual THROWS when the buffers differ in length. An attacker
 *     sending `X-Shopify-Hmac-Sha256: x` would trigger a 500 (and an unhandled
 *     rejection) instead of a clean 401. Length is compared first.
 *
 *  2. The digest must be computed over the raw bytes, not JSON.stringify of
 *     the parsed body — key order and unicode escaping won't round-trip, and
 *     every webhook would fail verification.
 */
export function verifyShopifyWebhook(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('x-shopify-hmac-sha256');
  if (!header) {
    res.status(401).json({ error: 'Missing HMAC header' });
    return;
  }

  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody || rawBody.length === 0) {
    res.status(400).json({ error: 'No raw body available for verification' });
    return;
  }

  const digest = crypto
    .createHmac('sha256', env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(header, 'base64');
  } catch {
    res.status(401).json({ error: 'Invalid HMAC encoding' });
    return;
  }

  if (provided.length !== digest.length || !crypto.timingSafeEqual(digest, provided)) {
    logger.warn('Rejected webhook with invalid HMAC', {
      topic: req.header('x-shopify-topic'),
      shopDomain: req.header('x-shopify-shop-domain'),
      ip: req.ip,
    });
    res.status(401).json({ error: 'Invalid HMAC signature' });
    return;
  }

  // Reject deliveries signed correctly but sent for a different shop.
  const shopDomain = req.header('x-shopify-shop-domain');
  if (shopDomain && shopDomain !== env.SHOPIFY_STORE_DOMAIN) {
    logger.warn('Rejected webhook from unexpected shop', { shopDomain });
    res.status(401).json({ error: 'Unexpected shop domain' });
    return;
  }

  next();
}

/**
 * Guards the /jobs/* endpoints that pg_cron calls. Constant-time compare so
 * the secret can't be recovered a byte at a time.
 */
export function verifyCronSecret(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const provided = header.replace(/^Bearer\s+/i, '');

  const a = Buffer.from(provided);
  const b = Buffer.from(env.CRON_SECRET);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn('Rejected job call with bad cron secret', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
