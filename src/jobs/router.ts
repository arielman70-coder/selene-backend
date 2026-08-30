import { Router } from 'express';
import { verifyCronSecret } from '../webhooks/middleware';
import { processAbandonedCarts } from './abandoned-cart';
import { processUpsellQueue } from './upsell-sender';
import { expireCoupons } from './expire-coupons';
import { logger } from '../utils/logger';

/**
 * Endpoints pg_cron calls over HTTP (see 003_cron.sql). Every route is behind
 * the shared secret — these mutate state and send messages, so an open URL is
 * a way for anyone to spam customers.
 */
export const jobRouter = Router();

jobRouter.use(verifyCronSecret);

function run(name: string, fn: () => Promise<unknown>) {
  return async (_req: unknown, res: import('express').Response): Promise<void> => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      res.json({ ok: true, job: name, durationMs: Date.now() - startedAt, result });
    } catch (err) {
      logger.error(`Job ${name} threw`, err);
      res.status(500).json({ ok: false, job: name, error: 'job failed' });
    }
  };
}

jobRouter.post('/abandoned-carts', run('abandoned-carts', processAbandonedCarts));
jobRouter.post('/upsell-queue', run('upsell-queue', processUpsellQueue));
jobRouter.post('/expire-coupons', run('expire-coupons', expireCoupons));
