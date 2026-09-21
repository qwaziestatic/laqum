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
import { createLot, createUser, seedBooking } from './helpers/fixtures.js';

let ctx: TestDb;
let db: Kysely<Database>;
const logger = testLogger();
let scheduler: RecordingScheduler;

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
  scheduler = new RecordingScheduler();
});

function deps(clock = testClock()) {
  return { db, clock, logger, scheduler };
}

describe('slot assignment', () => {
  it('assigns the first free slot by zone, row, then column', async () => {
    const lot = await createLot(db, { slots: 0 });
    // Deliberately inserted out of order.
    const ids: Record<string, string> = {};
    for (const spec of [
      { label: 'B-2', zone: 'main', grid_row: 1, grid_col: 1 },
      { label: 'A-1', zone: 'main', grid_row: 0, grid_col: 0 },
      { label: 'B-1', zone: 'main', grid_row: 1, grid_col: 0 },
      { label: 'Z-1', zone: 'annex', grid_row: 0, grid_col: 0 },
    ]) {
      const row = await db
        .insertInto('slots')
        .values({ lot_id: lot.lotId, ...spec })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[spec.label] = row.id;
    }

    const userId = await createUser(db, 'driver', '+251911000101');
    const result = await createBooking(deps(), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    // 'annex' sorts before 'main', so Z-1 is first by (zone, row, col).
    expect(result.booking.slot_id).toBe(ids['Z-1']);
  });

  it('skips slots that are not app-bookable or not in service', async () => {
    const lot = await createLot(db, { slots: 0 });
    const blocked = await db
      .insertInto('slots')
      .values({
        lot_id: lot.lotId,
        label: 'A-1',
        zone: 'main',
        grid_row: 0,
        grid_col: 0,
        in_service: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const walkInOnly = await db
      .insertInto('slots')
      .values({
        lot_id: lot.lotId,
        label: 'A-2',
        zone: 'main',
        grid_row: 0,
        grid_col: 1,
        app_bookable: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const usable = await db
      .insertInto('slots')
      .values({ lot_id: lot.lotId, label: 'A-3', zone: 'main', grid_row: 0, grid_col: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();

    const userId = await createUser(db, 'driver', '+251911000102');
    const result = await createBooking(deps(), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    expect(result.booking.slot_id).toBe(usable.id);
    expect(result.booking.slot_id).not.toBe(blocked.id);
    expect(result.booking.slot_id).not.toBe(walkInOnly.id);
  });

  it('returns LOT_FULL when every slot is occupied', async () => {
    const lot = await createLot(db, { slots: 2 });
    const other = await createUser(db, 'driver', '+251911000103');
    const another = await createUser(db, 'driver', '+251911000104');
    await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: other,
      status: 'RESERVED',
    });
    await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: another,
      status: 'CHECKED_IN',
    });

    const userId = await createUser(db, 'driver', '+251911000105');
    await expect(
      createBooking(deps(), {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      }),
    ).rejects.toMatchObject({ code: 'LOT_FULL', status: 409 });
  });

  it('does not spend its retry budget on slots that are already taken', async () => {
    // Committed bookings are filtered out by the candidate query, so they cost
    // no attempts and raise no violation. The retry budget is for slots taken
    // BETWEEN the candidate read and the insert — see create-retry.test.ts,
    // which drives that path with real unique violations.
    const lot = await createLot(db, { slots: MAX_SLOT_ATTEMPTS + 3 });
    expect(MAX_SLOT_ATTEMPTS).toBe(4);

    for (let i = 0; i < MAX_SLOT_ATTEMPTS; i++) {
      const holder = await createUser(db, 'driver', `+25191100020${String(i)}`);
      await seedBooking(db, {
        lotId: lot.lotId,
        slotId: lot.slotIds[i]!,
        userId: holder,
        status: 'RESERVED',
      });
    }

    const userId = await createUser(db, 'driver', '+251911000210');
    const result = await createBooking(deps(), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });
    expect(result.booking.slot_id).toBe(lot.slotIds[MAX_SLOT_ATTEMPTS]);
  });
});

describe('booking rules', () => {
  it('rejects a driver who is too far from the lot', async () => {
    const lot = await createLot(db, { slots: 1, maxBookingDistanceM: 500 });
    const userId = await createUser(db, 'driver', '+251911000106');

    await expect(
      createBooking(deps(), {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude + 0.05, // ~5.5 km north
        longitude: lot.longitude,
      }),
    ).rejects.toMatchObject({ code: 'TOO_FAR', status: 422 });
  });

  it('accepts a driver just inside the radius', async () => {
    const lot = await createLot(db, { slots: 1, maxBookingDistanceM: 500 });
    const userId = await createUser(db, 'driver', '+251911000107');

    const result = await createBooking(deps(), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude + 0.001, // ~111 m
      longitude: lot.longitude,
    });
    expect(result.booking.id).toBeTruthy();
  });

  it('requires plannedMinutes to be a positive multiple of the block', async () => {
    const lot = await createLot(db, { slots: 1, blockMinutes: 30 });
    const userId = await createUser(db, 'driver', '+251911000108');
    const base = {
      lotId: lot.lotId,
      userId,
      latitude: lot.latitude,
      longitude: lot.longitude,
    };

    for (const plannedMinutes of [0, -30, 15, 45, 31]) {
      await expect(createBooking(deps(), { ...base, plannedMinutes })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }

    const ok = await createBooking(deps(), { ...base, plannedMinutes: 90 });
    expect(ok.booking.planned_minutes).toBe(90);
  });

  it('refuses a driver who has not paid for a previous stay', async () => {
    const lot = await createLot(db, { slots: 2 });
    const userId = await createUser(db, 'driver', '+251911000109');
    await seedBooking(db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId,
      status: 'CHECKED_OUT',
    });

    await expect(
      createBooking(deps(), {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      }),
    ).rejects.toMatchObject({ code: 'OUTSTANDING_BALANCE', status: 409 });
  });

  it('rejects an unknown or inactive lot', async () => {
    const userId = await createUser(db, 'driver', '+251911000110');
    await expect(
      createBooking(deps(), {
        lotId: '00000000-0000-0000-0000-000000000000',
        userId,
        plannedMinutes: 30,
        latitude: 9,
        longitude: 38.7,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const lot = await createLot(db, { slots: 1 });
    await db.updateTable('lots').set({ is_active: false }).where('id', '=', lot.lotId).execute();
    await expect(
      createBooking(deps(), {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 30,
        latitude: lot.latitude,
        longitude: lot.longitude,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the two birth states', () => {
  it('starts PENDING_PAYMENT and holds for the payment window when a deposit is due', async () => {
    const lot = await createLot(db, {
      slots: 1,
      depositSantim: 2000,
      paymentWindowMinutes: 3,
      holdMinutes: 15,
    });
    const userId = await createUser(db, 'driver', '+251911000111');
    const clock = testClock('2026-03-01T08:00:00.000Z');

    const result = await createBooking(deps(clock), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    expect(result.booking.status).toBe('PENDING_PAYMENT');
    expect(result.paymentRequired).toBe(true);
    // Payment window, not the arrival hold.
    expect(result.booking.hold_expires_at?.toISOString()).toBe('2026-03-01T08:03:00.000Z');
  });

  it('starts RESERVED and holds for the arrival window when there is no deposit', async () => {
    const lot = await createLot(db, {
      slots: 1,
      depositSantim: 0,
      paymentWindowMinutes: 3,
      holdMinutes: 15,
    });
    const userId = await createUser(db, 'driver', '+251911000112');
    const clock = testClock('2026-03-01T08:00:00.000Z');

    const result = await createBooking(deps(clock), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    expect(result.booking.status).toBe('RESERVED');
    expect(result.paymentRequired).toBe(false);
    expect(result.booking.hold_expires_at?.toISOString()).toBe('2026-03-01T08:15:00.000Z');
  });

  it('issues a QR token and a short code matching the constrained alphabet', async () => {
    const lot = await createLot(db, { slots: 1 });
    const userId = await createUser(db, 'driver', '+251911000113');

    const result = await createBooking(deps(), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    expect(result.booking.qr_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.booking.short_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/u);
  });

  it('writes a creation event with no from_status, stamped by the clock', async () => {
    const lot = await createLot(db, { slots: 1 });
    const userId = await createUser(db, 'driver', '+251911000114');
    const clock = testClock('2027-07-07T07:07:07.000Z');

    const result = await createBooking(deps(clock), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    const events = await db
      .selectFrom('booking_events')
      .selectAll()
      .where('booking_id', '=', result.booking.id)
      .execute();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from_status: null,
      to_status: 'RESERVED',
      actor_id: userId,
    });
    expect(events[0]?.at.toISOString()).toBe('2027-07-07T07:07:07.000Z');
    expect(result.booking.created_at.toISOString()).toBe('2027-07-07T07:07:07.000Z');
  });

  it('schedules the expiry job for the hold deadline, after the commit', async () => {
    const lot = await createLot(db, { slots: 1, depositSantim: 0, holdMinutes: 15 });
    const userId = await createUser(db, 'driver', '+251911000115');
    const clock = testClock('2026-03-01T08:00:00.000Z');

    const result = await createBooking(deps(clock), {
      lotId: lot.lotId,
      userId,
      plannedMinutes: 30,
      latitude: lot.latitude,
      longitude: lot.longitude,
    });

    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]).toMatchObject({
      queue: 'expire-hold',
      bookingId: result.booking.id,
      jobId: `expire-hold:${result.booking.id}`,
    });
    expect(scheduler.scheduled[0]?.runAt.toISOString()).toBe('2026-03-01T08:15:00.000Z');
  });
});
