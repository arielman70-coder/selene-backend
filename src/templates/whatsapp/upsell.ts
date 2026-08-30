export interface UpsellContext {
  firstName: string | null;
  orderName: string;
  offerProductTitle: string;
  offerProductUrl: string;
  discountPct: number;
  couponCode: string;
  ttlHours: number;
}

export function buildUpsellWhatsApp(ctx: UpsellContext): string {
  const greeting = ctx.firstName ? `${ctx.firstName}, תודה על הרכישה!` : 'תודה על הרכישה!';

  return `${greeting} 🎉

הזמנה ${ctx.orderName} שלך בדרך אליך.

רגע לפני שסוגרים — יש לנו הצעה *רק בשבילך*:

✨ *${ctx.offerProductTitle}*
${ctx.discountPct}% הנחה עם הקוד: *${ctx.couponCode}*

👉 ${ctx.offerProductUrl}

ההצעה תקפה ל-${ctx.ttlHours} שעות בלבד 🕐`;
}
