import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.LOG_LEVEL];

/**
 * Keys whose values never reach the log, at any depth. Webhook payloads and
 * provider errors routinely carry tokens; one careless log line puts a
 * service-role key in a hosting provider's log retention forever.
 */
const REDACT = new Set([
  'password', 'token', 'access_token', 'refresh_token', 'authorization',
  'apikey', 'api_key', 'secret', 'service_role_key', 'jwt', 'hmac',
  'x-shopify-hmac-sha256', 'credit_card', 'card', 'cvv',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  });

  // eslint-disable-next-line no-console
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

/** Errors don't survive JSON.stringify — pull the useful parts out by hand. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, err?: unknown, context?: Record<string, unknown>) =>
    emit('error', message, { ...(context ?? {}), ...(err ? { error: serializeError(err) } : {}) }),
};
