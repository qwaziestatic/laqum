import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { SUBSCRIBE_EVENT, type PublicSlotEvent, type StaffSlotEvent } from '@laqum/shared';
import { Redis } from 'ioredis';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SLOT_UPDATED, SocketEmitter } from '../src/realtime/emitter.js';
import { createRealtimeServer, type RealtimeServer } from '../src/realtime/server.js';
import { ManualTimers } from '../src/realtime/timers.js';
import { makeActor, staffLot } from './helpers/auth.js';
import { createTestContext, TEST_REDIS_URL, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * TWO API INSTANCES, ONE DASHBOARD.
 *
 * A dashboard holds a socket to whichever instance the load balancer gave it.
 * A slot change handled by the OTHER instance still has to reach it. Without
 * the Redis adapter, each instance broadcasts only to its own sockets, and the
 * dashboard silently stops updating for half the traffic — the worst kind of
 * bug, because it looks like it works.
 *
 * The negative test at the bottom removes the adapter and asserts the same
 * scenario fails, so this suite cannot pass for the wrong reason.
 */

let t: TestContext;
let lot: LotFixture;
const clients: ClientSocket[] = [];
const redises: Redis[] = [];
const servers: { realtime: RealtimeServer; http: HttpServer }[] = [];

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
});

/** One API instance. `withAdapter: false` is the negative case. */
async function startInstance(withAdapter: boolean): Promise<{
  port: number;
  emitter: SocketEmitter;
  realtime: RealtimeServer;
}> {
  let adapter: ReturnType<typeof createAdapter> | undefined;

  if (withAdapter) {
    // A dedicated pair per instance. The subscriber goes into subscribe mode
    // and can then serve nothing else, which is why it is never shared.
    const pubClient = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    redises.push(pubClient, subClient);
    adapter = createAdapter(pubClient, subClient);
  }

  const http = createServer();
  const realtime = createRealtimeServer(http, {
    db: t.db.db,
    config: t.ctx.config,
    clock: t.ctx.clock,
    logger: t.ctx.logger,
    timers: new ManualTimers(),
    // Spread rather than `adapter`: exactOptionalPropertyTypes means an
    // explicit `undefined` is not the same as an absent property.
    ...(adapter ? { adapter } : {}),
  });
  servers.push({ realtime, http });

  await new Promise<void>((resolve) => {
    http.listen(0, resolve);
  });

  return {
    port: (http.address() as AddressInfo).port,
    emitter: new SocketEmitter(realtime.io),
    realtime,
  };
}

async function closeAll(): Promise<void> {
  for (const client of clients.splice(0)) client.disconnect();
  for (const { realtime, http } of servers.splice(0)) {
    await realtime.close();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  }
  for (const redis of redises.splice(0)) redis.disconnect();
}

async function connectAndSubscribe(
  port: number,
  token: string,
  lotId: string,
): Promise<ClientSocket> {
  const socket = ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => {
      resolve();
    });
    socket.on('connect_error', reject);
  });

  await new Promise<void>((resolve, reject) => {
    socket.emit(SUBSCRIBE_EVENT, { lotId, audience: 'staff' }, (res: { ok: boolean }) => {
      if (res.ok) resolve();
      else reject(new Error('subscribe refused'));
    });
  });

  return socket;
}

function slotEvent(lotId: string, slotId: string, lotVersion: number): StaffSlotEvent {
  return {
    lotId,
    lotVersion,
    slotId,
    label: 'A-1',
    zone: 'A',
    gridRow: 0,
    gridCol: 0,
    appBookable: true,
    inService: true,
    displayStatus: 'occupied',
    bookingId: null,
    source: null,
    vehiclePlate: 'AA-99999',
    holdExpiresAt: null,
    plannedEndAt: null,
  };
}

/** The public payload for a staff one: the staff-only fields simply absent. */
function publicOf(staff: StaffSlotEvent): PublicSlotEvent {
  return {
    lotId: staff.lotId,
    lotVersion: staff.lotVersion,
    slotId: staff.slotId,
    label: staff.label,
    zone: staff.zone,
    gridRow: staff.gridRow,
    gridCol: staff.gridCol,
    appBookable: staff.appBookable,
    inService: staff.inService,
    displayStatus: staff.displayStatus,
  };
}

/** Resolve with the event, or with null after `ms` — no throw either way. */
function eventOrTimeout<T>(socket: ClientSocket, event: string, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * The Redis adapter's own pub/sub takes a moment to propagate. This is real
 * network I/O between two processes' worth of connections, so unlike the
 * store's ordering rules it cannot be driven by a fake clock.
 */
const CROSS_INSTANCE_MS = 3_000;
/** How long the negative case waits before concluding nothing arrived. */
const SILENCE_MS = 1_500;

describe('with the Redis adapter', () => {
  it('delivers an event emitted on instance B to a client on instance A', async () => {
    try {
      const attendant = await makeActor(t, 'attendant');
      await staffLot(t, attendant, lot.lotId);

      const a = await startInstance(true);
      const b = await startInstance(true);

      // The dashboard is on A, and never talks to B at all.
      const dashboard = await connectAndSubscribe(a.port, attendant.token, lot.lotId);
      const received = eventOrTimeout<StaffSlotEvent>(dashboard, SLOT_UPDATED, CROSS_INSTANCE_MS);

      // The change is handled by B.
      const staff = slotEvent(lot.lotId, lot.slotIds[0]!, 7);
      b.emitter.slotChanged(lot.lotId, staff, publicOf(staff));

      const event = await received;
      expect(event, 'a client on instance A must receive instance B events').not.toBeNull();
      expect(event?.slotId).toBe(lot.slotIds[0]);
      expect(event?.lotVersion).toBe(7);
    } finally {
      await closeAll();
    }
  }, 40_000);

  it('does NOT leak a staff payload to a client in the public room', async () => {
    try {
      const attendant = await makeActor(t, 'attendant');
      await staffLot(t, attendant, lot.lotId);
      const driver = await makeActor(t, 'driver');

      const a = await startInstance(true);
      const b = await startInstance(true);

      const publicSocket = ioClient(`http://localhost:${a.port}`, {
        auth: { token: driver.token },
        transports: ['websocket'],
        reconnection: false,
      });
      clients.push(publicSocket);
      await new Promise<void>((resolve, reject) => {
        publicSocket.on('connect', () => {
          resolve();
        });
        publicSocket.on('connect_error', reject);
      });
      await new Promise<void>((resolve) => {
        publicSocket.emit(SUBSCRIBE_EVENT, { lotId: lot.lotId, audience: 'public' }, () => {
          resolve();
        });
      });

      const received = eventOrTimeout<Record<string, unknown>>(
        publicSocket,
        SLOT_UPDATED,
        CROSS_INSTANCE_MS,
      );

      const staff = slotEvent(lot.lotId, lot.slotIds[0]!, 9);
      b.emitter.slotChanged(lot.lotId, staff, publicOf(staff));

      const event = await received;
      expect(event, 'the public room should still get its own payload').not.toBeNull();
      // It crossed instances AND kept its audience.
      expect(event).not.toHaveProperty('vehiclePlate');
      expect(JSON.stringify(event)).not.toContain('AA-99999');
    } finally {
      await closeAll();
    }
  }, 40_000);
});

describe('NEGATIVE: without the Redis adapter', () => {
  /**
   * The same scenario, with the adapter removed. If this ever starts passing,
   * the positive test above is passing for some other reason and is no longer
   * evidence that multi-instance delivery works.
   */
  it('does NOT deliver instance B events to a client on instance A', async () => {
    try {
      const attendant = await makeActor(t, 'attendant');
      await staffLot(t, attendant, lot.lotId);

      const a = await startInstance(false);
      const b = await startInstance(false);

      const dashboard = await connectAndSubscribe(a.port, attendant.token, lot.lotId);
      const received = eventOrTimeout<StaffSlotEvent>(dashboard, SLOT_UPDATED, SILENCE_MS);

      b.emitter.slotChanged(
        lot.lotId,
        slotEvent(lot.lotId, lot.slotIds[0]!, 7),
        slotEvent(lot.lotId, lot.slotIds[0]!, 7),
      );

      expect(
        await received,
        'without the adapter, instance B cannot reach a socket on instance A',
      ).toBeNull();
    } finally {
      await closeAll();
    }
  }, 40_000);

  it('still delivers an event emitted on the SAME instance', async () => {
    // Proves the negative above is about cross-instance delivery specifically,
    // not about the emitter or the rooms being broken.
    try {
      const attendant = await makeActor(t, 'attendant');
      await staffLot(t, attendant, lot.lotId);

      const a = await startInstance(false);
      const dashboard = await connectAndSubscribe(a.port, attendant.token, lot.lotId);
      const received = eventOrTimeout<StaffSlotEvent>(dashboard, SLOT_UPDATED, CROSS_INSTANCE_MS);

      a.emitter.slotChanged(
        lot.lotId,
        slotEvent(lot.lotId, lot.slotIds[0]!, 4),
        slotEvent(lot.lotId, lot.slotIds[0]!, 4),
      );

      expect(await received).not.toBeNull();
    } finally {
      await closeAll();
    }
  }, 40_000);
});
