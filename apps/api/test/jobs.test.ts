import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireHold, markOverstay, timeReminder, type JobDeps } from '../src/jobs/handlers.js';
import { sweep } from '../src/jobs/sweeper.js';
import { makeActor, reissue, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, createUser, seedBooking, type LotFixture } from './helpers/fixtures.js';

let t: TestContext;
let lot: LotFixture;
let deps: JobDeps;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
  deps = { db: t.db.db, clock: t.ctx.clock, logger: t.ctx.logger };
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.scheduler.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');
  lot = await createLot(t.db.db, { slots: 3, blockMinutes: 30, depositSantim: 0 });
});

async function statusOf(bookingId: string): Promise<string> {
  const row = await t.db.db
    .selectFrom('bookings')
    .select('status')
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function eventCount(bookingId: string): Promise<number> {
  const row = await t.db.db
    .selectFrom('booking_events')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('booking_id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe('expire-hold', () => {
  async function reserved(holdMinutes = 15) {
    const userId = await createUser(t.db.db, 'driver', `+2519116${Date.now() % 100000}`);
    return seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), holdMinutes),
    });
  }

  it('expires a hold once its deadline has passed', async () => {
    const id = await reserved(15);
    t.clock.advanceMinutes(16);

    const result = await expireHold(deps, id);
    expect(result.applied).toBe(true);
    expect(await statusOf(id)).toBe('EXPIRED');
  });

  it('does nothing before the deadline', async () => {
    const id = await reserved(15);
    t.clock.advanceMinutes(14);

    const result = await expireHold(deps, id);
    expect(result).toMatchObject({ applied: false, reason: 'NOT_DUE' });
    expect(await statusOf(id)).toBe('RESERVED');
  });

  it('expires a pending payment whose window lapsed', async () => {
    const paid = await createLot(t.db.db, { slots: 1, depositSantim: 2000 });
    const userId = await createUser(t.db.db, 'driver', '+251911600001');
    const id = await seedBooking(t.db.db, {
      lotId: paid.lotId,
      slotId: paid.slotIds[0]!,
      userId,
      status: 'PENDING_PAYMENT',
      holdExpiresAt: addMinutes(t.clock.now(), 3),
    });

    t.clock.advanceMinutes(4);
    expect((await expireHold(deps, id)).applied).toBe(true);
    expect(await statusOf(id)).toBe('EXPIRED');
  });

  it('frees the slot, so the lot can be booked again', async () => {
    const id = await reserved(15);
    t.clock.advanceMinutes(16);
    await expireHold(deps, id);

    const free = await t.db.db
      .selectFrom('slot_status')
      .select('slot_id')
      .where('lot_id', '=', lot.lotId)
      .where('display_status', '=', 'free')
      .execute();
    expect(free).toHaveLength(3);
  });
});

describe('mark-overstay', () => {
  async function parked(plannedMinutes = 60) {
    const userId = await createUser(t.db.db, 'driver', `+2519117${Date.now() % 100000}`);
    const checkedInAt = t.clock.now();
    return seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'CHECKED_IN',
      plannedMinutes,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, plannedMinutes),
    });
  }

  it('marks a car over once its planned end has passed', async () => {
    const id = await parked(60);
    t.clock.advanceMinutes(61);

    expect((await markOverstay(deps, id)).applied).toBe(true);
    expect(await statusOf(id)).toBe('OVERSTAY');
  });

  it('does nothing one minute early', async () => {
    const id = await parked(60);
    t.clock.advanceMinutes(59);

    expect(await markOverstay(deps, id)).toMatchObject({ applied: false, reason: 'NOT_DUE' });
    expect(await statusOf(id)).toBe('CHECKED_IN');
  });

  it('never touches a walk-in, which has no planned end', async () => {
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      source: 'walk_in',
      userId: null,
      status: 'CHECKED_IN',
      plannedMinutes: null,
      checkedInAt: t.clock.now(),
      plannedEndAt: null,
    });

    t.clock.advanceMinutes(600);
    expect(await markOverstay(deps, id)).toMatchObject({ applied: false, reason: 'NOT_DUE' });
    expect(await statusOf(id)).toBe('CHECKED_IN');
  });
});

/**
 * THE stale-job scenario.
 *
 * A mark-overstay job is queued for the original planned end. The driver then
 * extends. The old job still fires at the old deadline, and the booking is
 * still CHECKED_IN — so a status-only compare-and-set would pass and mark the
 * car over an hour early, at the overstay rate.
 */
describe('a stale overstay job after an extension', () => {
  it('is a no-op, and the booking stays CHECKED_IN', async () => {
    const driver: Actor = await makeActor(t, 'driver');
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const originalEnd = addMinutes(checkedInAt, 60); // 09:00

    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedMinutes: 60,
      checkedInAt,
      plannedEndAt: originalEnd,
    });

    // The driver extends by one block, half an hour in.
    t.clock.set('2026-03-01T08:30:00.000Z');
    const extended = await request(t.app)
      .post(`/v1/bookings/${id}/extend`)
      .set((await reissue(t, driver)).header)
      .send({ additionalBlocks: 1 });
    expect(extended.status).toBe(200);

    const afterExtend = await t.db.db
      .selectFrom('bookings')
      .select(['planned_end_at', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(afterExtend.planned_end_at?.toISOString()).toBe('2026-03-01T09:30:00.000Z');

    // The STALE job fires at the ORIGINAL deadline.
    t.clock.set(originalEnd);
    const result = await markOverstay(deps, id);

    expect(result).toMatchObject({ applied: false, reason: 'NOT_DUE' });
    expect(await statusOf(id)).toBe('CHECKED_IN');
    // No event was written, so the audit trail does not record a phantom.
    expect(await eventCount(id)).toBe(1);

    // And the rescheduled job still works at the NEW deadline.
    t.clock.set('2026-03-01T09:30:00.000Z');
    expect((await markOverstay(deps, id)).applied).toBe(true);
    expect(await statusOf(id)).toBe('OVERSTAY');
  });
});

/** INVARIANT 6: running every job twice is the same as running it once. */
describe('idempotency', () => {
  it('expire-hold applies once however many times it runs', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911610001');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 15),
    });
    t.clock.advanceMinutes(16);

    const first = await expireHold(deps, id);
    const second = await expireHold(deps, id);
    const third = await expireHold(deps, id);

    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, reason: 'WRONG_STATUS' });
    expect(third).toMatchObject({ applied: false, reason: 'WRONG_STATUS' });

    expect(await statusOf(id)).toBe('EXPIRED');
    // One creation event plus exactly one transition.
    expect(await eventCount(id)).toBe(2);
  });

  it('mark-overstay applies once however many times it runs', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911610002');
    const checkedInAt = t.clock.now();
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'CHECKED_IN',
      plannedMinutes: 60,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, 60),
    });
    t.clock.advanceMinutes(61);

    expect((await markOverstay(deps, id)).applied).toBe(true);
    expect(await markOverstay(deps, id)).toMatchObject({ applied: false });

    expect(await statusOf(id)).toBe('OVERSTAY');
    expect(await eventCount(id)).toBe(2);
  });

  it('time-reminder changes nothing, twice', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911610003');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'CHECKED_IN',
    });

    expect(await timeReminder(deps, id)).toMatchObject({ applied: false });
    expect(await timeReminder(deps, id)).toMatchObject({ applied: false });
    expect(await statusOf(id)).toBe('CHECKED_IN');
    expect(await eventCount(id)).toBe(1);
  });

  it('reports NOT_FOUND rather than throwing for a booking that vanished', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect(await expireHold(deps, missing)).toMatchObject({ applied: false, reason: 'NOT_FOUND' });
    expect(await markOverstay(deps, missing)).toMatchObject({
      applied: false,
      reason: 'NOT_FOUND',
    });
  });
});

describe('the sweeper', () => {
  it('does nothing when nothing is overdue', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911620001');
    await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 15),
    });

    const report = await sweep(deps);
    expect(report.examined).toBe(0);
    expect(report.expired).toEqual([]);
    expect(report.overstayed).toEqual([]);
  });

  it('applies work the delayed jobs missed', async () => {
    // What a flushed Redis looks like: deadlines passed, nothing enqueued.
    const a = await createUser(t.db.db, 'driver', '+251911620002');
    const b = await createUser(t.db.db, 'driver', '+251911620003');
    const checkedInAt = t.clock.now();

    const expiring = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: a,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(checkedInAt, 15),
    });
    const overstaying = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: b,
      status: 'CHECKED_IN',
      plannedMinutes: 60,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, 60),
    });

    t.clock.advanceMinutes(61);
    const report = await sweep(deps);

    expect(report.expired.filter((r) => r.applied)).toHaveLength(1);
    expect(report.overstayed.filter((r) => r.applied)).toHaveLength(1);
    expect(await statusOf(expiring)).toBe('EXPIRED');
    expect(await statusOf(overstaying)).toBe('OVERSTAY');
  });

  it('is idempotent: a second sweep finds nothing left to do', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911620004');
    await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 15),
    });

    t.clock.advanceMinutes(16);
    const first = await sweep(deps);
    const second = await sweep(deps);

    expect(first.expired.filter((r) => r.applied)).toHaveLength(1);
    expect(second.examined).toBe(0);
  });

  it('leaves an extended booking alone, because it is not overdue', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911620005');
    const checkedInAt = t.clock.now();
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'CHECKED_IN',
      plannedMinutes: 120,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, 120),
    });

    t.clock.advanceMinutes(61);
    const report = await sweep(deps);

    expect(report.examined).toBe(0);
    expect(await statusOf(id)).toBe('CHECKED_IN');
  });
});
