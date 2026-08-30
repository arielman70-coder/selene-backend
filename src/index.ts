import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { corsOrigins, env, isProduction } from './config/env';
import { logger } from './utils/logger';
import { webhookRouter } from './webhooks/router';
import { apiRouter } from './api/router';
import { jobRouter } from './jobs/router';
import type { RawBodyRequest } from './webhooks/middleware';

const app = express();

// Behind Railway/Render/Fly, req.ip is the proxy without this — which would
// make the IP-keyed rate limit bucket every customer together.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * Raw body capture for Shopify HMAC.
 *
 * Done via express.json's `verify` hook rather than a hand-rolled 'data'
 * listener: consuming the stream manually leaves express.json() with nothing
 * to read, so req.body would be permanently empty and every handler would
 * 400. The verify hook hands us the buffer while the parser still gets it.
 *
 * The 2MB cap is above the largest realistic order payload and stops an
 * unauthenticated POST from parking arbitrary memory.
 */
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  }),
);

// Minimal CORS. Only the storefront and Lovable preview need it; webhooks and
// cron are server-to-server and never preflight.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header('origin');
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(origin && corsOrigins.includes(origin) ? 204 : 403);
    return;
  }
  next();
});

app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug('request', { method: req.method, path: req.path });
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, env: env.NODE_ENV, ts: new Date().toISOString() });
});

app.use('/webhooks', webhookRouter);
app.use('/api', apiRouter);
app.use('/jobs', jobRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Four-arg signature is required for Express to treat this as an error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled request error', err);
  res.status(500).json({
    error: 'Internal server error',
    ...(isProduction ? {} : { detail: err.message }),
  });
});

const server = app.listen(env.PORT, () => {
  logger.info('selene-backend listening', { port: env.PORT, env: env.NODE_ENV });
});

/**
 * Webhook handlers ack Shopify and then keep working, so an abrupt exit drops
 * in-flight cashback writes. Stop accepting connections, let what's running
 * finish, then exit.
 */
function shutdown(signal: string): void {
  logger.info('Shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

export { app };
