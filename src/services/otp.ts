import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Six digits, uniformly distributed via randomInt (not Math.random — this is
 * a credential). Leading zeros are preserved by padding, so 000042 is a valid
 * code and the space really is 1,000,000 wide.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * SHA-256 with API_TOKEN_SECRET as pepper.
 *
 * Plain SHA-256 of six digits is trivially reversible — a rainbow table of
 * all million is seconds of work. The pepper lives only in the environment,
 * so a leaked database dump alone can't turn these hashes back into codes.
 *
 * Not bcrypt: codes die in 10 minutes and survive 5 guesses, so the slow-hash
 * property buys nothing, and the verify path runs inside a DB transaction
 * where a 100ms KDF would hold a row lock.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(`${code}:${env.API_TOKEN_SECRET}`).digest('hex');
}

/** Constant-time compare, for any hash comparison done outside Postgres. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface IssuedCode {
  code: string;
  expiresAt: Date;
}

/**
 * Invalidates any outstanding codes and issues a fresh one. Returning the
 * plaintext is deliberate and single-purpose: the caller emails it and drops
 * it. It is never logged, stored, or returned over HTTP.
 */
export async function issueLoginCode(
  customerId: string,
  email: string,
): Promise<IssuedCode | null> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  const { error: invalidateError } = await db.rpc('invalidate_login_codes', {
    p_email: email,
  });
  if (invalidateError) {
    logger.error('Failed to invalidate previous login codes', invalidateError);
    return null;
  }

  const { error } = await db.from('login_codes').insert({
    customer_id: customerId,
    email,
    code_hash: hashCode(code),
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    logger.error('Failed to store login code', error, { customerId });
    return null;
  }

  return { code, expiresAt };
}

/**
 * Verifies and burns a code atomically. Returns the customer id, or null for
 * every failure mode — wrong code, expired, already used, too many attempts.
 * The caller must not distinguish between them to the client.
 */
export async function consumeLoginCode(
  email: string,
  code: string,
): Promise<string | null> {
  const { data, error } = await db.rpc('consume_login_code', {
    p_email: email,
    p_hash: hashCode(code),
    p_max_attempts: env.OTP_MAX_ATTEMPTS,
  });

  if (error) {
    logger.error('consume_login_code failed', error);
    return null;
  }

  return (data as string | null) ?? null;
}
