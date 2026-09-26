import { formatSantim } from '@laqum/shared';
import { type Request, type Response, Router } from 'express';
import type { AppContext } from '../context.js';
import type { FakePaymentProvider } from './fake.js';
import { PAYMENT_RETURN_PATH } from './returnPage.js';

/**
 * THE DEVELOPMENT CHECKOUT: where FakePaymentProvider sends the driver.
 *
 * Its checkout URL used to be https://checkout.test/pay/…, which cannot load
 * (.test is reserved), so a phone showed a browser error. This is a real page
 * instead: the lot, the amount, and Pay / Fail.
 *
 * IMPOSSIBLE IN PRODUCTION. The router is registered only when
 * config.DEV_CHECKOUT_ENABLED (the fake provider AND NODE_ENV not production),
 * so otherwise the path is the generic 404 like any unknown one: there is no
 * guard clause to get wrong.
 *
 * IT BYPASSES NOTHING. Pay and Fail only decide what the fake PROVIDER will
 * report; no booking and no payment row is touched here. The app then asks
 * the provider on return (POST /bookings/:id/deposit/verify), exactly as it
 * does with Chapa, and that is what moves the booking.
 */

export const DEV_CHECKOUT_PATH = '/dev/checkout';

/**
 * Amharic first, as on the return page; both always shown. Polite register.
 * Listed in docs/AMHARIC-REVIEW.md; key parity is tested.
 */
export const DEV_CHECKOUT_STRINGS = {
  am: {
    title: 'የሙከራ ክፍያ',
    notice: 'ይህ ገጽ ለሙከራ ብቻ ነው። ምንም ገንዘብ አይንቀሳቀስም።',
    lot: 'የመኪና ማቆሚያ',
    amount: 'የሚከፈለው',
    currency: 'ብር',
    pay: 'ይክፈሉ',
    fail: 'ክፍያው እንዳይሳካ ያድርጉ',
    notFound: 'ይህ የሙከራ ክፍያ አልተገኘም። ሰርቨሩ እንደገና ከተጀመረ፣ ክፍያውን ከመተግበሪያው እንደገና ይጀምሩ።',
  },
  en: {
    title: 'Test payment',
    notice: 'This page is for testing only. No money moves.',
    lot: 'Parking',
    amount: 'Amount',
    currency: 'ETB',
    pay: 'Pay',
    fail: 'Fail',
    notFound:
      'This test payment was not found. If the server restarted, start the payment again from the app.',
  },
} as const satisfies Record<'am' | 'en', Record<string, string>>;

type Lang = keyof typeof DEV_CHECKOUT_STRINGS;
const LANGS: readonly Lang[] = ['am', 'en'];

/** Our own references only: laqum-dep-…, laqum-fin-…. Anything else is refused. */
const TX_REF = /^[A-Za-z0-9._-]{1,100}$/u;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const STYLE = [
  'body{margin:0;padding:32px 20px;font-family:system-ui,"Noto Sans Ethiopic",sans-serif;',
  'background:#f7f7f5;color:#1a1a1a;line-height:1.5}',
  'main{max-width:32rem;margin:0 auto}',
  'h1{font-size:1.4rem;margin:0 0 4px}',
  '.notice{margin:0 0 20px;padding:10px 12px;border-radius:8px;background:#fef3c7;color:#451a03}',
  'dl{margin:0 0 24px}dt{font-size:.9rem;color:#475569}dd{margin:0 0 12px;font-size:1.2rem;font-weight:600}',
  'form{margin:0 0 12px}',
  'button{width:100%;min-height:52px;border-radius:10px;font-size:1.05rem;font-weight:600;cursor:pointer}',
  '.pay{background:#15803d;color:#fff;border:0}',
  '.fail{background:transparent;color:#1a1a1a;border:2px solid #475569}',
  '@media (prefers-color-scheme:dark){body{background:#141414;color:#f2f2f2}dt{color:#cbd5e1}',
  '.fail{color:#f2f2f2;border-color:#94a3b8}}',
].join('');

function page(lang: 'am', title: string, body: string): string {
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>',
  ].join('\n');
}

const both = (pick: (lang: Lang) => string, separator = ' / '): string =>
  LANGS.map(pick).join(separator);

function checkoutHtml(txRef: string, lotName: string, amountSantim: number): string {
  const s = DEV_CHECKOUT_STRINGS;
  const amount = formatSantim(amountSantim);
  const ref = encodeURIComponent(txRef);
  const heading = LANGS.map((lang) => `<h1 lang="${lang}">${s[lang].title}</h1>`).join('');
  const notice = LANGS.map((lang) => `<span lang="${lang}">${s[lang].notice}</span>`).join('<br>');
  const button = (action: 'pay' | 'fail'): string =>
    `<form method="post" action="${DEV_CHECKOUT_PATH}/${ref}/${action}">` +
    `<button type="submit" class="${action}" data-testid="dev-checkout-${action}">` +
    `${both((lang) => s[lang][action])}</button></form>`;
  return page(
    'am',
    both((lang) => s[lang].title),
    [
      heading,
      `<p class="notice">${notice}</p>`,
      '<dl>',
      `<dt>${both((lang) => s[lang].lot)}</dt>`,
      `<dd data-testid="dev-checkout-lot">${escapeHtml(lotName)}</dd>`,
      `<dt>${both((lang) => s[lang].amount)}</dt>`,
      `<dd data-testid="dev-checkout-amount">${amount} ${s.am.currency} / ${s.en.currency} ${amount}</dd>`,
      '</dl>',
      button('pay'),
      button('fail'),
    ].join('\n'),
  );
}

const NOT_FOUND_HTML = page(
  'am',
  both((lang) => DEV_CHECKOUT_STRINGS[lang].title),
  LANGS.map((lang) => `<p lang="${lang}">${DEV_CHECKOUT_STRINGS[lang].notFound}</p>`).join('\n'),
);

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // No scripts; its forms post only to itself.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function devCheckoutRouter(ctx: AppContext, provider: FakePaymentProvider): Router {
  const router = Router();

  /** The payment this reference names, if both the provider and we know it. */
  async function lookup(txRef: string) {
    if (!TX_REF.test(txRef) || !provider.initialized(txRef)) return null;
    return (
      (await ctx.db
        .selectFrom('payments')
        .innerJoin('bookings', 'bookings.id', 'payments.booking_id')
        .innerJoin('lots', 'lots.id', 'bookings.lot_id')
        .select(['payments.amount_santim', 'lots.name as lot_name'])
        .where('payments.tx_ref', '=', txRef)
        .executeTakeFirst()) ?? null
    );
  }

  router.get('/:txRef', async (req: Request<{ txRef: string }>, res: Response) => {
    const found = await lookup(req.params.txRef);
    if (!found) {
      res.status(404).set(HEADERS).send(NOT_FOUND_HTML);
      return;
    }
    res
      .status(200)
      .set(HEADERS)
      .send(checkoutHtml(req.params.txRef, found.lot_name, found.amount_santim));
  });

  for (const [action, status] of [
    ['pay', 'success'],
    ['fail', 'failed'],
  ] as const) {
    router.post(`/:txRef/${action}`, async (req: Request<{ txRef: string }>, res: Response) => {
      const found = await lookup(req.params.txRef);
      if (!found) {
        res.status(404).set(HEADERS).send(NOT_FOUND_HTML);
        return;
      }
      // What the provider will SAY, and nothing else: verify moves the booking.
      provider.setStatus(req.params.txRef, status);
      ctx.logger.info({ txRef: req.params.txRef, status }, 'dev checkout: fake payment decided');
      // 303: the browser follows with a GET, to the same page Chapa returns to.
      res.redirect(303, PAYMENT_RETURN_PATH);
    });
  }

  return router;
}
