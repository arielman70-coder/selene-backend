import { button, couponBox, escapeHtml, wrapEmail } from './email/layout';

export interface CashbackCodeContext {
  firstName: string | null;
  code: string;
  amount: number;
  expiresAt: string;
  storefrontUrl: string;
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  });
}

export function buildCashbackCodeWhatsApp(ctx: CashbackCodeContext): string {
  const greeting = ctx.firstName ? `היי ${ctx.firstName}!` : 'היי!';

  return `${greeting} 💰

מימשת ₪${ctx.amount.toFixed(2)} קאשבק.

*קוד ההנחה שלך: ${ctx.code}*
בתוקף עד ${formatExpiry(ctx.expiresAt)}

להזמנה:
${ctx.storefrontUrl}

לא ביקשת את זה? התעלם מההודעה — הקוד עובד רק בחשבון שלך.`;
}

export function buildCashbackCodeEmail(ctx: CashbackCodeContext): string {
  const greeting = ctx.firstName ? `היי ${escapeHtml(ctx.firstName)},` : 'היי,';

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:bold;">${greeting}</p>
    <p style="margin:0 0 20px;color:#5a544c;">
      מימשת ₪${escapeHtml(ctx.amount.toFixed(2))} קאשבק. הנה הקוד שלך:
    </p>

    ${couponBox(ctx.code, `₪${ctx.amount.toFixed(2)} הנחה — בתוקף עד ${formatExpiry(ctx.expiresAt)}`)}

    ${button(ctx.storefrontUrl, 'לחנות')}

    <p style="margin:16px 0 0;color:#8a8378;font-size:13px;text-align:center;">
      לא ביקשת לממש קאשבק? התעלם מהמייל — הקוד משויך לחשבון שלך בלבד
      והיתרה נשארת זמינה עד שישתמשו בו.
    </p>`;

  return wrapEmail({
    title: 'קוד הקאשבק שלך',
    preheader: `₪${ctx.amount.toFixed(2)} הנחה — קוד ${ctx.code}`,
    bodyHtml,
  });
}

export function buildCashbackCodeSubject(ctx: CashbackCodeContext): string {
  return `קוד הקאשבק שלך: ₪${ctx.amount.toFixed(2)} הנחה`;
}
