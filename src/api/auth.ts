import type { Request, Response } from 'express';
import { db } from '../db/client';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { consumeLoginCode, issueLoginCode } from '../services/otp';
import { sendEmail } from '../services/email';
import { buildLoginCodeEmail, buildLoginCodeSubject } from '../templates/email/login-code';
import { issueClubSession } from './middleware';
import { clubProfile } from './serialize';
import type { Customer } from '../db/schema';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/request-code  { email }
 *
 * Always answers 200 with the same body, whether or not the address belongs
 * to a customer. Anything else turns this into an oracle for "does this
 * person shop here" — which is exactly the disclosure OTP is meant to stop.
 */
export async function requestLoginCode(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';

  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    return;
  }

  // Uniform response, computed before any branching so the timing of a hit
  // and a miss stay close.
  const ok = {
    ok: true,
    message: 'אם הכתובת קיימת אצלנו, שלחנו אליה קוד כניסה',
    expires_in_minutes: env.OTP_TTL_MINUTES,
  };

  try {
    const { data, error } = await db
      .from('customers').select('*').eq('email', email).maybeSingle();

    if (error) throw new Error(error.message);

    const customer = data as Customer | null;
    if (!customer) {
      logger.info('Login code requested for unknown email');
      res.json(ok);
      return;
    }

    const issued = await issueLoginCode(customer.id, email);
    if (!issued) {
      res.status(500).json({ error: 'שגיאה בשליחת הקוד' });
      return;
    }

    const sent = await sendEmail({
      to: email,
      subject: buildLoginCodeSubject(),
      html: buildLoginCodeEmail({
        firstName: customer.first_name,
        code: issued.code,
        ttlMinutes: env.OTP_TTL_MINUTES,
      }),
      customerId: customer.id,
      type: 'login_code',
    });

    // A mail provider outage must not look like a wrong address — the
    // customer would retype a correct email forever.
    if (sent.status !== 'sent') {
      logger.error('Login code could not be delivered', undefined, { customerId: customer.id });
      res.status(502).json({ error: 'לא הצלחנו לשלוח את הקוד כרגע. נסה שוב בעוד רגע.' });
      return;
    }

    logger.info('Login code sent', { customerId: customer.id });
    res.json(ok);
  } catch (err) {
    logger.error('requestLoginCode failed', err);
    res.status(500).json({ error: 'שגיאה בשליחת הקוד' });
  }
}

/**
 * POST /api/auth/verify-code  { email, code }
 *
 * On success returns the same session token /identify used to hand out, so
 * every downstream route is unchanged.
 */
export async function verifyLoginCode(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\D/g, '') : '';

  if (!email || !EMAIL_RE.test(email) || code.length !== 6) {
    res.status(400).json({ error: 'קוד לא תקין' });
    return;
  }

  try {
    const customerId = await consumeLoginCode(email, code);

    if (!customerId) {
      // One message for every failure — wrong, expired, used, or out of
      // attempts. Distinguishing them tells an attacker which codes existed.
      res.status(401).json({ error: 'הקוד שגוי או פג תוקף', code: 'INVALID_CODE' });
      return;
    }

    const { data, error } = await db
      .from('customers').select('*').eq('id', customerId).maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ error: 'לקוח לא נמצא', code: 'NOT_FOUND' });
      return;
    }

    const customer = data as Customer;
    const session = issueClubSession(customer.id);

    logger.info('Club login succeeded', { customerId: customer.id });

    res.json({
      session_token: session.token,
      expires_in: session.expiresIn,
      customer: clubProfile(customer),
    });
  } catch (err) {
    logger.error('verifyLoginCode failed', err);
    res.status(500).json({ error: 'שגיאה באימות הקוד' });
  }
}
