import { button, couponBox, escapeHtml, wrapEmail } from './layout';
import type { AbandonedCartContext } from '../whatsapp/abandoned-cart';

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'ILS' ? '₪' : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString('he-IL', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}

function itemRow(item: { title: string; variant_title?: string | null; quantity: number; price: string; image_url?: string | null }, currency: string): string {
  const image = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" width="64" height="64" alt=""
           style="display:block;border-radius:8px;object-fit:cover;">`
    : `<div style="width:64px;height:64px;border-radius:8px;background:#f0ece6;"></div>`;

  const variant = item.variant_title
    ? `<div style="font-size:13px;color:#8a8378;">${escapeHtml(item.variant_title)}</div>`
    : '';

  return `<tr>
    <td width="64" style="padding:10px 0 10px 12px;vertical-align:top;">${image}</td>
    <td dir="rtl" style="padding:10px 0;vertical-align:top;text-align:right;">
      <div style="font-size:15px;color:#1a1a1a;">${escapeHtml(item.title)}</div>
      ${variant}
      <div style="font-size:13px;color:#8a8378;">כמות: ${escapeHtml(item.quantity)}</div>
    </td>
    <td dir="ltr" style="padding:10px 12px 10px 0;vertical-align:top;text-align:left;white-space:nowrap;font-size:15px;">
      ${escapeHtml(formatMoney(Number.parseFloat(item.price) * item.quantity, currency))}
    </td>
  </tr>`;
}

export function buildAbandonedCartEmail(ctx: AbandonedCartContext): string {
  const greeting = ctx.firstName ? `היי ${escapeHtml(ctx.firstName)},` : 'היי,';
  const rows = ctx.cartItems.map((i) => itemRow(i, ctx.currency)).join('');

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:bold;">${greeting}</p>
    <p style="margin:0 0 20px;color:#5a544c;">שמנו לב שהשארת כמה דברים בעגלה. שמרנו לך אותם.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-top:1px solid #eae5de;border-bottom:1px solid #eae5de;">
      ${rows}
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
      <tr>
        <td dir="rtl" style="text-align:right;font-size:15px;color:#5a544c;">סה"כ</td>
        <td dir="ltr" style="text-align:left;font-size:17px;font-weight:bold;">
          ${escapeHtml(formatMoney(ctx.subtotal, ctx.currency))}
        </td>
      </tr>
    </table>

    ${couponBox(ctx.couponCode, `${ctx.discountPct}% הנחה — בתוקף עד ${formatExpiry(ctx.couponExpiresAt)}`)}

    ${button(ctx.recoveryUrl, 'להשלמת ההזמנה')}

    <p style="margin:16px 0 0;color:#8a8378;font-size:13px;text-align:center;">
      הקוד יוחל אוטומטית בקופה. יש שאלה? פשוט השב/י למייל הזה.
    </p>`;

  return wrapEmail({
    title: 'שכחת משהו בעגלה',
    preheader: `הקוד ${ctx.couponCode} שומר לך ${ctx.discountPct}% הנחה`,
    bodyHtml,
  });
}

export function buildAbandonedCartSubject(ctx: AbandonedCartContext): string {
  return `שכחת משהו בעגלה? ${ctx.discountPct}% הנחה עם הקוד ${ctx.couponCode}`;
}
