import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SUBSCRIBE_EVENT, type SubscribedAck } from '@laqum/shared';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.js';
import {
  AUTH_EXPIRED_EVENT,
  createRealtimeServer,
  type RealtimeServer,
} from '../src/realtime/server.js';
import { ManualTimers } from '../src/realtime/timers.js';
import { makeActor, staffLot } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * SOCKET AUTHORIZATION MUST NOT OUTLIVE ITS BASIS.
 *
 * Two independent things can make a live socket's authority stale: the token
 * it was opened with can expire, and the lot_staff row it relied on can be
 * deleted. A socket, unlike an HTTP request, does not re-derive either one by
 * itself. These tests pin both, plus the fail-closed dev token.
 */

let t: TestContext;
let http: HttpServer;
let realtime: RealtimeServer;
let timers: ManualTimers;
let port: number;
let lot: LotFixture;
const openSockets: ClientSocket[] = [];

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.clock.set('2026-03-01T08:00:00.000Z');
  lot = await createLot(t.db.db, { slots: 3, depositSantim: 0 });

  timers = new ManualTimers();
  http = createServer();
  realtime = createRealtimeServer(http, {
    db: t.db.db,
    config: t.ctx.config,
    clock: t.ctx.clock,
    logger: t.ctx.logger,
    timers,
  });
  await new Promise<void>((resolve) => {
    http.listen(0, resolve);
  });
  port = (http.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.disconnect();
  await realtime.close();
  await new Promise<void>((resolve) => {
    http.close(() => {
      resolve();
    });
  });
});

/** Connect, resolving on success and REJECTING with the server's reason. */
function connect(token: string | undefined): Promise<ClientSocket> {
  const socket = ioClient(`http://localhost:${port}`, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    // These tests assert on the FIRST outcome; a retry would mask a refusal.
    reconnection: false,
  });
  openSockets.push(socket);

  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', (err: Error) => {
      reject(err);
    });
  });
}

function subscribe(
  socket: ClientSocket,
  lotId: string,
  audience: 'staff' | 'public',
): Promise<{ ok: true; data: SubscribedAck } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    socket.emit(SUBSCRIBE_EVENT, { lotId, audience }, resolve);
  });
}

function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

describe('handshake', () => {
  it('refuses a connection with no token', async () => {
    await expect(connect(undefined)).rejects.toThrow('NO_TOKEN');
  });

  it('refuses a garbage token', async () => {
    await expect(connect('not-a-jwt')).rejects.toThrow('BAD_TOKEN');
  });

  it('refuses a token signed with the wrong secret', async () => {
    const other = await makeActor(t, 'attendant');
    const forged = await signAccessToken(
      { ...t.ctx.config, JWT_ACCESS_SECRET: 'a-different-secret-that-is-long-enough' },
      t.ctx.clock,
      { userId: other.userId, role: 'attendant' },
    );
    await expect(connect(forged.token)).rejects.toThrow('BAD_TOKEN');
  });

  it('refuses a token that has ALREADY expired', async () => {
    const actor = await makeActor(t, 'attendant');
    // Past the 15-minute access TTL, on the injected clock.
    t.clock.advanceMs(20 * 60_000);
    await expect(connect(actor.token)).rejects.toThrow('BAD_TOKEN');
  });

  it('accepts a valid token', async () => {
    const actor = await makeActor(t, 'attendant');
    const socket = await connect(actor.token);
    expect(socket.connected).toBe(true);
  });
});

describe('the socket dies with its token', () => {
  it('disconnects at the moment the access token expires', async () => {
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, lot.lotId);
    const socket = await connect(actor.token);

    expect(await subscribe(socket, lot.lotId, 'staff')).toMatchObject({ ok: true });
    expect(socket.connected).toBe(true);

    const expired = nextEvent<{ reason: string }>(socket, AUTH_EXPIRED_EVENT);
    const closed = nextEvent<string>(socket, 'disconnect');

    // One tick short of the TTL: still authorised.
    timers.advance(15 * 60_000 - 1);
    expect(socket.connected).toBe(true);

    timers.advance(1);

    // Told WHY before being cut off, so the client refreshes its token
    // instead of treating this as a network failure and backing off.
    expect(await expired).toEqual({ reason: 'ACCESS_TOKEN_EXPIRED' });
    await closed;
    expect(socket.connected).toBe(false);
  }, 20_000);

  it('arms the timer from the token, not from a fixed interval', async () => {
    // A token issued 10 minutes ago has 5 minutes of its 15 left. The socket
    // must die at ITS expiry, not 15 minutes after connecting.
    const actor = await makeActor(t, 'attendant');
    t.clock.advanceMs(10 * 60_000);

    const socket = await connect(actor.token);
    const closed = nextEvent<string>(socket, 'disconnect');

    timers.advance(5 * 60_000 - 1);
    expect(socket.connected).toBe(true);

    timers.advance(1);
    await closed;
    expect(socket.connected).toBe(false);
  }, 20_000);

  it('cancels the timer when the socket disconnects first', async () => {
    const actor = await makeActor(t, 'attendant');
    const socket = await connect(actor.token);
    expect(timers.pendingCount).toBe(1);

    socket.disconnect();
    // The server must notice; poll the timer count rather than sleeping.
    for (let i = 0; i < 100 && timers.pendingCount > 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(timers.pendingCount, 'a closed socket must not leave a timer behind').toBe(0);
  }, 20_000);
});

describe('lot_staff is re-checked on every subscribe', () => {
  it('lets an assigned attendant into the staff room', async () => {
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, lot.lotId);
    const socket = await connect(actor.token);

    const result = await subscribe(socket, lot.lotId, 'staff');
    expect(result).toMatchObject({ ok: true, data: { audience: 'staff', lotId: lot.lotId } });
  });

  it('refuses an attendant who staffs a DIFFERENT lot', async () => {
    const other = await createLot(t.db.db, { name: 'Elsewhere', slots: 1, depositSantim: 0 });
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, other.lotId);

    const socket = await connect(actor.token);
    expect(await subscribe(socket, lot.lotId, 'staff')).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('refuses a driver the staff audience outright', async () => {
    const driver = await makeActor(t, 'driver');
    const socket = await connect(driver.token);
    expect(await subscribe(socket, lot.lotId, 'staff')).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  /**
   * THE case. Authorisation granted at subscribe #1 must not still hold at
   * subscribe #2 once the grounds for it are gone — on the SAME socket, with
   * no reconnect in between, which is the situation a handshake-time cache
   * would get wrong.
   */
  it('refuses a RE-subscribe after the lot_staff row is deleted', async () => {
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, lot.lotId);
    const socket = await connect(actor.token);

    expect(await subscribe(socket, lot.lotId, 'staff')).toMatchObject({ ok: true });

    // Sacked, mid-shift, while the socket stays open.
    await t.db.db
      .deleteFrom('lot_staff')
      .where('user_id', '=', actor.userId)
      .where('lot_id', '=', lot.lotId)
      .execute();

    expect(await subscribe(socket, lot.lotId, 'staff')).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  /** The same rule, reached the way it happens in production: a reconnect. */
  it('refuses the staff room after a RECONNECT once membership is gone', async () => {
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, lot.lotId);

    const first = await connect(actor.token);
    expect(await subscribe(first, lot.lotId, 'staff')).toMatchObject({ ok: true });
    first.disconnect();

    await t.db.db.deleteFrom('lot_staff').where('user_id', '=', actor.userId).execute();

    // The token is still perfectly valid — only the membership changed.
    const second = await connect(actor.token);
    expect(await subscribe(second, lot.lotId, 'staff')).toEqual({ ok: false, error: 'FORBIDDEN' });
  }, 20_000);

  it('still allows the public audience to anyone signed in', async () => {
    const driver = await makeActor(t, 'driver');
    const socket = await connect(driver.token);
    expect(await subscribe(socket, lot.lotId, 'public')).toMatchObject({
      ok: true,
      data: { audience: 'public' },
    });
  });

  it('rejects a malformed subscribe without disconnecting the socket', async () => {
    const driver = await makeActor(t, 'driver');
    const socket = await connect(driver.token);

    expect(await subscribe(socket, 'not-a-uuid', 'public')).toEqual({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
    expect(socket.connected).toBe(true);
  });

  it('carries the lot version in the subscribe ack', async () => {
    const driver = await makeActor(t, 'driver');
    const socket = await connect(driver.token);

    const result = await subscribe(socket, lot.lotId, 'public');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.data.lotVersion).toBe(0);
  });
});

describe('room membership is corrected, not merely added to', () => {
  it('leaves the staff room when the same socket re-subscribes as public', async () => {
    const actor = await makeActor(t, 'attendant');
    await staffLot(t, actor, lot.lotId);
    const socket = await connect(actor.token);

    await subscribe(socket, lot.lotId, 'staff');
    await subscribe(socket, lot.lotId, 'public');

    // Asked of the server, not inferred from the client.
    const sockets = await realtime.io.in(`lot:${lot.lotId}:staff`).fetchSockets();
    expect(sockets, 'a downgraded socket must not stay in the staff room').toHaveLength(0);
    expect(await realtime.io.in(`lot:${lot.lotId}:public`).fetchSockets()).toHaveLength(1);
  });
});
