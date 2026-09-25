import { createServer, type Server } from 'node:http';
import type { CreateBookingInput, ExtendBookingInput } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, type ApiResult, type Session } from '../../mobile/src/api/client.js';
import { Api } from '../../mobile/src/api/endpoints.js';
import { VALIDATION_FALLBACK } from '../../mobile/src/api/messages.js';
import {
  DEPOSIT_UNAVAILABLE,
  afterBooking,
  depositAttempt,
} from '../../mobile/src/booking/deposit.js';
import { bookingRequest } from '../../mobile/src/booking/request.js';
import { bookingView } from '../../mobile/src/booking/view.js';
import { makeActor, staffLot } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { listenForFetch } from './helpers/listen.js';
import { createLot } from './helpers/fixtures.js';

/**
 * THE MOBILE APP'S OWN CLIENT, against this API, over real HTTP.
 *
 * The device test found the two sides disagreeing in both directions while
 * every unit test passed: the Book screen crashed on a lot RESPONSE, then
 * "Hold this slot" sent a REQUEST with latitude/longitude where
 * createBookingSchema wants lat/lng (and extend sent additionalMinutes where
 * it wants additionalBlocks). Each side had been tested against its own idea
 * of the other.
 *
 * So this imports the app's Api class, its request builder and its message
 * mapping, and drives a whole driver journey against the real Express app
 * and Postgres. Requests are the app's exact bodies; responses go through the
 * app's exact parsers. Every raw response is also compared with what the
 * app's parser kept, so a field the API sends but the shared schema does not
 * describe fails here instead of being silently dropped.
 */

let t: TestContext;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
  server = createServer(t.app);
  const port = await listenForFetch(server);
  baseUrl = `http://127.0.0.1:${String(port)}/v1`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.sms.reset();
});

/** TEST LOT's values from the device test. */
const TEST_LOT = { blockMinutes: 5, ratePerBlockSantim: 500, depositSantim: 0 };
const AT = { latitude: 9.040093, longitude: 38.762541 };

interface RawResponse {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

/** The app's client, as the app builds it, plus a log of what came back raw. */
function appClient(): { client: ApiClient; api: Api; raw: RawResponse[] } {
  let stored: Session | null = null;
  const raw: RawResponse[] = [];
  const client = new ApiClient({
    baseUrl,
    tokens: {
      read: () => Promise.resolve(stored),
      write: (session) => {
        stored = session;
        return Promise.resolve();
      },
    },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const body: unknown =
        response.status === 204
          ? undefined
          : await response
              .clone()
              .json()
              .catch(() => undefined);
      raw.push({
        method: init?.method ?? 'GET',
        path: (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).slice(baseUrl.length),
        status: response.status,
        body,
      });
      return response;
    },
    monotonic: () => performance.now(),
    now: () => Date.now(),
    onSignedOut: () => undefined,
  });
  return { client, api: new Api(client), raw };
}

/** Succeeded, and the app's parser kept everything the API sent. */
function expectFullyParsed<T>(result: ApiResult<T>, raw: RawResponse[]): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(result.data, 'a field the shared schema does not describe').toEqual(raw.at(-1)?.body);
  return result.data;
}

/** Signs in exactly as the login screen does: OTP request, then verify. */
async function signIn(app: ReturnType<typeof appClient>, phone: string): Promise<Session> {
  expectFullyParsed(await app.api.requestOtp({ phone }), app.raw);
  const code = /\d{6}/u.exec(t.sms.lastMessageTo(phone) ?? '')?.[0];
  expect(code, 'the OTP SMS').toBeDefined();
  const session = expectFullyParsed(await app.api.verifyOtp({ phone, code: code ?? '' }), app.raw);
  await app.client.setSession(session);
  return session;
}

describe('the app drives a whole booking journey', () => {
  it('signs in, browses, books, cancels, extends, pays and registers for push', async () => {
    const app = appClient();
    const session = await signIn(app, '+251911000777');

    // Browse.
    const lot = await createLot(t.db.db, { name: 'TEST LOT', slots: 6, ...TEST_LOT, ...AT });
    const nearby = expectFullyParsed(await app.api.nearbyLots(AT.latitude, AT.longitude), app.raw);
    expect(nearby.lots.map((l) => l.id)).toContain(lot.lotId);
    const summary = expectFullyParsed(await app.api.lot(lot.lotId), app.raw);
    expectFullyParsed(await app.api.lotLayout(lot.lotId), app.raw);

    // Book with the plate left BLANK — the device test's first case.
    const blank = bookingRequest({
      lotId: summary.id,
      blocks: 2,
      blockMinutes: summary.blockMinutes,
      position: AT,
      plate: '',
    });
    expect('vehiclePlate' in blank, 'a blank plate is sent absent').toBe(false);
    const first = expectFullyParsed(await app.api.createBooking(blank), app.raw);
    expect(first.booking.status).toBe('RESERVED');
    expect(first.booking.vehiclePlate).toBeNull();
    expect(first.booking.plannedMinutes).toBe(10);

    const current = expectFullyParsed(await app.api.currentBooking(), app.raw);
    expect(current.booking?.id).toBe(first.booking.id);
    expectFullyParsed(await app.api.booking(first.booking.id), app.raw);

    const cancelled = expectFullyParsed(await app.api.cancel(first.booking.id), app.raw);
    expect(cancelled.booking.status).toBe('CANCELLED');

    // Book again WITH a plate — the device test's second case, untrimmed.
    const second = expectFullyParsed(
      await app.api.createBooking(
        bookingRequest({
          lotId: summary.id,
          blocks: 2,
          blockMinutes: summary.blockMinutes,
          position: AT,
          plate: '  AA-12345 ',
        }),
      ),
      app.raw,
    );
    expect(second.booking.vehiclePlate).toBe('AA-12345');

    // The attendant checks the car in (the dashboard's job, not the app's).
    const attendant = await makeActor(t, 'attendant');
    await staffLot(t, attendant, lot.lotId);
    const checkIn = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: second.booking.shortCode });
    expect(checkIn.status).toBe(200);

    // Extend by one block, as the booking screen's button does.
    const extended = expectFullyParsed(
      await app.api.extend(second.booking.id, { additionalBlocks: 1 }),
      app.raw,
    );
    expect(extended.addedMinutes).toBe(TEST_LOT.blockMinutes);

    // Check out, then pay in the app.
    const checkOut = await request(t.app)
      .post(`/v1/staff/bookings/${second.booking.id}/check-out`)
      .set(attendant.header);
    expect(checkOut.status).toBe(200);
    const pay = expectFullyParsed(await app.api.pay(second.booking.id), app.raw);
    expect(pay.checkoutUrl).toMatch(/^https?:\/\//u);

    // Push registration answers 204 with no body.
    const push = await app.api.registerPushToken({
      expoPushToken: 'ExponentPushToken[contract-test]',
    });
    expect(push.ok).toBe(true);
    expect(app.raw.at(-1)?.status).toBe(204);

    // A dead access token: the client refreshes with the app's own refresh
    // body, parses the new session, and retries.
    await app.client.setSession({ ...session, accessToken: 'not-a-valid-token' });
    const afterRefresh = await app.api.currentBooking();
    expect(afterRefresh.ok).toBe(true);
    const refresh = app.raw.find((r) => r.path === '/auth/refresh');
    expect(refresh?.status).toBe(200);
  });
});

describe('the deposit, as the app drives it', () => {
  const DEPOSIT_LOT = { ...TEST_LOT, depositSantim: 2000, paymentWindowMinutes: 3, ...AT };

  function bookAt(lotId: string): CreateBookingInput {
    return bookingRequest({
      lotId,
      blocks: 2,
      blockMinutes: TEST_LOT.blockMinutes,
      position: AT,
      plate: '',
    });
  }

  it('opens the checkout at booking, reopens the same one, and is reserved on return', async () => {
    t.provider.reset();
    const app = appClient();
    await signIn(app, '+251911000778');
    const lot = await createLot(t.db.db, { name: 'DEPOSIT LOT', slots: 2, ...DEPOSIT_LOT });

    const created = expectFullyParsed(await app.api.createBooking(bookAt(lot.lotId)), app.raw);
    const next = afterBooking(created);
    expect(next.checkoutUrl).toMatch(/^https?:\/\//u);
    expect(next.params).toEqual({ id: created.booking.id });
    const bookingId = created.booking.id;

    // The driver left the checkout without paying, and taps Pay deposit.
    const txRef = new URL(next.checkoutUrl ?? '').pathname.split('/').at(-1) ?? '';
    t.provider.setStatus(txRef, 'pending');
    const reopened = depositAttempt(await app.api.payDeposit(bookingId));
    expect(reopened).toEqual({ kind: 'open', checkoutUrl: next.checkoutUrl });
    expect(app.raw.at(-1)?.status).toBe(200);

    // Pending on return: the booking stands, still asking for the deposit.
    const pending = expectFullyParsed(await app.api.verifyDeposit(bookingId), app.raw);
    expect(bookingView(pending.booking).actions.payDeposit).toBe(true);

    // Paid, and the webhook has not arrived: the return check settles it.
    t.provider.setStatus(txRef, 'success');
    const paid = expectFullyParsed(await app.api.verifyDeposit(bookingId), app.raw);
    expect(paid.booking.status).toBe('RESERVED');
    expect(bookingView(paid.booking).actions.showQr).toBe(true);
  });

  it('when the payment service is down: books anyway, says so, and the retry works once it is back', async () => {
    t.provider.reset();
    const app = appClient();
    await signIn(app, '+251911000779');
    const lot = await createLot(t.db.db, { name: 'DEPOSIT LOT', slots: 2, ...DEPOSIT_LOT });

    t.provider.unavailable = true;
    const created = expectFullyParsed(await app.api.createBooking(bookAt(lot.lotId)), app.raw);
    expect(created.booking.status).toBe('PENDING_PAYMENT');
    expect(afterBooking(created)).toEqual({
      checkoutUrl: null,
      params: { id: created.booking.id, deposit: 'unavailable' },
    });

    // Still down: the retry reads as a payment-service problem, not a crash.
    expect(depositAttempt(await app.api.payDeposit(created.booking.id))).toEqual({
      kind: 'error',
      message: DEPOSIT_UNAVAILABLE,
    });
    // The return check still answers: nothing was initialized, so it has
    // nothing to ask the provider.
    expect((await app.api.verifyDeposit(created.booking.id)).ok).toBe(true);

    t.provider.unavailable = false;
    const retried = depositAttempt(await app.api.payDeposit(created.booking.id));
    expect(retried.kind).toBe('open');
    expect(app.raw.at(-1)?.status).toBe(201);
  });
});

describe('what the device test hit, through the same client', () => {
  it('the pre-fix booking body fails on lat/lng and reads as a driver message', async () => {
    const app = appClient();
    await signIn(app, '+251911000778');
    const lot = await createLot(t.db.db, { slots: 1, ...TEST_LOT, ...AT });

    // What the Book screen sent on the device. Cast: the type system now
    // refuses to build it, which is the point.
    const result = await app.api.createBooking({
      lotId: lot.lotId,
      plannedMinutes: 10,
      latitude: AT.latitude,
      longitude: AT.longitude,
    } as unknown as CreateBookingInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.details).toEqual({
      issues: [
        { path: 'lat', message: 'Invalid input: expected number, received undefined' },
        { path: 'lng', message: 'Invalid input: expected number, received undefined' },
      ],
    });
    // Not "Request validation failed", and nothing the driver could fix.
    expect(result.error.message).toBe(VALIDATION_FALLBACK);
  });

  it('the pre-fix extend body fails on additionalBlocks', async () => {
    const app = appClient();
    await signIn(app, '+251911000779');

    const result = await app.api.extend('00000000-0000-4000-8000-000000000000', {
      additionalMinutes: 5,
    } as unknown as ExtendBookingInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.details).toMatchObject({ issues: [{ path: 'additionalBlocks' }] });
    }
  });

  it('a plate the API rejects is explained as a plate problem', async () => {
    const app = appClient();
    await signIn(app, '+251911000780');
    const lot = await createLot(t.db.db, { slots: 1, ...TEST_LOT, ...AT });

    const result = await app.api.createBooking(
      bookingRequest({
        lotId: lot.lotId,
        blocks: 1,
        blockMinutes: 5,
        position: AT,
        plate: 'X'.repeat(33),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/plate number/u);
  });
});
