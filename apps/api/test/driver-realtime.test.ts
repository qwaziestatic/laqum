import { createServer, type Server as HttpServer } from 'node:http';
import type { BookingUpdated } from '@laqum/shared';
import { io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, type Session } from '../../mobile/src/api/client.js';
import { Api } from '../../mobile/src/api/endpoints.js';
import { bookingRequest } from '../../mobile/src/booking/request.js';
import { BookingFeed } from '../../mobile/src/realtime/bookingFeed.js';
import {
  DriverRealtime,
  type RealtimeState,
  socketOriginFor,
} from '../../mobile/src/realtime/connection.js';
import { signPayload } from '../src/payments/signature.js';
import { SocketEmitter } from '../src/realtime/emitter.js';
import { createRealtimeServer, type RealtimeServer } from '../src/realtime/server.js';
import { ManualTimers } from '../src/realtime/timers.js';
import { makeActor, staffLot, type Actor } from './helpers/auth.js';
import { clearRateLimits, createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { listenForFetch } from './helpers/listen.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * REALTIME IN THE DRIVER APP, end to end.
 *
 * The app's own ApiClient, Api, DriverRealtime and BookingFeed, against the
 * real API and Socket.io server over HTTP and WebSocket, with the real
 * emitter wired in exactly as server.ts wires it. Changes made by someone
 * else (the attendant, the payment webhook) must reach the driver without the
 * app asking, carrying a lot version newer than the snapshot it holds.
 */

let t: TestContext;
let http: HttpServer;
let realtimeServer: RealtimeServer;
let timers: ManualTimers;
let baseUrl: string;
let lot: LotFixture;
let attendant: Actor;
const open: DriverRealtime[] = [];

const AT = { latitude: 9.040093, longitude: 38.762541 };

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  await clearRateLimits(t.redis);
  t.sms.reset();
  t.provider.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');

  timers = new ManualTimers();
  http = createServer(t.app);
  realtimeServer = createRealtimeServer(http, {
    db: t.db.db,
    config: t.ctx.config,
    clock: t.ctx.clock,
    logger: t.ctx.logger,
    timers,
  });
  // As server.ts does: emits after every commit go to real sockets.
  t.ctx.emitter = new SocketEmitter(realtimeServer.io);
  const port = await listenForFetch(http);
  baseUrl = `http://127.0.0.1:${String(port)}/v1`;

  lot = await createLot(t.db.db, {
    slots: 3,
    blockMinutes: 30,
    ratePerBlockSantim: 2000,
    depositSantim: 0,
    ...AT,
  });
  attendant = await makeActor(t, 'attendant');
  await staffLot(t, attendant, lot.lotId);
});

afterEach(async () => {
  for (const realtime of open.splice(0)) realtime.close();
  t.ctx.emitter = t.emitter;
  await realtimeServer.close();
  await new Promise<void>((resolve) => {
    http.close(() => {
      resolve();
    });
  });
});

interface Driver {
  api: Api;
  client: ApiClient;
  realtime: DriverRealtime;
  events: BookingUpdated[];
  states: RealtimeState[];
  resyncs: number;
  refreshCalls: () => number;
  signedOut: () => boolean;
}

/** A driver's app, built as the app builds it, signed in by SMS code. */
async function driverApp(phone: string): Promise<Driver> {
  let stored: Session | null = null;
  let refreshes = 0;
  let signedOut = false;
  const client = new ApiClient({
    baseUrl,
    tokens: {
      read: () => Promise.resolve(stored),
      write: (session) => {
        stored = session;
        return Promise.resolve();
      },
    },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/auth/refresh')) refreshes++;
      return fetch(input, init);
    },
    monotonic: () => performance.now(),
    now: () => Date.now(),
    onSignedOut: () => {
      signedOut = true;
    },
  });
  const api = new Api(client);

  await api.requestOtp({ phone });
  const code = /\d{6}/u.exec(t.sms.lastMessageTo(phone) ?? '')?.[0] ?? '';
  const session = await api.verifyOtp({ phone, code });
  if (!session.ok) throw new Error(session.error.message);
  await client.setSession(session.data);

  const realtime = new DriverRealtime({
    url: socketOriginFor(baseUrl),
    io,
    token: () => client.session?.accessToken ?? null,
    refresh: async () => (await client.refresh()).ok,
  });
  open.push(realtime);

  const driver: Driver = {
    api,
    client,
    realtime,
    events: [],
    states: [],
    resyncs: 0,
    refreshCalls: () => refreshes,
    signedOut: () => signedOut,
  };
  realtime.onBooking((event) => driver.events.push(event));
  realtime.onState((state) => driver.states.push(state));
  realtime.onResync(() => {
    driver.resyncs++;
  });
  return driver;
}

async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connected(driver: Driver): Promise<void> {
  driver.realtime.start();
  await until('the socket to be live', () => driver.realtime.state === 'live');
}

async function book(driver: Driver) {
  const created = await driver.api.createBooking(
    bookingRequest({ lotId: lot.lotId, blocks: 2, blockMinutes: 30, position: AT, plate: '' }),
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.data.booking;
}

/** The booking screen's snapshot: the booking and the version it was read at. */
async function snapshot(driver: Driver, id: string, feed: BookingFeed): Promise<number> {
  const result = await driver.api.booking(id);
  if (!result.ok) throw new Error(result.error.message);
  feed.applySnapshot(result.data.booking, result.data.lotVersion);
  return result.data.lotVersion;
}

async function applyNext(driver: Driver, feed: BookingFeed, status: string): Promise<void> {
  await until(`a pushed ${status}`, () => driver.events.some((e) => e.status === status));
  for (const event of driver.events.splice(0)) feed.applyEvent(event);
}

describe('changes someone else makes reach the driver, pushed', () => {
  it("check-in, check-out and cash: the booking's whole life, each newer than the snapshot", async () => {
    const driver = await driverApp('+251911000801');
    await connected(driver);
    const booking = await book(driver);
    const feed = new BookingFeed(booking.id);
    const at = await snapshot(driver, booking.id, feed);

    // The version the snapshot carries is the lot's, read with the row.
    const lotRow = await t.db.db
      .selectFrom('lots')
      .select('version')
      .where('id', '=', lot.lotId)
      .executeTakeFirstOrThrow();
    expect(at).toBe(lotRow.version);

    expect(
      (
        await request(t.app)
          .post('/v1/staff/check-in')
          .set(attendant.header)
          .send({ code: booking.shortCode })
      ).status,
    ).toBe(200);
    await applyNext(driver, feed, 'CHECKED_IN');
    expect(feed.booking?.status).toBe('CHECKED_IN');
    expect(feed.booking?.plannedEndAt).toBe('2026-03-01T09:00:00.000Z');
    expect(feed.lotVersion).toBeGreaterThan(at);

    await request(t.app).post(`/v1/staff/bookings/${booking.id}/check-out`).set(attendant.header);
    await applyNext(driver, feed, 'CHECKED_OUT');
    const due = feed.booking?.amountDueSantim ?? 0;
    expect(due).toBeGreaterThan(0);

    await request(t.app)
      .post(`/v1/staff/bookings/${booking.id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: due });
    await applyNext(driver, feed, 'PAID');
    expect(feed.booking?.status).toBe('PAID');

    // What the feed holds is what the server has.
    const fresh = await driver.api.booking(booking.id);
    expect(fresh.ok && fresh.data.booking.status).toBe('PAID');
    expect(fresh.ok && fresh.data.lotVersion).toBe(feed.lotVersion);
  });

  it('a deposit confirmed by the webhook alone turns the booking RESERVED', async () => {
    lot = await createLot(t.db.db, { slots: 1, depositSantim: 2000, ...AT });
    const driver = await driverApp('+251911000802');
    await connected(driver);
    const booking = await book(driver);
    expect(booking.status).toBe('PENDING_PAYMENT');
    const feed = new BookingFeed(booking.id);
    await snapshot(driver, booking.id, feed);

    const payment = await t.db.db
      .selectFrom('payments')
      .select('tx_ref')
      .where('booking_id', '=', booking.id)
      .executeTakeFirstOrThrow();
    const raw = JSON.stringify({ tx_ref: payment.tx_ref, status: 'success' });
    await request(t.app)
      .post('/v1/webhooks/chapa')
      .set('Content-Type', 'application/json')
      .set('x-chapa-signature', signPayload(t.ctx.config.CHAPA_WEBHOOK_SECRET, raw))
      .send(raw);

    await applyNext(driver, feed, 'RESERVED');
    expect(feed.booking?.status).toBe('RESERVED');
  });

  it("never delivers another driver's booking", async () => {
    const mine = await driverApp('+251911000803');
    const theirs = await driverApp('+251911000804');
    await connected(mine);
    const myBooking = await book(mine);
    const theirBooking = await book(theirs);

    await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: theirBooking.shortCode });
    await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: myBooking.shortCode });

    await until('my check-in', () => mine.events.some((e) => e.status === 'CHECKED_IN'));
    expect(mine.events.map((e) => e.bookingId)).toEqual(mine.events.map(() => myBooking.id));
  });
});

describe('the token', () => {
  it('expires: the app refreshes ONCE, reconnects, resyncs, and still receives changes', async () => {
    const driver = await driverApp('+251911000805');
    await connected(driver);
    const booking = await book(driver);
    expect(driver.resyncs).toBe(1);

    // The server sends auth.expired, then disconnects: both reach the app,
    // and they must not become two refreshes of a rotating token.
    timers.advance(15 * 60_000);
    await until('a second connect', () => driver.resyncs === 2);
    expect(driver.refreshCalls()).toBe(1);
    expect(driver.states).toContain('reconnecting');
    expect(driver.realtime.state).toBe('live');

    await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: booking.shortCode });
    await until('the check-in, on the new socket', () =>
      driver.events.some((e) => e.status === 'CHECKED_IN'),
    );
  });

  it('cannot be refreshed: the socket goes offline, and the app is signed out', async () => {
    const driver = await driverApp('+251911000806');
    await connected(driver);
    await t.db.db.updateTable('refresh_tokens').set({ revoked_at: t.clock.now() }).execute();

    timers.advance(15 * 60_000);
    await until('offline', () => driver.realtime.state === 'offline');
    expect(driver.signedOut()).toBe(true);
  });
});
