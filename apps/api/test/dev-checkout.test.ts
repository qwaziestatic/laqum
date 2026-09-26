import { createBookingResponseSchema, informalAmharic, systemClock } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEV_CHECKOUT_PATH, DEV_CHECKOUT_STRINGS } from '../src/payments/devCheckout.js';
import { FakePaymentProvider } from '../src/payments/fake.js';
import { paymentProviderFor } from '../src/payments/providerFor.js';
import { PAYMENT_RETURN_PATH } from '../src/payments/returnPage.js';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, testConfig, type TestContext } from './helpers/context.js';
import { migrateFresh, testLogger, truncateAll } from './helpers/db.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * THE DEVELOPMENT CHECKOUT PAGE.
 *
 * Where the fake provider sends the driver: the lot, the amount, Pay and
 * Fail. The product owner's rules, each tested here: it cannot exist in
 * production, and it bypasses no payment logic, so a Pay still has to go
 * through the app's verify before anything moves.
 */

let t: TestContext;
let lot: LotFixture;
let driver: Actor;

beforeAll(async () => {
  await migrateFresh();
  // Never succeeds by itself: only Pay or Fail decides, as on a phone.
  t = await createTestContext({
    fakeProvider: {
      autoSucceedAfterSeconds: null,
      baseCheckoutUrl: `http://api.test${DEV_CHECKOUT_PATH}`,
    },
  });
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.provider.reset();
  lot = await createLot(t.db.db, { slots: 2, depositSantim: 2000, paymentWindowMinutes: 3 });
  driver = await makeActor(t, 'driver');
});

async function bookWithDeposit(): Promise<{ bookingId: string; txRef: string }> {
  const res = await request(t.app)
    .post('/v1/bookings')
    .set(driver.header)
    .send({ lotId: lot.lotId, plannedMinutes: 30, lat: lot.latitude, lng: lot.longitude });
  expect(res.status).toBe(201);
  const created = createBookingResponseSchema.parse(res.body);
  const checkoutUrl = created.checkoutUrl ?? '';
  expect(checkoutUrl.startsWith(`http://api.test${DEV_CHECKOUT_PATH}/`)).toBe(true);
  return { bookingId: created.booking.id, txRef: checkoutUrl.split('/').at(-1) ?? '' };
}

async function statusOf(bookingId: string): Promise<string> {
  const row = await t.db.db
    .selectFrom('bookings')
    .select('status')
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return row.status;
}

const verify = (bookingId: string) =>
  request(t.app).post(`/v1/bookings/${bookingId}/deposit/verify`).set(driver.header);

describe('the page', () => {
  it('shows the lot and the amount, with Pay and Fail, in both languages', async () => {
    const { txRef } = await bookWithDeposit();
    await t.db.db
      .updateTable('lots')
      .set({ name: 'Bole Test Parking' })
      .where('id', '=', lot.lotId)
      .execute();
    const res = await request(t.app).get(`${DEV_CHECKOUT_PATH}/${txRef}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('data-testid="dev-checkout-lot">Bole Test Parking<');
    expect(res.text).toContain('20.00 ብር / ETB 20.00');
    for (const lang of ['am', 'en'] as const) {
      const s = DEV_CHECKOUT_STRINGS[lang];
      for (const text of [s.title, s.notice, s.pay, s.fail]) expect(res.text).toContain(text);
    }
    expect(res.text).toContain(`action="${DEV_CHECKOUT_PATH}/${txRef}/pay"`);
    expect(res.text).toContain(`action="${DEV_CHECKOUT_PATH}/${txRef}/fail"`);
  });

  it('allows no script, posts only to itself, and is not cached', async () => {
    const { txRef } = await bookWithDeposit();
    const res = await request(t.app).get(`${DEV_CHECKOUT_PATH}/${txRef}`);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('<script');
  });

  it('escapes the lot name', async () => {
    const { txRef } = await bookWithDeposit();
    await t.db.db
      .updateTable('lots')
      .set({ name: '<b>Bole</b> & "Co"' })
      .where('id', '=', lot.lotId)
      .execute();
    const res = await request(t.app).get(`${DEV_CHECKOUT_PATH}/${txRef}`);
    expect(res.text).toContain('&lt;b&gt;Bole&lt;/b&gt; &amp; &quot;Co&quot;');
    expect(res.text).not.toContain('<b>Bole</b>');
  });

  it('answers 404 for a reference nobody started, or one that is not ours', async () => {
    for (const ref of ['laqum-dep-0000', 'x'.repeat(101), '..%2F..%2Fetc']) {
      const page = await request(t.app).get(`${DEV_CHECKOUT_PATH}/${ref}`);
      expect(page.status, ref).toBe(404);
      const pay = await request(t.app).post(`${DEV_CHECKOUT_PATH}/${ref}/pay`);
      expect(pay.status, ref).toBe(404);
    }
  });

  it('has the same keys in both languages, none empty, all in the polite register', () => {
    expect(Object.keys(DEV_CHECKOUT_STRINGS.am).sort()).toEqual(
      Object.keys(DEV_CHECKOUT_STRINGS.en).sort(),
    );
    for (const lang of ['am', 'en'] as const) {
      for (const value of Object.values(DEV_CHECKOUT_STRINGS[lang]))
        expect(value.trim()).not.toBe('');
    }
    for (const value of Object.values(DEV_CHECKOUT_STRINGS.am))
      expect(informalAmharic(value), value).toEqual([]);
  });
});

describe('it bypasses no payment logic', () => {
  it('Pay decides only what the provider says: nothing moves until the app verifies', async () => {
    const { bookingId, txRef } = await bookWithDeposit();

    const paid = await request(t.app).post(`${DEV_CHECKOUT_PATH}/${txRef}/pay`);
    expect(paid.status).toBe(303);
    expect(paid.headers['location']).toBe(PAYMENT_RETURN_PATH);

    // Pressing Pay changed no booking and no payment row.
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
    const payment = await t.db.db
      .selectFrom('payments')
      .select('status')
      .where('tx_ref', '=', txRef)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('pending');

    // The app's verify, as with Chapa, is what reserves the slot.
    const verified = await verify(bookingId);
    expect(verified.status).toBe(200);
    expect(await statusOf(bookingId)).toBe('RESERVED');
  });

  it('Fail leaves the booking waiting for its deposit, and verify says so', async () => {
    const { bookingId, txRef } = await bookWithDeposit();
    const failed = await request(t.app).post(`${DEV_CHECKOUT_PATH}/${txRef}/fail`);
    expect(failed.status).toBe(303);
    expect(failed.headers['location']).toBe(PAYMENT_RETURN_PATH);

    await verify(bookingId);
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
  });

  it('pressing nothing leaves the payment pending: the page, not a timer, decides', async () => {
    const { bookingId } = await bookWithDeposit();
    t.clock.advanceMinutes(2);
    await verify(bookingId);
    expect(await statusOf(bookingId)).not.toBe('RESERVED');
  });
});

describe('it is impossible in production', () => {
  it('is not registered when NODE_ENV is production: the generic 404', async () => {
    const { txRef } = await bookWithDeposit();
    const production = createApp({
      ...t.ctx,
      config: { ...t.ctx.config, NODE_ENV: 'production', DEV_CHECKOUT_ENABLED: false },
    });
    const page = await request(production).get(`${DEV_CHECKOUT_PATH}/${txRef}`);
    // The generic 404 of any unknown path, not a page saying "disabled".
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toMatch(/^application\/json/u);
    expect((page.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    const pay = await request(production).post(`${DEV_CHECKOUT_PATH}/${txRef}/pay`);
    expect(pay.status).toBe(404);
    // And nothing was decided.
    expect((await t.provider.verify(txRef)).status).toBe('pending');
  });

  it('derives its gate from the configuration, which refuses it in production', () => {
    expect(testConfig({ PAYMENT_PROVIDER: 'fake' }).DEV_CHECKOUT_ENABLED).toBe(true);
    expect(
      testConfig({ PAYMENT_PROVIDER: 'chapa', CHAPA_SECRET_KEY: 'CHASECK_TEST-x' })
        .DEV_CHECKOUT_ENABLED,
    ).toBe(false);
    expect(
      testConfig({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'fake',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        TRUST_PROXY_HOPS: '1',
      }).DEV_CHECKOUT_ENABLED,
    ).toBe(false);
  });

  it('is not registered for the real provider', async () => {
    const chapa = createApp({
      ...t.ctx,
      config: { ...t.ctx.config, PAYMENT_PROVIDER: 'chapa', DEV_CHECKOUT_ENABLED: false },
    });
    const res = await request(chapa).get(`${DEV_CHECKOUT_PATH}/laqum-dep-x`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/u);
  });
});

describe('the provider the server builds', () => {
  const logger = testLogger();

  it('sends drivers to this page, on the public address', async () => {
    const provider = paymentProviderFor(
      testConfig({ PUBLIC_BASE_URL: 'http://192.168.1.5:18000/' }),
      {
        clock: systemClock,
        logger,
      },
    );
    expect(provider).toBeInstanceOf(FakePaymentProvider);
    const { checkoutUrl } = await provider.initialize({ txRef: 'laqum-dep-a', amountSantim: 2000 });
    expect(checkoutUrl).toBe(`http://192.168.1.5:18000${DEV_CHECKOUT_PATH}/laqum-dep-a`);
  });

  it('never succeeds by itself unless FAKE_PAYMENT_DELAY_SECONDS asks for it', async () => {
    const decides = paymentProviderFor(testConfig(), { clock: systemClock, logger });
    await decides.initialize({ txRef: 'laqum-dep-a', amountSantim: 2000 });
    expect((await decides.verify('laqum-dep-a')).status).toBe('pending');

    const automatic = paymentProviderFor(testConfig({ FAKE_PAYMENT_DELAY_SECONDS: '0' }), {
      clock: systemClock,
      logger,
    });
    await automatic.initialize({ txRef: 'laqum-dep-b', amountSantim: 2000 });
    expect((await automatic.verify('laqum-dep-b')).status).toBe('success');
  });
});
