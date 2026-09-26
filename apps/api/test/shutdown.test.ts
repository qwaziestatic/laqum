import { createServer, type Server as HttpServer } from 'node:http';
import express from 'express';
import { sql } from 'kysely';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRealtimeServer, type RealtimeServer } from '../src/realtime/server.js';
import { gracefulShutdown } from '../src/shutdown.js';
import { makeActor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, testLogger, truncateAll } from './helpers/db.js';
import { listenForFetch } from './helpers/listen.js';

/**
 * GRACEFUL SHUTDOWN, in process, with a real HTTP server, a real socket
 * connected, a request in flight and a job running.
 *
 * The bug this replaces: the old order closed the HTTP server and waited for
 * it before closing the sockets, but an open WebSocket keeps server.close()
 * from ever calling back, so shutdown always ended at the forced exit(1).
 * The test named "with a socket connected" is the one that fails under it.
 *
 * Signals themselves are covered by server-startup.test.ts on Linux: on
 * Windows, Node cannot deliver SIGTERM to a child, it terminates it.
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
});

interface Rig {
  http: HttpServer;
  port: number;
  realtime: RealtimeServer;
  order: string[];
  /** Resolves with the code the shutdown exited with. */
  exited: Promise<number>;
  shutdown: (signal: string) => Promise<void>;
  /** Lets the slow request answer. */
  releaseRequest: () => void;
  /** Resolves once the slow request is inside its handler. */
  requestStarted: Promise<void>;
  /** Lets the running job finish. */
  finishJob: () => void;
  draining: () => boolean;
}

async function rig(timeoutMs = 10_000): Promise<Rig> {
  const order: string[] = [];
  let draining = false;
  let releaseRequest = (): void => undefined;
  let markStarted = (): void => undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  // A request that is still running when shutdown begins, and that needs the
  // database AFTER it has begun.
  const outer = express();
  outer.get('/slow', (_req, res, next) => {
    markStarted();
    void released
      .then(async () => {
        const row = await sql<{ one: number }>`select 1 as one`.execute(t.db.db);
        order.push('slow request answered');
        res.json({ one: row.rows[0]?.one });
      })
      .catch(next);
  });
  outer.use(createApp(t.ctx, { isDraining: () => draining }));

  const http = createServer(outer);
  const realtime = createRealtimeServer(http, {
    db: t.db.db,
    config: t.ctx.config,
    clock: t.ctx.clock,
    logger: t.ctx.logger,
  });
  const port = await listenForFetch(http);

  let finishJob = (): void => undefined;
  const jobDone = new Promise<void>((resolve) => {
    finishJob = resolve;
  });

  let exit = (_code: number): void => undefined;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });

  const shutdown = gracefulShutdown({
    server: http,
    realtime: {
      close: async () => {
        order.push('sockets cut');
        await realtime.close();
      },
    },
    workers: {
      close: async () => {
        // BullMQ's Worker.close() waits for the job it is running.
        await jobDone;
        order.push('workers closed');
      },
    },
    scheduler: {
      close: () => {
        order.push('scheduler closed');
        return Promise.resolve();
      },
    },
    // The real pool stays open for the other tests; its closing is recorded.
    db: {
      destroy: () => {
        order.push('database closed');
        return Promise.resolve();
      },
    },
    redis: [
      {
        disconnect: () => {
          order.push('redis closed');
        },
      },
    ],
    logger: testLogger(),
    timeoutMs,
    drain: () => {
      draining = true;
      order.push('draining');
    },
    exit: (code) => {
      exit(code);
    },
  });

  return {
    http,
    port,
    realtime,
    order,
    exited,
    shutdown,
    releaseRequest,
    requestStarted,
    finishJob,
    draining: () => draining,
  };
}

function connectSocket(port: number, token: string): Promise<ClientSocket> {
  const socket = ioClient(`http://127.0.0.1:${String(port)}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });
}

describe('a graceful shutdown', () => {
  it('with a socket connected, a request in flight and a job running, finishes all three and exits 0', async () => {
    const r = await rig();
    const driver = await makeActor(t, 'driver');
    const socket = await connectSocket(r.port, driver.token);
    const socketGone = new Promise<string>((resolve) => {
      socket.on('disconnect', resolve);
    });

    const inFlight = fetch(`http://127.0.0.1:${String(r.port)}/slow`);
    await r.requestStarted;

    const began = Date.now();
    const done = r.shutdown('SIGTERM');

    // The socket is let go at once, so it cannot hold the server open. As a
    // TRANSPORT close, which Socket.io clients reconnect after by themselves;
    // after an "io server disconnect" they would stay disconnected.
    expect(await socketGone).toBe('transport close');

    // The request and the job finish after shutdown began.
    setTimeout(() => {
      r.releaseRequest();
      r.finishJob();
    }, 150);
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ one: 1 });

    expect(await r.exited).toBe(0);
    await done;
    // Well inside the deadline: nothing lingers until a keep-alive timeout.
    expect(Date.now() - began).toBeLessThan(2_000);

    // Draining first, the database and Redis last, after the request needed them.
    expect(r.order[0]).toBe('draining');
    expect(r.order.indexOf('sockets cut')).toBeLessThan(r.order.indexOf('slow request answered'));
    expect(r.order.indexOf('workers closed')).toBeLessThan(r.order.indexOf('database closed'));
    expect(r.order.indexOf('slow request answered')).toBeLessThan(
      r.order.indexOf('database closed'),
    );
    expect(r.order.at(-1)).toBe('redis closed');
  });

  it('refuses new connections once it has begun', async () => {
    const r = await rig();
    const inFlight = fetch(`http://127.0.0.1:${String(r.port)}/slow`);
    await r.requestStarted;
    const done = r.shutdown('SIGTERM');
    await expect(fetch(`http://127.0.0.1:${String(r.port)}/health`)).rejects.toThrow();
    r.releaseRequest();
    r.finishJob();
    await inFlight;
    await done;
  });

  it('runs once, however many signals arrive', async () => {
    const r = await rig();
    r.releaseRequest();
    r.finishJob();
    await Promise.all([r.shutdown('SIGTERM'), r.shutdown('SIGINT'), r.shutdown('SIGTERM')]);
    expect(r.order.filter((step) => step === 'draining')).toHaveLength(1);
  });

  it('cuts every connection and exits 1 when the deadline passes', async () => {
    const r = await rig(300);
    const inFlight = fetch(`http://127.0.0.1:${String(r.port)}/slow`).then(
      () => 'answered',
      () => 'cut',
    );
    await r.requestStarted;
    r.finishJob();
    void r.shutdown('SIGTERM');
    // The request never answers by itself.
    expect(await r.exited).toBe(1);
    expect(await inFlight).toBe('cut');
    r.releaseRequest();
  });
});

describe('while draining', () => {
  it('answers /ready with 503, so a proxy sends nothing new', async () => {
    let draining = false;
    const app = createApp(t.ctx, { isDraining: () => draining });
    expect((await request(app).get('/ready')).status).toBe(200);
    draining = true;
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'draining', checks: {} });
    // Liveness is unaffected: the process is fine, only leaving.
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
