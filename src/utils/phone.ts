/**
 * E.164 normalization, Israel-first.
 *
 * Phone is a natural key here (customers.phone is UNIQUE, and Green API
 * addresses chats by number), so "+972 50-123-4567", "0501234567" and
 * "972501234567" must all collapse to one string or the same person becomes
 * two customer rows with split cashback balances.
 */

/** Israeli mobile prefixes, without the leading 0. */
const IL_MOBILE_PREFIXES = ['50', '51', '52', '53', '54', '55', '56', '57', '58', '59'];

export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;

  // Strip everything but digits, keeping a leading + if present.
  const hasPlus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // 00 is the international prefix in Israel — treat it as a +.
  let normalized = digits;
  if (!hasPlus && normalized.startsWith('00')) normalized = normalized.slice(2);

  // 972XXXXXXXXX (with or without a +)
  if (normalized.startsWith('972')) {
    const local = normalized.slice(3);
    // Tolerate the redundant trunk zero people type: +972 05x...
    const trimmed = local.startsWith('0') ? local.slice(1) : local;
    if (trimmed.length === 9) return `+972${trimmed}`;
    return null;
  }

  // Local Israeli mobile: 0 5X XXXXXXX
  if (normalized.startsWith('0') && normalized.length === 10) {
    const prefix = normalized.slice(1, 3);
    if (IL_MOBILE_PREFIXES.includes(prefix)) return `+972${normalized.slice(1)}`;
    // Landline (02/03/04/08/09) — still valid E.164, just not WhatsApp-able.
    return `+972${normalized.slice(1)}`;
  }

  // Local Israeli landline: 0 X XXXXXXX (9 digits)
  if (normalized.startsWith('0') && normalized.length === 9) {
    return `+972${normalized.slice(1)}`;
  }

  // Explicitly international and plausible — pass it through.
  if (hasPlus && normalized.length >= 8 && normalized.length <= 15) {
    return `+${normalized}`;
  }

  return null;
}

/**
 * Only mobile numbers can receive WhatsApp. Sending to a landline burns an
 * API call and logs a misleading "sent".
 */
export function isWhatsAppCapable(e164: string | null): boolean {
  if (!e164) return false;
  if (e164.startsWith('+972')) {
    const prefix = e164.slice(4, 6);
    return IL_MOBILE_PREFIXES.includes(prefix);
  }
  // Non-Israeli: we can't tell, so let the provider decide.
  return true;
}

/** Green API addresses chats as `<digits>@c.us` — no plus. */
export function toGreenApiChatId(e164: string): string {
  return `${e164.replace(/^\+/, '')}@c.us`;
}

/** Log-safe rendering: keep the country code and last 3 digits. */
export function maskPhone(e164: string | null): string {
  if (!e164) return '';
  if (e164.length <= 7) return '***';
  return `${e164.slice(0, 4)}***${e164.slice(-3)}`;
}

/** Log/response-safe email: `ar***@gmail.com`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
