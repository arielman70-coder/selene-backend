import { button, couponBox, escapeHtml, wrapEmail } from './layout';
import type { UpsellContext } from '../whatsapp/upsell';

export function buildUpsellEmail(ctx: UpsellContext): string {
  const greeting = ctx.firstName ? `${escapeHtml(ctx.firstName)}, תודה על הרכישה!` : 'תודה על הרכישה!';

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:bold;">${greeting} 🎉</p>
    <p style="margin:0 0 20px;color:#5a544c;">
      הזמנה ${escapeHtml(ctx.orderName)} שלך בדרך אליך. רגע לפני שסוגרים — יש לנו הצעה רק בשבילך.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background:#faf8f5;border-radius:10px;">
      <tr>
        <td dir="rtl" style="padding:20px;text-align:right;">
          <div style="font-size:18px;font-weight:bold;color:#1a1a1a;">
            ${escapeHtml(ctx.offerProductTitle)}
          </div>
          <div style="font-size:15px;color:#5a544c;margin-top:6px;">
            ${escapeHtml(ctx.discountPct)}% הנחה, ${escapeHtml(ctx.ttlHours)} שעות בלבד
          </div>
        </td>
      </tr>
    </table>

    ${couponBox(ctx.couponCode, `${ctx.discountPct}% הנחה על ההצעה`)}

    ${button(ctx.offerProductUrl, 'לצפייה בהצעה')}

    <p style="margin:16px 0 0;color:#8a8378;font-size:13px;text-align:center;">
      ההצעה תקפה ל-${escapeHtml(ctx.ttlHours)} שעות מרגע קבלת המייל.
    </p>`;

  return wrapEmail({
    title: 'הצעה מיוחדת בשבילך',
    preheader: `${ctx.discountPct}% הנחה על ${ctx.offerProductTitle}`,
    bodyHtml,
  });
}

export function buildUpsellSubject(ctx: UpsellContext): string {
  return `רק בשבילך: ${ctx.discountPct}% הנחה על ${ctx.offerProductTitle}`;
}
