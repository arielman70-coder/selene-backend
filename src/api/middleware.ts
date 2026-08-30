import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { Customer } from '../db/schema';

export interface ClubRequest extends Request {
  customerId?: string;
  customer?: Customer;
}

const ISSUER = 'selene-club';

interface ClubTokenPayload {
  sub: string;   // customers.id
  iss: string;
}

/**
 * Customers don't have accounts — identity comes from Shopify webhooks, and
 * the club page is a balance lookup by email. So /api/identify hands back a
 * short-lived token naming the customer it resolved, and the read endpoints
 * take that instead of re-accepting an email on every call.
 *
 * The token carries the customer id so no endpoint ever has to trust one from
 * the request body.
 */
export function issueClubSession(customerId: string): { token: string; expiresIn: number } {
  const expiresIn = env.CLUB_SESSION_MINUTES * 60;
  const token = jwt.sign({ sub: customerId, iss: ISSUER }, env.API_TOKEN_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  });
  return { token, expiresIn };
}

export function requireClubSession(req: Request, res: Response, next: NextFunction): void {
  const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    res.status(401).json({ error: 'נדרש זיהוי', code: 'NO_SESSION' });
    return;
  }

  let payload: ClubTokenPayload;
  try {
    payload = jwt.verify(token, env.API_TOKEN_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    }) as ClubTokenPayload;
  } catch {
    res.status(401).json({ error: 'הזיהוי פג תוקף, נסה שוב', code: 'SESSION_EXPIRED' });
    return;
  }

  (req as ClubRequest).customerId = payload.sub;
  next();
}

export async function loadCustomer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const club = req as ClubRequest;

  const { data, error } = await db
    .from('customers').select('*').eq('id', club.customerId!).maybeSingle();

  if (error) {
    logger.error('Customer lookup failed', error, { customerId: club.customerId });
    res.status(500).json({ error: 'שגיאה בטעינת הפרופיל' });
    return;
  }

  if (!data) {
    res.status(404).json({ error: 'לקוח לא נמצא', code: 'NOT_FOUND' });
    return;
  }

  club.customer = data as Customer;
  next();
}

/**
 * DB-backed fixed-window limiter. In-memory counters reset on every deploy and
 * don't hold across more than one instance.
 *
 * `byIp` keys the bucket on the caller rather than the customer — the lookup
 * endpoint has no session yet, and per-email limiting there would be useless
 * anyway since an enumerator just moves to the next address.
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
  byIp?: boolean;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const club = req as ClubRequest;
    const subject = opts.byIp
      ? (req.ip ?? 'unknown')
      : (club.customer?.id ?? club.customerId ?? req.ip ?? 'unknown');

    const { data, error } = await db.rpc('check_rate_limit', {
      p_key: `${opts.name}:${subject}`,
      p_limit: opts.limit,
      p_window_seconds: opts.windowSeconds,
    });

    if (error) {
      // Fail open on infrastructure trouble — a Supabase blip shouldn't lock
      // every customer out of their own balance.
      logger.error('Rate limit check failed; allowing request', error, { name: opts.name });
      next();
      return;
    }

    if (data !== true) {
      logger.warn('Rate limit exceeded', { name: opts.name, subject, limit: opts.limit });
      res.status(429).json({
        error: 'יותר מדי בקשות. נסה שוב בעוד כמה דקות.',
        retry_after_seconds: opts.windowSeconds,
      });
      return;
    }

    next();
  };
}
