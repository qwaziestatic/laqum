import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { RealtimeStore, SOCKET_RATE_LIMITED, type ConnectionState } from '@laqum/shared';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient as DashboardApi } from '../../dashboard/src/api/client.js';
import { RealtimeConnection } from '../../dashboard/src/realtime/connection.js';
import { DriverRealtime } from '../../mobile/src/realtime/connection.js';
import { signAccessToken } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { createRealtimeServer, type RealtimeServer } from '../src/realtime/server.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, createUser } from './helpers/fixtures.js';
import { listenForFetch } from './helpers/listen.js';

/**
 * SOCKET CONNECTION LIMITS THAT SURVIVE A RECONNECT STORM FROM ONE ADDRESS.
 *
 * CI #23: the first design, 30 connections per IP per minute, locked the e2e
 * suite out (one address, ~24 sign-ins a minute). The production version of
 * that failure is worse: Ethio telecom puts many phones behind one carrier
 * (CGNAT) address, and after every deploy or restart EVERY client reconnects
 * at once. And a refusal is terminal for socket.io-client (a middleware
 * refusal destroys the socket), so a refused client stayed on "reconnecting"
 * for good.
 *
 * Now: a loose flood guard per address, the real limit per user, a refusal
 * that says when to come back, and clients that do, with jitter.
 */

/**
 * The limits production ships with, read from the config's own defaults (not
 * the test context's out-of-the-way ones), so lowering them breaks the storm.
 */
const shipped = loadConfig({ DATABASE_URL: 'postgres://x@localhost/x', REDIS_URL: 'redis://x' });
const DEFAULTS = {
  RATE_LIMIT_SOCKET_CONNECTIONS_PER_IP_PER_MINUTE: String(
    shipped.RATE_LIMIT_SOCKET_CONNECTIONS_PER_IP_PER_MINUTE,
  ),
  RATE_LIMIT_SOCKET_CONNECTIONS_PER_USER_PER_MINUTE: String(
    shipped.RATE_LIMIT_SOCKET_CONNECTIONS_PER_USER_PER_MINUTE,
  ),
};

interface Stack {
  t: TestContext;
  http: HttpServer;
  realtime: RealtimeServer;
  url: string;
}

let stack: Stack | null = null;
const clients: ClientSocket[] = [];

async function start(limits: Record<string, string>): Promise<Stack> {
  const t = await createTestContext({ config: { ...limits, DEV_AUTH: 'true' } });
  await truncateAll(t.db.db);
  await t.redis.flushdb();
  const http = createServer(t.app);
  const realtime = createRealtimeServer(http, {
    db: t.db.db,
    config: t.ctx.config,
    clock: t.ctx.clock,
    logger: t.ctx.logger,
    rateLimiter: t.ctx.rateLimiter,
  });
  const port = await listenForFetch(http);
  stack = { t, http, realtime, url: `http://127.0.0.1:${String(port)}` };
  return stack;
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  if (stack) {
    await stack.realtime.close();
    await stack.t.close();
    stack = null;
  }
});

beforeAll(async () => {
  await migrateFresh();
}, 60_000);

function tokenFor(s: Stack, userId = randomUUID()): Promise<string> {
  return signAccessToken(s.t.ctx.config, s.t.clock, { userId, role: 'driver' }).then(
    (signed) => signed.token,
  );
}

/** One client as the apps configure theirs: reconnecting, with jitter. */
function client(s: Stack, token: string, reconnection: boolean): ClientSocket {
  const socket = ioClient(s.url, {
    auth: { token },
    transports: ['websocket'],
    reconnection,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });
  clients.push(socket);
  return socket;
}

/** The first answer: 'connected', or the refusal's reason and data. */
function firstAnswer(socket: ClientSocket): Promise<{ reason: string; data?: unknown }> {
  return new Promise((resolve) => {
    socket.once('connect', () => {
      resolve({ reason: 'connected' });
    });
    socket.once('connect_error', (err: Error & { data?: unknown }) => {
      resolve({ reason: err.message, data: err.data });
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('a reconnect storm from one carrier address, after a restart', () => {
  const PHONES = 200;

  it('reconnects every phone, with none refused', async () => {
    const s = await start(DEFAULTS);
    s.t.clock.set('2026-03-01T08:00:00.000Z');
    const tokens = await Promise.all(Array.from({ length: PHONES }, () => tokenFor(s)));

    // 200 drivers, every one behind the same address (all 127.0.0.1 here).
    const sockets = tokens.map((token) => client(s, token, true));
    let refused = 0;
    for (const socket of sockets) {
      socket.on('connect_error', (err: Error) => {
        if (err.message === SOCKET_RATE_LIMITED) refused += 1;
      });
    }
    await waitFor(() => sockets.every((c) => c.connected), 20_000, 'the first connections');

    // The restart: every connection cut at once, as when the process goes
    // away. Clients see a transport close and reconnect by themselves.
    const reconnected = sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.io.once('reconnect', () => {
            resolve();
          });
        }),
    );
    for (const socket of s.realtime.io.of('/').sockets.values()) socket.conn.close();
    await Promise.all(reconnected);
    await waitFor(() => sockets.every((c) => c.connected), 20_000, 'every phone back');

    expect(refused).toBe(0);
    expect(s.realtime.io.of('/').sockets.size).toBe(PHONES);
  }, 60_000);

  it('would strand most of them under the first design, 30 per address', async () => {
    const s = await start({
      ...DEFAULTS,
      RATE_LIMIT_SOCKET_CONNECTIONS_PER_IP_PER_MINUTE: '30',
    });
    s.t.clock.set('2026-03-01T08:00:00.000Z');
    const tokens = await Promise.all(Array.from({ length: PHONES }, () => tokenFor(s)));
    const answers = await Promise.all(tokens.map((token) => firstAnswer(client(s, token, false))));
    const refused = answers.filter((a) => a.reason === SOCKET_RATE_LIMITED).length;
    // Why the design changed: 170 of 200 drivers locked out.
    expect(refused).toBe(PHONES - 30);
  }, 60_000);
});

describe('the limit that is left: per signed-in user', () => {
  it('refuses a user over it, says when to come back, and leaves others alone', async () => {
    const s = await start({ ...DEFAULTS, RATE_LIMIT_SOCKET_CONNECTIONS_PER_USER_PER_MINUTE: '2' });
    s.t.clock.set('2026-03-01T08:00:10.000Z');
    const busy = randomUUID();
    const token = await tokenFor(s, busy);

    expect((await firstAnswer(client(s, token, false))).reason).toBe('connected');
    expect((await firstAnswer(client(s, token, false))).reason).toBe('connected');
    const refused = await firstAnswer(client(s, token, false));
    expect(refused.reason).toBe(SOCKET_RATE_LIMITED);
    // 08:00:10 → the window ends at 08:01:00.
    expect(refused.data).toEqual({ retryAfterMs: 50_000 });

    // Someone else, from the very same address, is not affected.
    expect((await firstAnswer(client(s, await tokenFor(s), false))).reason).toBe('connected');
  });
});

describe('the flood guard per address', () => {
  it('refuses a flood before the token is even looked at', async () => {
    const s = await start({ ...DEFAULTS, RATE_LIMIT_SOCKET_CONNECTIONS_PER_IP_PER_MINUTE: '2' });
    const answers = [];
    for (let i = 0; i < 3; i++)
      answers.push((await firstAnswer(client(s, 'not-a-token', false))).reason);
    expect(answers).toEqual(['BAD_TOKEN', 'BAD_TOKEN', SOCKET_RATE_LIMITED]);
  });
});

describe('a refused client comes back by itself', () => {
  const PHONE = '+251911000301';

  it('the dashboard: "reconnecting", then live again once the window allows', async () => {
    const s = await start({ ...DEFAULTS, RATE_LIMIT_SOCKET_CONNECTIONS_PER_USER_PER_MINUTE: '1' });
    // One second before the window ends, so the retry (1-2 s) lands in the next.
    s.t.clock.set('2026-03-01T08:00:59.000Z');
    const userId = await createUser(s.t.db.db, 'attendant', PHONE);
    const lot = await createLot(s.t.db.db, { slots: 2 });
    await s.t.db.db
      .insertInto('lot_staff')
      .values({ lot_id: lot.lotId, user_id: userId })
      .execute();
    const api = new DashboardApi({ baseUrl: `${s.url}/v1` });
    const signedIn = await api.devLogin(PHONE);
    if (!signedIn.ok) throw new Error('dev sign-in failed');
    // As App.tsx does: the client keeps the session it is given.
    api.setSession(signedIn.data);

    const first = new RealtimeStore();
    const firstConnection = new RealtimeConnection({
      api,
      store: first,
      lotId: lot.lotId,
      url: s.url,
    });
    firstConnection.start();
    await waitFor(() => first.getState().connection === 'live', 10_000, 'the first connection');
    firstConnection.close();

    // Over the limit: refused, and it says so rather than going silent.
    const store = new RealtimeStore();
    const seen: ConnectionState[] = [];
    store.subscribe((state) => {
      if (seen.at(-1) !== state.connection) seen.push(state.connection);
    });
    const connection = new RealtimeConnection({ api, store, lotId: lot.lotId, url: s.url });
    connection.start();
    await waitFor(() => seen.includes('reconnecting'), 10_000, 'the refusal');
    s.t.clock.advanceMinutes(1);
    // Before this change it stayed on "reconnecting" for good.
    await waitFor(() => store.getState().connection === 'live', 10_000, 'live again');
    connection.close();
    expect(seen).toContain('reconnecting');
  }, 30_000);

  it('the driver app: the same, without waiting for the app to be reopened', async () => {
    const s = await start({ ...DEFAULTS, RATE_LIMIT_SOCKET_CONNECTIONS_PER_USER_PER_MINUTE: '1' });
    s.t.clock.set('2026-03-01T08:00:59.000Z');
    const token = await tokenFor(s);
    const driver = (): DriverRealtime =>
      new DriverRealtime({
        url: s.url,
        io: ioClient,
        token: () => token,
        refresh: () => Promise.resolve(true),
      });

    const first = driver();
    first.start();
    await waitFor(() => first.state === 'live', 10_000, 'the first connection');
    first.close();

    const second = driver();
    const states: string[] = [];
    second.onState((state) => states.push(state));
    second.start();
    await waitFor(() => states.includes('reconnecting'), 10_000, 'the refusal');
    s.t.clock.advanceMinutes(1);
    await waitFor(() => second.state === 'live', 10_000, 'live again');
    second.close();
  }, 30_000);
});
