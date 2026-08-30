import { env } from '../../config/env';

/**
 * Plain HTML rather than React Email (which the spec sketched as .tsx).
 * Reasons: no extra build step or React dependency for a solo maintainer, and
 * email clients need table layout with inline styles anyway — the JSX buys
 * very little here.
 *
 * RTL is set on <html> and every block, because Gmail strips a <style> block's
 * `direction` rule but honours the inline attribute.
 */
export function wrapEmail(opts: {
  title: string;
  preheader: string;
  bodyHtml: string;
}): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f2ef;font-family:Arial,Helvetica,sans-serif;">
  <!-- Preheader: the grey line next to the subject in the inbox. Hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(opts.preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f4f2ef;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td align="center" dir="rtl"
                style="padding:28px 24px 8px;font-size:22px;font-weight:bold;letter-spacing:2px;color:#1a1a1a;">
              ${escapeHtml(env.FROM_NAME)}
            </td>
          </tr>
          <tr>
            <td dir="rtl" style="padding:8px 24px 32px;text-align:right;color:#1a1a1a;font-size:16px;line-height:1.6;">
              ${opts.bodyHtml}
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:560px;">
          <tr>
            <td dir="rtl" align="center"
                style="padding:16px 24px;color:#8a8378;font-size:12px;line-height:1.6;">
              נשלח מ-${escapeHtml(env.FROM_NAME)}<br>
              <a href="${env.SHOPIFY_STOREFRONT_URL}" style="color:#8a8378;">${escapeHtml(env.SHOPIFY_STOREFRONT_URL)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Product titles come from Shopify and land inside our HTML — a title with a
 * stray `<` would otherwise break the layout, and in a forwarded email an
 * injected tag is a real problem.
 */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto;">
    <tr>
      <td align="center" style="border-radius:8px;background:#1a1a1a;">
        <a href="${escapeHtml(href)}"
           style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;border-radius:8px;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

export function couponBox(code: string, subtitle: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:24px 0;border:2px dashed #c9a961;border-radius:10px;background:#fdfaf4;">
    <tr>
      <td align="center" dir="rtl" style="padding:20px 16px;">
        <div style="font-size:13px;color:#8a7c5c;margin-bottom:6px;">קוד הנחה</div>
        <div style="font-size:26px;font-weight:bold;letter-spacing:3px;color:#1a1a1a;font-family:monospace;">
          ${escapeHtml(code)}
        </div>
        <div style="font-size:13px;color:#8a7c5c;margin-top:8px;">${escapeHtml(subtitle)}</div>
      </td>
    </tr>
  </table>`;
}
