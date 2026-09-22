import { escapeHtml, wrapEmail } from './layout';

export interface LoginCodeContext {
  firstName: string | null;
  code: string;
  ttlMinutes: number;
}

export function buildLoginCodeEmail(ctx: LoginCodeContext): string {
  const greeting = ctx.firstName ? `היי ${escapeHtml(ctx.firstName)},` : 'היי,';

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:bold;">${greeting}</p>
    <p style="margin:0 0 20px;color:#5a544c;">הקוד לכניסה לאזור האישי:</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="margin:24px 0;border:2px dashed #c9a961;border-radius:10px;background:#fdfaf4;">
      <tr>
        <td align="center" dir="ltr" style="padding:24px 16px;">
          <div style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1a1a1a;font-family:monospace;">
            ${escapeHtml(ctx.code)}
          </div>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;color:#5a544c;">הקוד תקף ל-${escapeHtml(ctx.ttlMinutes)} דקות ולשימוש חד-פעמי.</p>

    <p style="margin:16px 0 0;color:#8a8378;font-size:13px;">
      לא ביקשת להיכנס? התעלם מהמייל — בלי הקוד הזה אף אחד לא נכנס לחשבון שלך,
      ולא נשלח לך שום דבר נוסף.
    </p>`;

  return wrapEmail({
    title: 'קוד כניסה',
    // Deliberately no code in the preheader: lock-screen previews are visible
    // to anyone holding the phone.
    preheader: 'קוד הכניסה לאזור האישי',
    bodyHtml,
  });
}

export function buildLoginCodeSubject(): string {
  return 'קוד הכניסה שלך לאזור האישי';
}
