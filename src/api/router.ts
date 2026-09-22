import { Router } from 'express';
import type { Request } from 'express';
import { env } from '../config/env';
import { loadCustomer, rateLimit, requireClubSession } from './middleware';
import { requestLoginCode, verifyLoginCode } from './auth';
import { getCustomerProfile, updatePreferences } from './customer-profile';
import { getCashbackHistory } from './cashback-history';
import { redeemCashback } from './redeem-cashback';
import { getActiveCoupons } from './active-coupon';

export const apiRouter = Router();

const emailKey = (req: Request): string | null => {
  const e = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  return e || null;
};

/**
 * Login. These two are the only unauthenticated routes.
 *
 * Both are limited twice — by IP and by email address. IP alone lets one
 * attacker mail-bomb a victim from a rotating address; email alone lets one
 * host enumerate the whole customer list a code at a time.
 */
apiRouter.post(
  '/auth/request-code',
  rateLimit({ name: 'otp-req-ip', limit: env.OTP_REQUEST_LIMIT_PER_HOUR * 4, windowSeconds: 3600, byIp: true }),
  rateLimit({ name: 'otp-req-email', limit: env.OTP_REQUEST_LIMIT_PER_HOUR, windowSeconds: 3600, keyFrom: emailKey }),
  requestLoginCode,
);

apiRouter.post(
  '/auth/verify-code',
  rateLimit({ name: 'otp-vfy-ip', limit: env.OTP_VERIFY_LIMIT_PER_HOUR * 4, windowSeconds: 3600, byIp: true }),
  rateLimit({ name: 'otp-vfy-email', limit: env.OTP_VERIFY_LIMIT_PER_HOUR, windowSeconds: 3600, keyFrom: emailKey }),
  verifyLoginCode,
);

// Everything below runs on the session token verify-code hands back.
apiRouter.use(requireClubSession, loadCustomer);

apiRouter.get('/customer/profile', getCustomerProfile);
apiRouter.patch('/customer/preferences', updatePreferences);
apiRouter.get('/customer/cashback-history', getCashbackHistory);
apiRouter.get('/customer/active-coupon', getActiveCoupons);

apiRouter.post(
  '/customer/redeem-cashback',
  rateLimit({ name: 'redeem', limit: env.REDEEM_RATE_LIMIT_PER_HOUR, windowSeconds: 3600 }),
  redeemCashback,
);
