import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_DESCRIPTIONS, initiatePayment } from '../src/payments/initiate.js';
import { PAYMENT_RETURN_PATH, RETURN_PAGE_STRINGS } from '../src/payments/returnPage.js';
import { makeActor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, seedBooking } from './helpers/fixtures.js';

/**
 * Chapa's return page, and what the API tells Chapa about each payment.
 *
 * Before the page existed, a driver who had just paid landed on the API's
 * JSON 404 in the in-app browser. The page must still not claim the payment
 * succeeded: only the app, by asking the provider, can say that.
 */

let t: TestContext;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.provider.reset();
});

describe('the return page', () => {
  it('sends the driver back to the app, in Amharic and English', async () => {
    const res = await request(t.app).get(PAYMENT_RETURN_PATH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    for (const lang of ['am', 'en'] as const) {
      expect(res.text).toContain(`<section lang="${lang}">`);
      expect(res.text).toContain(RETURN_PAGE_STRINGS[lang].title);
      expect(res.text).toContain(RETURN_PAGE_STRINGS[lang].body);
    }
  });

  it('has the same keys, none empty, in both languages', () => {
    const keys = (lang: 'am' | 'en') => Object.keys(RETURN_PAGE_STRINGS[lang]).sort();
    expect(keys('am')).toEqual(keys('en'));
    for (const lang of ['am', 'en'] as const) {
      for (const value of Object.values(RETURN_PAGE_STRINGS[lang])) {
        expect(value.trim(), lang).not.toBe('');
      }
    }
  });

  it('does not claim the payment succeeded', () => {
    // Reaching this URL proves nothing; the app verifies with the provider.
    const english = Object.values(RETURN_PAGE_STRINGS.en).join(' ').toLowerCase();
    for (const claim of ['success', 'received', 'confirmed', 'complete', 'thank', 'paid']) {
      expect(english, claim).not.toContain(claim);
    }
  });

  it('ignores whatever is appended to it: nothing from the URL reaches the page', async () => {
    const plain = await request(t.app).get(PAYMENT_RETURN_PATH);
    const decorated = await request(t.app)
      .get(PAYMENT_RETURN_PATH)
      .query({ status: 'success', trx_ref: '<script>alert(1)</script>' });

    expect(decorated.status).toBe(200);
    expect(decorated.text).toBe(plain.text);
  });

  it('allows no script, and is not cached', async () => {
    const res = await request(t.app).get(PAYMENT_RETURN_PATH);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('<script');
  });
});

describe('what the API tells Chapa', () => {
  async function initializeInput(kind: 'deposit' | 'final') {
    const lot = await createLot(t.db.db, { slots: 1, depositSantim: 2000 });
    const driver = await makeActor(t, 'driver');
    const bookingId = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'PENDING_PAYMENT',
      holdExpiresAt: new Date(t.clock.now().getTime() + 3 * 60_000),
    });
    const spy = vi.spyOn(t.provider, 'initialize');
    await initiatePayment(t.ctx, { bookingId, kind, amountSantim: 2000 });
    const input = spy.mock.calls[0]?.[0];
    spy.mockRestore();
    return input;
  }

  it('returns the driver to the page this API serves', async () => {
    const input = await initializeInput('deposit');
    expect(input?.returnUrl).toBe(`${t.ctx.config.PUBLIC_BASE_URL}${PAYMENT_RETURN_PATH}`);

    const res = await request(t.app).get(new URL(input?.returnUrl ?? '').pathname);
    expect(res.status).toBe(200);
  });

  it('describes both payments in plain ASCII, until the sandbox proves Amharic works', async () => {
    expect(PAYMENT_DESCRIPTIONS).toEqual({
      deposit: 'Laqum parking deposit',
      final: 'Laqum parking',
    });
    for (const kind of ['deposit', 'final'] as const) {
      const input = await initializeInput(kind);
      expect(input?.description, kind).toBe(PAYMENT_DESCRIPTIONS[kind]);
      expect(input?.description, kind).toMatch(/^[\x20-\x7e]+$/u);
    }
  });
});
