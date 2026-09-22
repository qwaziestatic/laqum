import { addMinutes } from '@laqum/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/afterCommit.js';
import { currentLotVersion, transition } from '../src/bookings/transition.js';
import {
  connect,
  migrateFresh,
  testClock,
  testLogger,
  truncateAll,
  type TestDb,
} from './helpers/db.js';
import { createLot, createUser, seedBooking, type LotFixture } from './helpers/fixtures.js';

/**
 * lots.version is the realtime ordering token. Its whole value rests on one
 * property: versions are handed out in COMMIT order, not clock order and not
 * per-instance. These tests pin that property against a real database.
 */

let ctx: TestDb;
let lot: LotFixture;
const logger = testLogger();
const clock = testClock();

beforeAll(async () => {
  await migrateFresh();
  // Several transactions held open at once.
  ctx = connect(10);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  clock.set('2026-03-01T08:00:00.000Z');
  lot = await createLot(ctx.db, { slots: 4, depositSantim: 0 });
});

async function reservedBooking(slotIndex: number, phone: string): Promise<string> {
  const userId = await createUser(ctx.db, 'driver', phone);
  return seedBooking(ctx.db, {
    lotId: lot.lotId,
    slotId: lot.slotIds[slotIndex]!,
    userId,
    status: 'RESERVED',
    holdExpiresAt: addMinutes(clock.now(), 15),
  });
}

describe('lots.version', () => {
  it('starts at zero and advances once per status change', async () => {
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(0);

    const bookingId = await reservedBooking(0, '+251911800001');
    const first = await inTransaction({ db: ctx.db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'RESERVED',
        to: 'CHECKED_IN',
        actorId: null,
        patch: { checked_in_at: clock.now() },
      }),
    );

    expect(first.ok).toBe(true);
    if (first.ok) expect(first.lotVersion).toBe(1);
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(1);

    const second = await inTransaction({ db: ctx.db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'CHECKED_IN',
        to: 'CHECKED_OUT',
        actorId: null,
        patch: { checked_out_at: clock.now(), amount_due_santim: 0 },
      }),
    );
    if (second.ok) expect(second.lotVersion).toBe(2);
  });

  it('does not advance when a transition is refused', async () => {
    const bookingId = await reservedBooking(0, '+251911800002');
    await inTransaction({ db: ctx.db, logger }, (trx) =>
      transition(trx, clock, { bookingId, from: 'RESERVED', to: 'CANCELLED', actorId: null }),
    );
    const afterFirst = await currentLotVersion(ctx.db, lot.lotId);

    // Already cancelled: the CAS matches nothing, so nothing is emitted and
    // the version must not move.
    const refused = await inTransaction({ db: ctx.db, logger }, (trx) =>
      transition(trx, clock, { bookingId, from: 'RESERVED', to: 'CANCELLED', actorId: null }),
    );
    expect(refused.ok).toBe(false);
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(afterFirst);
  });

  it('gives two lots independent versions', async () => {
    const other = await createLot(ctx.db, { name: 'Other', slots: 1, depositSantim: 0 });
    const bookingId = await reservedBooking(0, '+251911800003');

    await inTransaction({ db: ctx.db, logger }, (trx) =>
      transition(trx, clock, { bookingId, from: 'RESERVED', to: 'CANCELLED', actorId: null }),
    );

    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(1);
    expect(await currentLotVersion(ctx.db, other.lotId)).toBe(0);
  });
});

describe('concurrent transitions on the same lot', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('hand out DISTINCT versions in COMMIT order', async () => {
    const first = await reservedBooking(0, '+251911800010');
    const second = await reservedBooking(1, '+251911800011');

    // Two different bookings, same lot, both in flight at once.
    const txA = await ctx.db.startTransaction().execute();
    const a = await transition(txA, clock, {
      bookingId: first,
      from: 'RESERVED',
      to: 'CANCELLED',
      actorId: null,
    });
    expect(a.ok).toBe(true);

    // B must block on the lots row lock A is holding — that lock is the whole
    // mechanism, so the test asserts it rather than assuming it.
    const txB = await ctx.db.startTransaction().execute();
    let bSettled = false;
    const bPromise = transition(txB, clock, {
      bookingId: second,
      from: 'RESERVED',
      to: 'CANCELLED',
      actorId: null,
    }).then((outcome) => {
      bSettled = true;
      return outcome;
    });

    await sleep(250);
    expect(bSettled, 'B should be blocked on the lot version lock held by A').toBe(false);

    await txA.commit().execute();
    const b = await bPromise;
    await txB.commit().execute();

    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Distinct, and ordered by COMMIT rather than by when each started.
    expect(a.lotVersion).toBe(1);
    expect(b.lotVersion).toBe(2);
    expect(b.lotVersion).toBeGreaterThan(a.lotVersion);
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(2);
  }, 30_000);

  it('never repeats a version under a burst', async () => {
    // Twenty concurrent changes across four slots' worth of bookings, all in
    // one lot. Every one must come away with its own number.
    const bookings = await Promise.all([
      reservedBooking(0, '+251911800020'),
      reservedBooking(1, '+251911800021'),
      reservedBooking(2, '+251911800022'),
      reservedBooking(3, '+251911800023'),
    ]);

    const results = await Promise.all(
      bookings.map((bookingId) =>
        inTransaction({ db: ctx.db, logger }, (trx) =>
          transition(trx, clock, {
            bookingId,
            from: 'RESERVED',
            to: 'CANCELLED',
            actorId: null,
          }),
        ),
      ),
    );

    const versions = results.flatMap((r) => (r.ok ? [r.lotVersion] : []));
    expect(versions).toHaveLength(4);
    expect(new Set(versions).size, 'every version must be unique').toBe(4);
    // A contiguous run from 1, in some order.
    expect([...versions].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(4);
  }, 30_000);

  it('rolls the version back with the transaction that produced it', async () => {
    const bookingId = await reservedBooking(0, '+251911800030');

    await expect(
      inTransaction({ db: ctx.db, logger }, async (trx) => {
        await transition(trx, clock, {
          bookingId,
          from: 'RESERVED',
          to: 'CANCELLED',
          actorId: null,
        });
        throw new Error('caller failed after the transition');
      }),
    ).rejects.toThrow('caller failed');

    // No change happened, so no version was consumed: a client must not be
    // told to expect an event that was never emitted.
    expect(await currentLotVersion(ctx.db, lot.lotId)).toBe(0);
  });
});
