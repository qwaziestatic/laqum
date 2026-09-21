import type { Database } from '@laqum/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SLOT_ATTEMPTS, createBooking } from '../src/bookings/create.js';
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
 * The retry path, driven by REAL unique violations.
 *
 * Seeding a slot as already-taken does not test this: the candidate query
 * filters such slots out, so no 23505 is ever raised. The violation only
 * happens when a slot is taken BETWEEN the candidate read and the insert.
 *
 * That window is reproduced deterministically by holding uncommitted inserts
 * open. An uncommitted row is invisible to the candidate query (READ
 * COMMITTED) but its index entry still blocks a competing insert, which then
 * fails with 23505 the moment the holder commits.
 *
 * This also exercises the fresh-transaction-per-attempt rule: a 23505 aborts
 * its transaction, and an aborted transaction cannot continue, so a retry
 * inside the same transaction would fail with "current transaction is
 * aborted" instead of trying the next slot.
 */

let ctx: TestDb;
let db: Kysely<Database>;
const logger = testLogger();

beforeAll(async () => {
  await migrateFresh();
  // Several held transactions plus the booking under test.
  ctx = connect(15);
  db = ctx.db;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/**
 * Insert a walk-in on `slotId` inside a transaction that is NOT committed.
 * Walk-ins need no user, QR token or short code, so the only index in play is
 * one_live_booking_per_slot.
 */
async function holdSlotUncommitted(lotId: string, slotId: string) {
  const tx = await db.startTransaction().execute();
  await tx
    .insertInto('bookings')
    .values({
      lot_id: lotId,
      slot_id: slotId,
      user_id: null,
      source: 'walk_in',
      status: 'CHECKED_IN',
      checked_in_at: new Date('2026-03-01T07:00:00.000Z'),
    })
    .execute();
  return tx;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('slot retry on a real unique violation', () => {
  it('moves to the next slot when the first is taken after the candidate read', async () => {
    const lot = await createLot(db, { slots: 6, depositSantim: 0 });
    const userId = await createUser(db, 'driver', '+251911400001');
    const scheduler = new RecordingScheduler();

    // The competing walk-in exists but is uncommitted, so the candidate query
    // will still report slot 0 as free.
    const holder = await holdSlotUncommitted(lot.lotId, lot.slotIds[0]!);

    const pending = createBooking(
      { db, clock: testClock(), logger, scheduler },
      {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      },
    );

    // Let it read candidates and block on slot 0's pending index entry.
    await sleep(250);
    await holder.commit().execute();

    const result = await pending;

    // A genuine 23505 was raised and recovered from.
    expect(result.booking.slot_id).toBe(lot.slotIds[1]);
    expect(result.booking.status).toBe('RESERVED');

    // The losing attempt left nothing behind: one booking event for this
    // booking, and no orphaned row from the aborted transaction.
    const events = await db
      .selectFrom('booking_events')
      .selectAll()
      .where('booking_id', '=', result.booking.id)
      .execute();
    expect(events).toHaveLength(1);

    const mine = await db
      .selectFrom('bookings')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(mine).toHaveLength(1);

    // And exactly one expiry job, for the booking that actually committed.
    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]?.bookingId).toBe(result.booking.id);
  }, 30_000);

  it('returns LOT_FULL after the retry budget, even with free slots left', async () => {
    // More slots than the budget, so exhaustion cannot be the explanation.
    const lot = await createLot(db, { slots: MAX_SLOT_ATTEMPTS + 2, depositSantim: 0 });
    const userId = await createUser(db, 'driver', '+251911400002');
    const scheduler = new RecordingScheduler();

    const holders = [];
    for (let i = 0; i < MAX_SLOT_ATTEMPTS; i++) {
      holders.push(await holdSlotUncommitted(lot.lotId, lot.slotIds[i]!));
    }

    const pending = createBooking(
      { db, clock: testClock(), logger, scheduler },
      {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      },
    );

    // Attach the rejection handler NOW, not after the commits. `pending`
    // rejects part-way through the loop below, and a promise that rejects with
    // no handler attached is an unhandled rejection even if it is awaited
    // later.
    const rejects = expect(pending).rejects.toMatchObject({
      code: 'LOT_FULL',
      status: 409,
    });

    await sleep(250);
    for (const holder of holders) {
      await holder.commit().execute();
      await sleep(50);
    }

    await rejects;

    // Two slots are still free: the budget ran out, the lot did not.
    const free = await db
      .selectFrom('slot_status')
      .select('slot_id')
      .where('lot_id', '=', lot.lotId)
      .where('display_status', '=', 'free')
      .execute();
    expect(free).toHaveLength(2);

    // Nothing was created, and nothing was scheduled.
    const mine = await db
      .selectFrom('bookings')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(mine).toHaveLength(0);
    expect(scheduler.scheduled).toEqual([]);
  }, 30_000);

  it('recovers from an aborted attempt rather than poisoning the retry', async () => {
    // If the retry reused the aborted transaction, this would fail with
    // "current transaction is aborted, commands ignored until end of
    // transaction block" instead of producing a booking.
    const lot = await createLot(db, { slots: 3, depositSantim: 0 });
    const userId = await createUser(db, 'driver', '+251911400003');

    const first = await holdSlotUncommitted(lot.lotId, lot.slotIds[0]!);
    const second = await holdSlotUncommitted(lot.lotId, lot.slotIds[1]!);

    const pending = createBooking(
      { db, clock: testClock(), logger, scheduler: new RecordingScheduler() },
      {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      },
    );

    await sleep(250);
    await first.commit().execute();
    await sleep(100);
    await second.commit().execute();

    // Two consecutive real violations, then success on the third slot.
    const result = await pending;
    expect(result.booking.slot_id).toBe(lot.slotIds[2]);
  }, 30_000);
});
