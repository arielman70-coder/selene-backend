import { Router } from 'express';
import { env } from '../config/env';
import { loadCustomer, rateLimit, requireClubSession } from './middleware';
import { identify } from './identify';
import { getCustomerProfile, updatePreferences } from './customer-profile';
import { getCashbackHistory } from './cashback-history';
import { redeemCashback } from './redeem-cashback';
import { getActiveCoupons } from './active-coupon';

export const apiRouter = Router();

/**
 * The club page's entry point, and the only unauthenticated route here.
 * IP-limited, because it's the one endpoint that will answer questions about
 * an email address nobody has proven they own.
 */
apiRouter.post(
  '/identify',
  rateLimit({
    name: 'lookup',
    limit: env.LOOKUP_RATE_LIMIT_PER_HOUR,
    windowSeconds: 3600,
    byIp: true,
  }),
  identify,
);

// Everything below runs on the session token /identify handed back.
apiRouter.use(requireClubSession, loadCustomer);

apiRouter.get('/customer/profile', getCustomerProfile);
apiRouter.patch('/customer/preferences', updatePreferences);
apiRouter.get('/customer/cashback-history', getCashbackHistory);
apiRouter.get('/customer/active-coupon', getActiveCoupons);

apiRouter.post(
  '/customer/redeem-cashback',
  rateLimit({
    name: 'redeem',
    limit: env.REDEEM_RATE_LIMIT_PER_HOUR,
    windowSeconds: 3600,
  }),
  redeemCashback,
);
