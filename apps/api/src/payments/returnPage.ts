import type { Request, Response } from 'express';

/**
 * The page Chapa sends the driver to when they leave its checkout
 * (`return_url`), in the in-app browser.
 *
 * IT CLAIMS NOTHING ABOUT THE PAYMENT. Reaching this URL proves nothing:
 * anyone can open it, and whatever Chapa appends to it is unverified. So it
 * reads no query parameter and echoes nothing back; it only sends the driver
 * back to the app, which asks the provider (POST /bookings/:id/deposit/verify)
 * and shows what really happened.
 *
 * Before this page existed the path had no route, and a driver who had just
 * paid landed on the API's JSON 404, which reads like a failed payment.
 */

/** Served at this path; initiatePayment builds `return_url` from the same constant. */
export const PAYMENT_RETURN_PATH = '/payment-complete';

/**
 * Amharic first: it is the app's default language. Both are always shown,
 * because nothing on a page Chapa redirects to says which the driver reads.
 * Listed in docs/AMHARIC-REVIEW.md; key parity is tested.
 */
export const RETURN_PAGE_STRINGS = {
  am: {
    title: 'ወደ ላቁም? መተግበሪያው ይመለሱ',
    body: 'ይህን ገጽ መዝጋት ይችላሉ። መተግበሪያው ክፍያዎን ከክፍያ አገልግሎቱ ጋር አረጋግጦ ክፍያው መፈጸሙን ወይም አለመፈጸሙን ያሳይዎታል።',
  },
  en: {
    title: 'Return to the ላቁም? app',
    body: 'You can close this page. The app checks your payment with the payment service and shows whether it went through.',
  },
} as const satisfies Record<'am' | 'en', { title: string; body: string }>;

function section(lang: 'am' | 'en'): string {
  const text = RETURN_PAGE_STRINGS[lang];
  return `<section lang="${lang}"><h1>${text.title}</h1><p>${text.body}</p></section>`;
}

/** Static: the same bytes for every request. */
export const RETURN_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="am">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${RETURN_PAGE_STRINGS.am.title} / ${RETURN_PAGE_STRINGS.en.title}</title>`,
  '<style>',
  'body{margin:0;padding:32px 20px;font-family:system-ui,"Noto Sans Ethiopic",sans-serif;',
  'background:#f7f7f5;color:#1a1a1a;line-height:1.5}',
  'section{max-width:32rem;margin:0 auto 28px}',
  'h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;font-size:1.05rem}',
  '@media (prefers-color-scheme:dark){body{background:#141414;color:#f2f2f2}}',
  '</style>',
  '</head>',
  '<body>',
  section('am'),
  section('en'),
  '</body>',
  '</html>',
].join('\n');

export function servePaymentReturnPage(_req: Request, res: Response): void {
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      // Nothing to cache, and nothing a proxy should keep.
      'Cache-Control': 'no-store',
      // No scripts, no external anything: inline style is all it has.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      // Chapa may put the transaction reference in the query string.
      'Referrer-Policy': 'no-referrer',
    })
    .send(RETURN_PAGE_HTML);
}
