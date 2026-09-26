import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Redis } from 'ioredis';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { clientAddress } from '../src/clientAddress.js';
import { createRealtimeServer, type RealtimeServer } from '../src/realtime/server.js';
import { makeActor, staffLot, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot } from './helpers/fixtures.js';

/**
 * RATE LIMITS (Phase 5), at the product owner's starting numbers, here set
 * low so each edge is reached in a few requests. Per USER wherever there is
 * one, per IP only before sign-in. Counted on the frozen test clock: a window
 * rolls over when the test moves time, never by sleeping.
 */

const LIMITS = {
  RATE_LIMIT_GENERAL_PER_MINUTE: '6',
  RATE_LIMIT_BOOKING_WRITES_PER_MINUTE: '2',
  RATE_LIMIT_STAFF_ACTIONS_PER_MINUTE: '3',
  RATE_LIMIT_OTP_VERIFY_PER_IP: '2',
  RATE_LIMIT_SOCKET_CONNECTIONS_PER_MINUTE: '2',
};

let t: TestContext;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext({ config: LIMITS });
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  await t.redis.flushdb();
  t.clock.set('2026-03-01T08:00:10.000Z');
});

const NO_SUCH_BOOKING = '00000000-0000-4000-8000-000000000000';
const code = (res: { body: unknown }): string | undefined =>
  (res.body as { error?: { code?: string } }).error?.code;

function cancel(actor: Actor) {
  return request(t.app).post(`/v1/bookings/${NO_SUCH_BOOKING}/cancel`).set(actor.header);
}

describe('booking changes: per user, per minute', () => {
  it('refuses the one over the limit, with Retry-After to the end of the window', async () => {
    const driver = await makeActor(t, 'driver');
    for (let i = 0; i < 2; i++) expect(code(await cancel(driver))).not.toBe('RATE_LIMITED');

    const refused = await cancel(driver);
    expect(refused.status).toBe(429);
    expect(code(refused)).toBe('RATE_LIMITED');
    // 08:00:10 → the window ends at 08:01:00.
    expect(refused.headers['retry-after']).toBe('50');
  });

  it('counts each driver separately: one busy driver never blocks another', async () => {
    const busy = await makeActor(t, 'driver');
    const other = await makeActor(t, 'driver');
    for (let i = 0; i < 3; i++) await cancel(busy);
    expect(code(await cancel(other))).not.toBe('RATE_LIMITED');
  });

  it('lets the same driver through again in the next window', async () => {
    const driver = await makeActor(t, 'driver');
    for (let i = 0; i < 3; i++) await cancel(driver);
    t.clock.advanceMinutes(1);
    expect(code(await cancel(driver))).not.toBe('RATE_LIMITED');
  });

  it('applies to book, cancel, extend, pay and the deposit, and not to reads', async () => {
    const driver = await makeActor(t, 'driver');
    const writes = [
      () => request(t.app).post('/v1/bookings').set(driver.header).send({}),
      () =>
        request(t.app)
          .post(`/v1/bookings/${NO_SUCH_BOOKING}/extend`)
          .set(driver.header)
          .send({ additionalBlocks: 1 }),
      () => request(t.app).post(`/v1/bookings/${NO_SUCH_BOOKING}/pay`).set(driver.header),
      () => request(t.app).post(`/v1/bookings/${NO_SUCH_BOOKING}/deposit`).set(driver.header),
    ];
    for (const write of writes) {
      await t.redis.flushdb();
      await write();
      await write();
      expect(code(await write())).toBe('RATE_LIMITED');
    }
    await t.redis.flushdb();
    for (let i = 0; i < 4; i++) {
      const read = await request(t.app).get(`/v1/bookings/${NO_SUCH_BOOKING}`).set(driver.header);
      expect(code(read)).not.toBe('RATE_LIMITED');
    }
  });
});

describe('staff actions: per attendant, per minute', () => {
  it('limits actions and leaves the lot view alone', async () => {
    const lot = await createLot(t.db.db, { slots: 1 });
    const attendant = await makeActor(t, 'attendant');
    await staffLot(t, attendant, lot.lotId);
    const act = () =>
      request(t.app).post('/v1/staff/check-in').set(attendant.header).send({ code: 'ZZZZZZ' });

    for (let i = 0; i < 3; i++) expect(code(await act())).not.toBe('RATE_LIMITED');
    expect(code(await act())).toBe('RATE_LIMITED');

    // Reading the lot is not an action.
    const view = await request(t.app)
      .get(`/v1/staff/lots/${lot.lotId}/slots`)
      .set(attendant.header);
    expect(code(view)).not.toBe('RATE_LIMITED');
  });
});

describe('OTP verification: per address', () => {
  it('limits attempts across numbers, on top of each code’s own five', async () => {
    const verify = (i: number) =>
      request(t.app)
        .post('/v1/auth/otp/verify')
        .send({ phone: `+25191100${String(1000 + i)}`, code: '000000' });
    for (let i = 0; i < 2; i++) expect(code(await verify(i))).not.toBe('RATE_LIMITED');
    const refused = await verify(9);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
  });
});

describe('the general limit', () => {
  it('counts a signed-in user by user, not by address', async () => {
    const a = await makeActor(t, 'driver');
    const b = await makeActor(t, 'driver');
    const read = (actor: Actor) => request(t.app).get('/v1/bookings/current').set(actor.header);
    for (let i = 0; i < 6; i++) await read(a);
    expect(code(await read(a))).toBe('RATE_LIMITED');
    // Same address (every supertest request is 127.0.0.1), another user.
    expect(code(await read(b))).not.toBe('RATE_LIMITED');
  });

  it('counts by address before sign-in', async () => {
    const refresh = () => request(t.app).post('/v1/auth/refresh').send({ refreshToken: 'x' });
    for (let i = 0; i < 6; i++) expect(code(await refresh())).not.toBe('RATE_LIMITED');
    expect(code(await refresh())).toBe('RATE_LIMITED');
  });

  it('never limits the probes or the payment webhook', async () => {
    const anonymous = () => request(t.app).post('/v1/auth/refresh').send({ refreshToken: 'x' });
    for (let i = 0; i < 7; i++) await anonymous();
    expect(code(await anonymous())).toBe('RATE_LIMITED');

    for (let i = 0; i < 10; i++) {
      expect((await request(t.app).get('/health')).status).toBe(200);
      const hook = await request(t.app)
        .post('/v1/webhooks/chapa')
        .set('content-type', 'application/json')
        .send('{}');
      expect(hook.status, 'webhook').not.toBe(429);
    }
  });
});

describe('when Redis cannot be reached', () => {
  let down: Redis;
  beforeAll(() => {
    // Nothing listens on port 1; offline queue off, so every command fails at once.
    down = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
  });
  afterAll(() => {
    down.disconnect();
  });

  const withRedisDown = () =>
    createApp({ ...t.ctx, rateLimiter: new RateLimiter({ redis: down, clock: t.clock }) });

  it('lets bookings and reads through: a Redis blip must not stop the lot', async () => {
    const app = withRedisDown();
    const driver = await makeActor(t, 'driver');
    const res = await request(app).get('/v1/bookings/current').set(driver.header);
    expect(res.status).not.toBe(500);
    expect(code(res)).not.toBe('RATE_LIMITED');
  });

  it('refuses OTP verification rather than let codes be guessed freely', async () => {
    const app = withRedisDown();
    const res = await request(app)
      .post('/v1/auth/otp/verify')
      .send({ phone: '+251911001234', code: '000000' });
    expect(res.status).toBe(500);
  });
});

describe('Socket.io connections: per client address', () => {
  let http: HttpServer;
  let realtime: RealtimeServer;
  let port: number;
  const sockets: ClientSocket[] = [];

  beforeEach(async () => {
    http = createServer();
    realtime = createRealtimeServer(http, {
      db: t.db.db,
      config: t.ctx.config,
      clock: t.ctx.clock,
      logger: t.ctx.logger,
      rateLimiter: t.ctx.rateLimiter,
    });
    await new Promise<void>((resolve) => {
      http.listen(0, resolve);
    });
    port = (http.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await realtime.close();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  /** The server's first answer: 'connected', or its refusal reason. */
  function attempt(token: string): Promise<string> {
    const socket = ioClient(`http://localhost:${String(port)}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    return new Promise((resolve) => {
      socket.on('connect', () => {
        resolve('connected');
      });
      socket.on('connect_error', (err: Error) => {
        resolve(err.message);
      });
    });
  }

  it('refuses the connection over the limit, before looking at the token', async () => {
    const driver = await makeActor(t, 'driver');
    expect(await attempt(driver.token)).toBe('connected');
    expect(await attempt(driver.token)).toBe('connected');
    expect(await attempt(driver.token)).toBe('RATE_LIMITED');
    // Even a bad token is counted and refused for rate first.
    expect(await attempt('not-a-token')).toBe('RATE_LIMITED');

    t.clock.advanceMinutes(1);
    expect(await attempt(driver.token)).toBe('connected');
  });
});

describe('the client address a socket is counted by', () => {
  /** What Express says req.ip is, for the same peer and header. */
  async function expressSays(hops: number, forwardedFor: string | undefined): Promise<string> {
    const app = express();
    app.set('trust proxy', hops);
    app.get('/', (req, res) => {
      res.json({ ip: req.ip, remote: req.socket.remoteAddress });
    });
    const req = request(app).get('/');
    const res = await (forwardedFor === undefined ? req : req.set('X-Forwarded-For', forwardedFor));
    const body = res.body as { ip: string; remote: string };
    expect(
      clientAddress(body.remote, forwardedFor, hops),
      `${String(hops)} / ${String(forwardedFor)}`,
    ).toBe(body.ip);
    return body.ip;
  }

  it('matches Express’s req.ip for every proxy count and header shape', async () => {
    for (const hops of [0, 1, 2, 3]) {
      for (const header of [
        undefined,
        '203.0.113.9',
        '6.6.6.6, 203.0.113.9',
        ' 6.6.6.6 ,203.0.113.9 ,198.51.100.1 ',
      ]) {
        await expressSays(hops, header);
      }
    }
  });

  it('reads a repeated header as one list, as Node joins it', () => {
    expect(clientAddress('10.0.0.1', ['6.6.6.6', '203.0.113.9'], 1)).toBe('203.0.113.9');
  });
});
