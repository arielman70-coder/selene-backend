import { env, twilioConfigured } from '../config/env';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { isWhatsAppCapable, maskPhone, toGreenApiChatId } from '../utils/phone';

type Provider = 'green_api' | 'twilio';

/** https://green-api.com/en/docs/api/sending/SendMessage/ */
async function sendViaGreenAPI(phone: string, message: string): Promise<string> {
  const url =
    `https://api.green-api.com/waInstance${env.GREEN_API_INSTANCE_ID}` +
    `/sendMessage/${env.GREEN_API_TOKEN}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: toGreenApiChatId(phone), message }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Green API ${res.status}: ${text.slice(0, 200)}`);

    const data = JSON.parse(text) as { idMessage?: string };
    if (!data.idMessage) throw new Error(`Green API returned no idMessage: ${text.slice(0, 200)}`);
    return data.idMessage;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Twilio fallback. Loaded lazily so the dependency stays optional — a deploy
 * without Twilio credentials shouldn't pay the import cost or crash on it.
 */
async function sendViaTwilio(phone: string, message: string): Promise<string> {
  const { default: twilio } = await import('twilio');
  const client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);

  const result = await client.messages.create({
    from: env.TWILIO_WHATSAPP_FROM!,
    to: `whatsapp:${phone}`,
    body: message,
  });

  return result.sid;
}

export interface SendWhatsAppParams {
  phone: string | null;
  message: string;
  customerId?: string | null;
  type: string;
}

export interface SendResult {
  status: 'sent' | 'failed' | 'skipped';
  provider?: Provider;
  externalMsgId?: string;
  error?: string;
}

/**
 * Never throws — a failed reminder must not abort the batch behind it. The
 * outcome is always written to notification_log, including skips, because the
 * abandoned-cart dedup check reads that table.
 */
export async function sendWhatsApp(params: SendWhatsAppParams): Promise<SendResult> {
  const { phone, message, customerId, type } = params;

  if (!phone || !isWhatsAppCapable(phone)) {
    const result: SendResult = { status: 'skipped', error: 'no WhatsApp-capable number' };
    await log(result, params);
    return result;
  }

  let provider: Provider = 'green_api';
  let externalMsgId = '';
  let error = '';

  try {
    externalMsgId = await sendViaGreenAPI(phone, message);
  } catch (greenErr) {
    logger.warn('Green API send failed', {
      phone: maskPhone(phone),
      type,
      error: greenErr instanceof Error ? greenErr.message : String(greenErr),
    });

    if (twilioConfigured) {
      try {
        provider = 'twilio';
        externalMsgId = await sendViaTwilio(phone, message);
      } catch (twilioErr) {
        error = twilioErr instanceof Error ? twilioErr.message : String(twilioErr);
      }
    } else {
      error = greenErr instanceof Error ? greenErr.message : String(greenErr);
    }
  }

  const result: SendResult = error
    ? { status: 'failed', provider, error }
    : { status: 'sent', provider, externalMsgId };

  if (error) {
    logger.error('WhatsApp send failed on all providers', undefined, {
      phone: maskPhone(phone), type, error,
    });
  } else {
    logger.info('WhatsApp sent', { phone: maskPhone(phone), type, provider });
  }

  await log(result, params);
  return result;
}

async function log(result: SendResult, params: SendWhatsAppParams): Promise<void> {
  const { error } = await db.from('notification_log').insert({
    customer_id: params.customerId ?? null,
    channel: 'whatsapp',
    provider: result.provider ?? null,
    type: params.type,
    recipient: params.phone ?? 'unknown',
    status: result.status,
    external_msg_id: result.externalMsgId || null,
    error_message: result.error?.slice(0, 1000) || null,
  });

  if (error) logger.error('Failed to write notification_log', error, { type: params.type });
}
