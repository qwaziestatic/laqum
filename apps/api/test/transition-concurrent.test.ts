import type { Database } from '@laqum/db';
import { addMinutes } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transition } from '../src/bookings/transition.js';
import { connect, migrateFresh, testClock, truncateAll, type TestDb } from './helpers/db.js';
import { createLot, createUser, seedBooking } from './helpers/fixtures.js';

/**
 * The audit trail must not lie about where a booking came from.
 *
 * This is the case that rules out the one-statement self-join form of
 * transition():
 *
 *   UPDATE bookings b SET ... FROM bookings old
 *    WHERE old.id = b.id AND b.id = $id AND b.status = ANY($from)
 *   RETURNING b.*, old.status AS prev_status
 *
 * Under READ COMMITTED, when that UPDATE blocks on a concurrent writer and the
 * writer commits, Postgres re-checks the TARGET row against its newest
 * version — but the joined `old` row is still the original snapshot. The
 * update then succeeds while reporting a stale prev_status.
 *
 * Concretely: mark-overstay commits CHECKED_IN -> OVERSTAY while a checkout
 * from [CHECKED_IN, OVERSTAY] is waiting on the row. The checkout succeeds,
 * and the self-join would record from_status = CHECKED_IN. It must be
 * OVERSTAY.
 */

let ctx: TestDb;
let db: Kysely<Database>;

beforeAll(async () => {
  await migrateFresh();
  // Two connections have to be held open simultaneously.
  ctx = connect(6);
  db = ctx.db;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('a transition racing a concurrent writer', () => {
  it('records the status the booking actually had when the lock was acquired', async () => {
    const driverId = await createUser(db, 'driver', '+251911000010');
    const lot = await createLot(db);
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const plannedEnd = addMinutes(checkedInAt, 60);

    const bookingId = await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'CHECKED_IN',
      checkedInAt,
      plannedEndAt: plannedEnd,
    });

    const jobClock = testClock('2026-03-01T09:00:00.000Z');
    const attendantClock = testClock('2026-03-01T09:00:05.000Z');

    // A: the overstay job, held open so it has the row locked but uncommitted.
    const jobTx = await db.startTransaction().execute();
    const overstay = await transition(jobTx, jobClock, {
      bookingId,
      from: 'CHECKED_IN',
      to: 'OVERSTAY',
      actorId: null,
      due: { column: 'planned_end_at', notAfter: jobClock.now() },
    });
    expect(overstay.ok).toBe(true);

    // B: the attendant checks out. This must block on A's row lock.
    const checkoutTx = await db.startTransaction().execute();
    let checkoutSettled = false;
    const checkout = transition(checkoutTx, attendantClock, {
      bookingId,
      from: ['CHECKED_IN', 'OVERSTAY'],
      to: 'CHECKED_OUT',
      actorId: driverId,
    }).then((outcome) => {
      checkoutSettled = true;
      return outcome;
    });

    // Give B a real chance to reach the lock and block on it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(checkoutSettled, 'checkout should be blocked on the row lock').toBe(false);

    await jobTx.commit().execute();

    const outcome = await checkout;
    await checkoutTx.commit().execute();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // THE assertion: the checkout saw OVERSTAY, not the stale CHECKED_IN.
    expect(outcome.from).toBe('OVERSTAY');

    const log = await db
      .selectFrom('booking_events')
      .select(['from_status', 'to_status'])
      .where('booking_id', '=', bookingId)
      .orderBy('id')
      .execute();

    expect(log.map((e) => `${e.from_status ?? 'NEW'}->${e.to_status}`)).toEqual([
      'NEW->CHECKED_IN',
      'CHECKED_IN->OVERSTAY',
      'OVERSTAY->CHECKED_OUT',
    ]);
  });

  it('lets the loser observe the winner when both target the same status', async () => {
    const driverId = await createUser(db, 'driver', '+251911000011');
    const lot = await createLot(db);
    const bookingId = await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'RESERVED',
      holdExpiresAt: new Date('2026-03-01T08:15:00.000Z'),
    });

    const clock = testClock('2026-03-01T08:20:00.000Z');

    const firstTx = await db.startTransaction().execute();
    const first = await transition(firstTx, clock, {
      bookingId,
      from: 'RESERVED',
      to: 'CANCELLED',
      actorId: driverId,
    });
    expect(first.ok).toBe(true);

    const secondTx = await db.startTransaction().execute();
    const second = transition(secondTx, clock, {
      bookingId,
      from: ['PENDING_PAYMENT', 'RESERVED'],
      to: 'EXPIRED',
      actorId: null,
      due: { column: 'hold_expires_at', notAfter: clock.now() },
    });

    await firstTx.commit().execute();

    const outcome = await second;
    await secondTx.commit().execute();

    // Exactly one winner, and the loser reports what actually happened.
    expect(outcome).toMatchObject({ ok: false, reason: 'WRONG_STATUS', current: 'CANCELLED' });

    const booking = await db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(booking.status).toBe('CANCELLED');

    const log = await db
      .selectFrom('booking_events')
      .select('to_status')
      .where('booking_id', '=', bookingId)
      .execute();
    expect(log).toHaveLength(2); // creation + the one winner
  });
});
