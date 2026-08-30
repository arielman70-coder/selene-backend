import type { LineItem } from '../../db/schema';

export interface AbandonedCartContext {
  firstName: string | null;
  cartItems: LineItem[];
  subtotal: number;
  currency: string;
  couponCode: string;
  couponExpiresAt: string;
  recoveryUrl: string;
  discountPct: number;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('he-IL', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}

export function buildAbandonedCartWhatsApp(ctx: AbandonedCartContext): string {
  const greeting = ctx.firstName ? `היי ${ctx.firstName}!` : 'היי!';

  const shown = ctx.cartItems.slice(0, 3);
  const itemList = shown.map((i) => `• ${i.title} × ${i.quantity}`).join('\n');
  const remaining = ctx.cartItems.length - shown.length;
  const moreLine = remaining > 0 ? `\n...ועוד ${remaining} פריטים` : '';

  return `${greeting} 👋

שמנו לב שהשארת פריטים בעגלה:

${itemList}${moreLine}

🎁 *קוד הנחה בלעדי: ${ctx.couponCode}*
${ctx.discountPct}% הנחה על ההזמנה — בתוקף עד ${formatExpiry(ctx.couponExpiresAt)}

להשלמת הרכישה:
${ctx.recoveryUrl}

שאלות? אנחנו כאן ✨`;
}
