import type { Database } from '@laqum/db';
import { addMinutes } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/afterCommit.js';
import { transition, transitionOrThrow } from '../src/bookings/transition.js';
import {
  connect,
  migrateFresh,
  testClock,
  testLogger,
  truncateAll,
  type TestDb,
} from './helpers/db.js';
import { createLot, createUser, seedBooking } from './helpers/fixtures.js';

let ctx: TestDb;
let db: Kysely<Database>;
const logger = testLogger();

beforeAll(async () => {
  await migrateFresh();
  ctx = connect();
  db = ctx.db;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function setup(status: Parameters<typeof seedBooking>[1]['status'] = 'RESERVED') {
  const driverId = await createUser(db, 'driver', '+251911000001');
  const lot = await createLot(db, { slots: 2 });
  const bookingId = await seedBooking(db, {
    lotId: lot.lotId,
    slotId: lot.slotIds[0]!,
    userId: driverId,
    status,
  });
  return { driverId, lot, bookingId };
}

async function events(bookingId: string) {
  return db
    .selectFrom('booking_events')
    .selectAll()
    .where('booking_id', '=', bookingId)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

describe('transition', () => {
  it('moves the booking and records the event in the same transaction', async () => {
    const { driverId, bookingId } = await setup('RESERVED');
    const clock = testClock();

    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'RESERVED',
        to: 'CHECKED_IN',
        actorId: driverId,
        patch: { checked_in_at: clock.now() },
        note: 'scanned at the gate',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBe('RESERVED');
    expect(result.booking.status).toBe('CHECKED_IN');

    const log = await events(bookingId);
    expect(log).toHaveLength(2); // creation + this transition
    expect(log[1]).toMatchObject({
      from_status: 'RESERVED',
      to_status: 'CHECKED_IN',
      actor_id: driverId,
      note: 'scanned at the gate',
    });
  });

  it('stamps updated_at and the event from the injected clock, not the database', async () => {
    const { driverId, bookingId } = await setup('RESERVED');
    // Far from real time: if anything reached for now(), this fails loudly.
    const clock = testClock('2030-06-15T12:34:56.000Z');

    await inTransaction({ db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'RESERVED',
        to: 'CANCELLED',
        actorId: driverId,
      }),
    );

    const booking = await db
      .selectFrom('bookings')
      .select('updated_at')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(booking.updated_at.toISOString()).toBe('2030-06-15T12:34:56.000Z');

    const log = await events(bookingId);
    expect(log[1]?.at.toISOString()).toBe('2030-06-15T12:34:56.000Z');
  });

  it('accepts a set of allowed predecessors', async () => {
    const { driverId, bookingId } = await setup('OVERSTAY');

    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, testClock(), {
        bookingId,
        from: ['CHECKED_IN', 'OVERSTAY'],
        to: 'CHECKED_OUT',
        actorId: driverId,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.from).toBe('OVERSTAY');
  });

  it('reports WRONG_STATUS without changing anything', async () => {
    const { driverId, bookingId } = await setup('CHECKED_IN');

    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, testClock(), {
        bookingId,
        from: 'RESERVED',
        to: 'CANCELLED',
        actorId: driverId,
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'WRONG_STATUS', current: 'CHECKED_IN' });
    expect(await events(bookingId)).toHaveLength(1); // only the creation event
  });

  it('reports NOT_FOUND for a booking that does not exist', async () => {
    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, testClock(), {
        bookingId: '00000000-0000-0000-0000-000000000000',
        from: 'RESERVED',
        to: 'CHECKED_IN',
        actorId: null,
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('refuses a pair that is not in the state machine, before touching the row', async () => {
    const { bookingId } = await setup('RESERVED');

    await expect(
      inTransaction({ db, logger }, (trx) =>
        transition(trx, testClock(), {
          bookingId,
          from: 'RESERVED',
          to: 'PAID', // not a legal edge
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    expect(await events(bookingId)).toHaveLength(1);
  });

  it('refuses an empty from set rather than matching everything', async () => {
    const { bookingId } = await setup('RESERVED');
    await expect(
      inTransaction({ db, logger }, (trx) =>
        transition(trx, testClock(), {
          bookingId,
          from: [],
          to: 'CHECKED_IN',
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('writes no event when the transaction rolls back', async () => {
    const { driverId, bookingId } = await setup('RESERVED');

    await expect(
      inTransaction({ db, logger }, async (trx) => {
        await transition(trx, testClock(), {
          bookingId,
          from: 'RESERVED',
          to: 'CHECKED_IN',
          actorId: driverId,
        });
        throw new Error('caller failed after the transition');
      }),
    ).rejects.toThrow('caller failed after the transition');

    const booking = await db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(booking.status).toBe('RESERVED');
    expect(await events(bookingId)).toHaveLength(1);
  });
});

describe('transitionOrThrow', () => {
  it('maps a missing booking to 404 and a wrong status to 409', async () => {
    const { bookingId } = await setup('CHECKED_IN');

    await expect(
      inTransaction({ db, logger }, (trx) =>
        transitionOrThrow(trx, testClock(), {
          bookingId: '00000000-0000-0000-0000-000000000000',
          from: 'RESERVED',
          to: 'CHECKED_IN',
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    await expect(
      inTransaction({ db, logger }, (trx) =>
        transitionOrThrow(trx, testClock(), {
          bookingId,
          from: 'RESERVED',
          to: 'CANCELLED',
          actorId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT', status: 409 });
  });
});

describe('the due guard', () => {
  it('refuses to fire before the deadline has passed', async () => {
    const driverId = await createUser(db, 'driver', '+251911000002');
    const lot = await createLot(db);
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const plannedEnd = addMinutes(checkedInAt, 60); // 09:00

    const bookingId = await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'CHECKED_IN',
      checkedInAt,
      plannedEndAt: plannedEnd,
    });

    const clock = testClock('2026-03-01T08:59:00.000Z'); // one minute early

    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'CHECKED_IN',
        to: 'OVERSTAY',
        actorId: null,
        due: { column: 'planned_end_at', notAfter: clock.now() },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'NOT_DUE', current: 'CHECKED_IN' });
    expect(await events(bookingId)).toHaveLength(1);
  });

  it('fires exactly at the deadline', async () => {
    const driverId = await createUser(db, 'driver', '+251911000003');
    const lot = await createLot(db);
    const plannedEnd = new Date('2026-03-01T09:00:00.000Z');
    const bookingId = await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'CHECKED_IN',
      plannedEndAt: plannedEnd,
    });

    const clock = testClock('2026-03-01T09:00:00.000Z');
    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'CHECKED_IN',
        to: 'OVERSTAY',
        actorId: null,
        due: { column: 'planned_end_at', notAfter: clock.now() },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('refuses when the guarded column is null', async () => {
    const driverId = await createUser(db, 'driver', '+251911000004');
    const lot = await createLot(db);
    const bookingId = await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'CHECKED_IN',
      plannedEndAt: null,
    });

    const clock = testClock('2030-01-01T00:00:00.000Z');
    const result = await inTransaction({ db, logger }, (trx) =>
      transition(trx, clock, {
        bookingId,
        from: 'CHECKED_IN',
        to: 'OVERSTAY',
        actorId: null,
        due: { column: 'planned_end_at', notAfter: clock.now() },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'NOT_DUE', dueAt: null });
  });
});
