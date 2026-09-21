import type { Database } from '@laqum/db';
import { isAppError } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBooking } from '../src/bookings/create.js';
import {
  RecordingScheduler,
  connect,
  migrateFresh,
  testClock,
  testLogger,
  truncateAll,
  type TestDb,
} from './helpers/db.js';
import { createLot, createUser } from './helpers/fixtures.js';

/**
 * THE double-booking test.
 *
 * The pool must be large enough for all 20 requests to be inside Postgres at
 * once. A pool smaller than the burst silently serialises the requests and
 * the test passes without ever exercising the race it exists to prove — so
 * both the configured size AND the number of connections actually opened are
 * asserted.
 */

const CONCURRENCY = 20;

let ctx: TestDb;
let db: Kysely<Database>;
const logger = testLogger();

beforeAll(async () => {
  await migrateFresh();
  ctx = connect(CONCURRENCY + 5);
  db = ctx.db;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('20 parallel bookings for a lot with one free slot', () => {
  it('produces exactly one success and nineteen typed failures', async () => {
    // Requirement: the pool can hold every concurrent request at once.
    expect(
      ctx.pool.options.max,
      'pool must be large enough that the burst is not serialised',
    ).toBeGreaterThanOrEqual(CONCURRENCY);

    const lot = await createLot(db, { slots: 1, depositSantim: 0 });

    // A distinct driver each, so one_live_booking_per_user cannot be what
    // rejects them. The only contended resource is the single slot.
    const driverIds = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        createUser(db, 'driver', `+2519120000${String(i).padStart(2, '0')}`),
      ),
    );

    const scheduler = new RecordingScheduler();
    const clock = testClock();
    const deps = { db, clock, logger, scheduler };

    const settled = await Promise.allSettled(
      driverIds.map((userId) =>
        createBooking(deps, {
          lotId: lot.lotId,
          userId,
          plannedMinutes: 60,
          vehiclePlate: 'AA-00000',
          latitude: lot.latitude,
          longitude: lot.longitude,
        }),
      ),
    );

    // Requirement: prove the burst really was parallel. pg opens a client per
    // concurrent checkout; a serialised run would reuse one or two.
    expect(
      ctx.pool.totalCount,
      'the pool should have opened a connection per concurrent request',
    ).toBeGreaterThanOrEqual(CONCURRENCY);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);

    // Every loser fails with a typed, expected code — never a raw 23505.
    for (const failure of rejected) {
      const err: unknown = failure.reason;
      expect(isAppError(err), `unexpected error: ${String(err)}`).toBe(true);
      if (!isAppError(err)) continue;
      expect(['LOT_FULL', 'SLOT_TAKEN']).toContain(err.code);
      expect(err.status).toBe(409);
    }

    // The database agrees: one live booking, on the one slot.
    const live = await db
      .selectFrom('bookings')
      .selectAll()
      .where('status', 'in', ['PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY'])
      .execute();
    expect(live).toHaveLength(1);
    expect(live[0]?.slot_id).toBe(lot.slotIds[0]);
    expect(live[0]?.status).toBe('RESERVED');

    // Exactly one creation event, and one scheduled expiry — losers scheduled
    // nothing, because their transactions never committed.
    const eventCount = await db
      .selectFrom('booking_events')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(eventCount.count)).toBe(1);

    expect(scheduler.forQueue('expire-hold')).toHaveLength(1);
    expect(scheduler.scheduled[0]?.bookingId).toBe(live[0]?.id);
  }, 60_000);

  it('never double-books a slot when the burst exceeds the supply', async () => {
    const slots = 5;
    const lot = await createLot(db, { slots, depositSantim: 0 });

    const driverIds = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        createUser(db, 'driver', `+2519130000${String(i).padStart(2, '0')}`),
      ),
    );

    const deps = { db, clock: testClock(), logger, scheduler: new RecordingScheduler() };

    const settled = await Promise.allSettled(
      driverIds.map((userId) =>
        createBooking(deps, {
          lotId: lot.lotId,
          userId,
          plannedMinutes: 30,
          latitude: lot.latitude,
          longitude: lot.longitude,
        }),
      ),
    );

    const succeeded = settled.filter((r) => r.status === 'fulfilled').length;

    const booked = await db
      .selectFrom('bookings')
      .select('slot_id')
      .where('status', '=', 'RESERVED')
      .execute();

    // THE guarantee: no slot is ever double-booked, and no more bookings exist
    // than slots. This holds no matter how the race is scheduled.
    expect(booked).toHaveLength(succeeded);
    expect(new Set(booked.map((b) => b.slot_id)).size).toBe(succeeded);
    expect(succeeded).toBeLessThanOrEqual(slots);
    expect(succeeded).toBeGreaterThan(0);

    // Filling every slot is NOT guaranteed, and that is deliberate. Each
    // request gets MAX_SLOT_ATTEMPTS candidates ("retry the next free slot up
    // to 3 times before returning LOT_FULL"), so under a burst this large a
    // driver can be told LOT_FULL while a slot is still free. Bounded work per
    // request is the trade the brief chose; the driver simply retries.
  }, 60_000);

  it('refuses a second live booking from the same driver', async () => {
    const lot = await createLot(db, { slots: 10, depositSantim: 0 });
    const userId = await createUser(db, 'driver', '+251911000050');
    const deps = { db, clock: testClock(), logger, scheduler: new RecordingScheduler() };

    const input = {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    };

    const settled = await Promise.allSettled([
      createBooking(deps, input),
      createBooking(deps, input),
      createBooking(deps, input),
    ]);

    // one_live_booking_per_user is a partial unique index, so the database
    // decides this, not a check-then-insert.
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const failure of settled.filter((r) => r.status === 'rejected')) {
      const err: unknown = failure.reason;
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(['ALREADY_HAS_ACTIVE_BOOKING', 'SLOT_TAKEN', 'LOT_FULL']).toContain(err.code);
      }
    }
  }, 30_000);
});
