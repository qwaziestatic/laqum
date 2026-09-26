import { expect, test } from '@playwright/test';
import { withDb } from './db.js';
import { API_ORIGIN, SEEDED_DRIVER_PHONE, reseed } from './fixtures.js';

/**
 * THE DEVELOPMENT CHECKOUT PAGE, driven as the phone's in-app browser would.
 *
 * The fake provider sends the driver to a real page on the API (it used to be
 * https://checkout.test/…, which cannot load). Pay there only decides what
 * the provider will say: the booking moves when the app verifies, exactly as
 * with Chapa. The API's own tests cover its absence in production.
 *
 * With BRAND_PREVIEWS=1 the page is also saved to docs/brand-previews/.
 */

const PREVIEWS = process.env['BRAND_PREVIEWS'] === '1';
const BOLE = 'Bole Medhanialem Parking';

test('a deposit: the page, Pay, the return page, and only then the app verifies', async ({
  page,
  request,
}) => {
  reseed();

  // A driver books the deposit lot, as the app does.
  const login = await request.post(`${API_ORIGIN}/v1/auth/dev-login`, {
    data: { phone: SEEDED_DRIVER_PHONE },
  });
  expect(login.status()).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const auth = { authorization: `Bearer ${accessToken}` };

  const lot = await withDb((db) =>
    db
      .selectFrom('lots')
      .select(['id', 'latitude', 'longitude', 'block_minutes'])
      .where('name', '=', BOLE)
      .executeTakeFirstOrThrow(),
  );
  const booked = await request.post(`${API_ORIGIN}/v1/bookings`, {
    headers: auth,
    data: {
      lotId: lot.id,
      plannedMinutes: lot.block_minutes,
      lat: lot.latitude,
      lng: lot.longitude,
    },
  });
  expect(booked.status()).toBe(201);
  const { booking, checkoutUrl } = (await booked.json()) as {
    booking: { id: string; status: string };
    checkoutUrl: string | null;
  };
  expect(booking.status).toBe('PENDING_PAYMENT');
  expect(checkoutUrl).toMatch(new RegExp(`^${API_ORIGIN}/dev/checkout/laqum-`, 'u'));

  // The page the in-app browser opens.
  await page.goto(checkoutUrl ?? '');
  await expect(page.getByTestId('dev-checkout-lot')).toHaveText(BOLE);
  await expect(page.getByTestId('dev-checkout-amount')).toHaveText('20.00 ብር / ETB 20.00');

  if (PREVIEWS) {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.screenshot({ path: 'docs/brand-previews/dev-checkout-light.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'docs/brand-previews/dev-checkout-dark.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await page.getByTestId('dev-checkout-pay').click();
  await expect(page).toHaveURL(`${API_ORIGIN}/payment-complete`);

  const statusOf = () =>
    withDb(async (db) => {
      const row = await db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', booking.id)
        .executeTakeFirstOrThrow();
      return row.status;
    });

  // Pressing Pay moved nothing: the page is not a payment.
  expect(await statusOf()).toBe('PENDING_PAYMENT');

  // The app asks the provider on return, as with Chapa. That reserves the slot.
  const verified = await request.post(`${API_ORIGIN}/v1/bookings/${booking.id}/deposit/verify`, {
    headers: auth,
  });
  expect(verified.status()).toBe(200);
  expect(await statusOf()).toBe('RESERVED');
});
