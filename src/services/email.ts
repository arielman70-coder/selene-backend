import { Resend } from 'resend';
import { env, sesConfigured } from '../config/env';
import { db } from '../db/client';
import { logger } from '../utils/logger';

type Provider = 'resend' | 'ses';

const resend = new Resend(env.RESEND_API_KEY);
const FROM = `${env.FROM_NAME} <${env.FROM_EMAIL}>`;

async function sendViaResend(to: string, subject: string, html: string): Promise<string> {
  const { data, error } = await resend.emails.send({ from: FROM, to: [to], subject, html });
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error('Resend returned no message id');
  return data.id;
}

/** Lazily loaded so the AWS SDK stays optional at runtime. */
async function sendViaSES(to: string, subject: string, html: string): Promise<string> {
  const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');

  const client = new SESClient({
    region: env.SES_REGION!,
    credentials: {
      accessKeyId: env.SES_ACCESS_KEY_ID!,
      secretAccessKey: env.SES_SECRET_ACCESS_KEY!,
    },
  });

  const result = await client.send(
    new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' } },
      },
    }),
  );

  return result.MessageId ?? '';
}

export interface SendEmailParams {
  to: string | null;
  subject: string;
  html: string;
  customerId?: string | null;
  type: string;
}

export interface EmailResult {
  status: 'sent' | 'failed' | 'skipped';
  provider?: Provider;
  externalMsgId?: string;
  error?: string;
}

/** Never throws, for the same reason sendWhatsApp doesn't. */
export async function sendEmail(params: SendEmailParams): Promise<EmailResult> {
  const { to, subject, html, type } = params;

  if (!to) {
    const result: EmailResult = { status: 'skipped', error: 'no recipient' };
    await log(result, params);
    return result;
  }

  let provider: Provider = 'resend';
  let externalMsgId = '';
  let error = '';

  try {
    externalMsgId = await sendViaResend(to, subject, html);
  } catch (resendErr) {
    logger.warn('Resend send failed', {
      type, error: resendErr instanceof Error ? resendErr.message : String(resendErr),
    });

    if (sesConfigured) {
      try {
        provider = 'ses';
        externalMsgId = await sendViaSES(to, subject, html);
      } catch (sesErr) {
        error = sesErr instanceof Error ? sesErr.message : String(sesErr);
      }
    } else {
      error = resendErr instanceof Error ? resendErr.message : String(resendErr);
    }
  }

  const result: EmailResult = error
    ? { status: 'failed', provider, error }
    : { status: 'sent', provider, externalMsgId };

  if (error) {
    logger.error('Email send failed on all providers', undefined, { type, error });
  } else {
    logger.info('Email sent', { type, provider });
  }

  await log(result, params);
  return result;
}

async function log(result: EmailResult, params: SendEmailParams): Promise<void> {
  const { error } = await db.from('notification_log').insert({
    customer_id: params.customerId ?? null,
    channel: 'email',
    provider: result.provider ?? null,
    type: params.type,
    recipient: params.to ?? 'unknown',
    status: result.status,
    external_msg_id: result.externalMsgId || null,
    error_message: result.error?.slice(0, 1000) || null,
  });

  if (error) logger.error('Failed to write notification_log', error, { type: params.type });
}
