import {
  type BookingStatus,
  CREATIONS,
  STAFF_ONLY_FIELDS,
  TRANSITIONS,
  addMinutes,
  publicRoom,
  staffRoom,
  staffSlotEventSchema,
  publicSlotEventSchema,
  bookingUpdatedSchema,
  userRoom,
} from '@laqum/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/afterCommit.js';
import { createBooking, createWalkIn } from '../src/bookings/create.js';
import { transition, type BookingPatch } from '../src/bookings/transition.js';
import type { RecordingEmitter } from '../src/realtime/emitter.js';
import { setSlotService } from '../src/staff/service.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, createUser, seedBooking, type LotFixture } from './helpers/fixtures.js';

/**
 * EVERY WRITE PATH EMITS, AND ONLY AFTER COMMIT.
 *
 * This test walks the TRANSITIONS table itself rather than a hand-written list
 * of cases. Adding a row to the state machine without a way to emit for it
 * fails here, because the loop is generated from the table.
 *
 * It holds because the recording lives in transition() and create.ts — the two
 * functions invariant 3 already restricts status writes to — so there is no
 * path that changes a booking without recording a change. See afterCommit.ts.
 */

let t: TestContext;
let lot: LotFixture;
let emitter: RecordingEmitter;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
  emitter = t.emitter;
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.clock.set('2026-03-01T08:00:00.000Z');
  lot = await createLot(t.db.db, { slots: 4, depositSantim: 0 });
  emitter.reset();
});

/** Fields the schema requires to be present for a given target status. */
function patchFor(to: BookingStatus, now: Date): BookingPatch | undefined {
  if (to === 'CHECKED_IN') return { checked_in_at: now, planned_end_at: addMinutes(now, 60) };
  if (to === 'CHECKED_OUT') return { checked_out_at: now, amount_due_santim: 500 };
  return undefined;
}

/** A booking sitting in `status`, with whatever columns that status requires. */
async function bookingIn(status: BookingStatus, slotIndex: number, phone: string): Promise<string> {
  const userId = await createUser(t.db.db, 'driver', phone);
  const now = t.clock.now();
  const seedable = status as Exclude<BookingStatus, 'PAID' | 'EXPIRED' | 'CANCELLED'>;

  return seedBooking(t.db.db, {
    lotId: lot.lotId,
    slotId: lot.slotIds[slotIndex]!,
    userId,
    status: seedable,
    holdExpiresAt: addMinutes(now, 15),
    checkedInAt: status === 'CHECKED_IN' || status === 'OVERSTAY' ? now : null,
    plannedEndAt: status === 'CHECKED_IN' || status === 'OVERSTAY' ? addMinutes(now, 60) : null,
  });
}

describe('every TRANSITIONS entry emits to every audience', () => {
  // The loop IS the coverage. A new row in the table becomes a new test.
  for (const [index, def] of TRANSITIONS.entries()) {
    it(`${def.from} -> ${def.to} (${def.actor})`, async () => {
      const bookingId = await bookingIn(
        def.from,
        index % 4,
        `+2519117${String(index).padStart(4, '0')}`,
      );
      const booking = await t.db.db
        .selectFrom('bookings')
        .select(['user_id', 'slot_id'])
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow();

      emitter.reset();
      const now = t.clock.now();

      const outcome = await inTransaction({ db: t.db.db, logger: t.ctx.logger, emitter }, (trx) =>
        transition(trx, t.ctx.clock, {
          bookingId,
          from: def.from,
          to: def.to,
          actorId: null,
          // Spread: exactOptionalPropertyTypes distinguishes an absent
          // property from one explicitly set to undefined.
          ...(patchFor(def.to, now) ? { patch: patchFor(def.to, now)! } : {}),
        }),
      );

      expect(outcome.ok, `${def.from} -> ${def.to} should succeed`).toBe(true);
      if (!outcome.ok) return;

      // ── the slot event, to BOTH lot rooms ──────────────────────────────
      expect(emitter.slotEvents, 'exactly one slot event per transition').toHaveLength(1);
      const event = emitter.slotEvents[0]!;
      expect(event.lotId).toBe(lot.lotId);

      // It carries the version THIS transition produced — not a later one.
      expect(event.staff.lotVersion).toBe(outcome.lotVersion);
      expect(event.pub.lotVersion).toBe(outcome.lotVersion);
      expect(event.staff.slotId).toBe(booking.slot_id);

      // Both payloads are valid against the published contract.
      expect(() => staffSlotEventSchema.parse(event.staff)).not.toThrow();
      expect(() => publicSlotEventSchema.parse(event.pub)).not.toThrow();

      // AUDIENCE SEPARATION: the public payload carries no staff-only field.
      for (const field of STAFF_ONLY_FIELDS) {
        expect(Object.keys(event.pub), `${field} must not reach the public room`).not.toContain(
          field,
        );
      }

      // ── the booking event, to the DRIVER's own room ────────────────────
      expect(emitter.bookingEvents, 'one booking event for an app booking').toHaveLength(1);
      const bookingEvent = emitter.bookingEvents[0]!;
      expect(bookingEvent.userId).toBe(booking.user_id);
      const payload = bookingUpdatedSchema.parse(bookingEvent.payload);
      expect(payload.status).toBe(def.to);
      expect(payload.lotVersion).toBe(outcome.lotVersion);
    });
  }

  it('covers the whole table', () => {
    // Guards against the loop silently iterating nothing.
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(9);
  });
});

describe('room names are the ones the socket server joins', () => {
  it('builds the three rooms from the shared helpers', () => {
    // The emitter and the subscribe handler must agree on the string. They do,
    // because both call these — asserted here so a literal creeping into
    // either one is caught.
    expect(staffRoom(lot.lotId)).toBe(`lot:${lot.lotId}:staff`);
    expect(publicRoom(lot.lotId)).toBe(`lot:${lot.lotId}:public`);
    expect(userRoom('u1')).toBe('user:u1');
  });
});

describe('creation emits', () => {
  it('emits when a driver books a slot', async () => {
    const userId = await createUser(t.db.db, 'driver', '+251911770001');
    emitter.reset();

    const result = await createBooking(
      { db: t.db.db, clock: t.ctx.clock, logger: t.ctx.logger, scheduler: t.scheduler, emitter },
      {
        lotId: lot.lotId,
        userId,
        plannedMinutes: 60,
        latitude: lot.latitude,
        longitude: lot.longitude,
      },
    );

    expect(emitter.slotEvents).toHaveLength(1);
    expect(emitter.slotEvents[0]!.staff.slotId).toBe(result.booking.slot_id);
    expect(emitter.slotEvents[0]!.staff.displayStatus).toBe('reserved');
    expect(emitter.bookingEvents).toHaveLength(1);
    expect(emitter.bookingEvents[0]!.userId).toBe(userId);
  });

  it('emits when an attendant parks a walk-in, with NO driver event', async () => {
    const attendantId = await createUser(t.db.db, 'attendant', '+251911770002');
    emitter.reset();

    await createWalkIn(
      { db: t.db.db, clock: t.ctx.clock, logger: t.ctx.logger, scheduler: t.scheduler, emitter },
      { lotId: lot.lotId, slotId: lot.slotIds[0]!, attendantId, vehiclePlate: 'AA-11111' },
    );

    expect(emitter.slotEvents).toHaveLength(1);
    expect(emitter.slotEvents[0]!.staff.displayStatus).toBe('occupied');
    expect(emitter.slotEvents[0]!.staff.vehiclePlate).toBe('AA-11111');
    // A walk-in has no user, so there is nobody to notify privately.
    expect(emitter.bookingEvents, 'a walk-in has no driver room').toHaveLength(0);
  });

  it('covers every CREATIONS entry', () => {
    // app->PENDING_PAYMENT, app->RESERVED and walk_in->CHECKED_IN. The first
    // two are the same code path parameterised by the lot's deposit.
    expect(CREATIONS).toHaveLength(3);
  });

  it('emits PENDING_PAYMENT for a lot that takes a deposit', async () => {
    const paid = await createLot(t.db.db, { name: 'Deposit lot', slots: 2, depositSantim: 2000 });
    const userId = await createUser(t.db.db, 'driver', '+251911770003');
    emitter.reset();

    await createBooking(
      { db: t.db.db, clock: t.ctx.clock, logger: t.ctx.logger, scheduler: t.scheduler, emitter },
      {
        lotId: paid.lotId,
        userId,
        plannedMinutes: 60,
        latitude: paid.latitude,
        longitude: paid.longitude,
      },
    );

    expect(emitter.slotEvents).toHaveLength(1);
    // PENDING_PAYMENT is a live status, so the slot reads as reserved.
    expect(emitter.slotEvents[0]!.staff.displayStatus).toBe('reserved');
  });
});

describe('in_service changes emit', () => {
  it('emits when a slot is taken OUT of service', async () => {
    emitter.reset();
    await setSlotService({ ...t.ctx, emitter }, lot.slotIds[0]!, false);

    expect(emitter.slotEvents, 'no booking moved, but the grid did change').toHaveLength(1);
    expect(emitter.slotEvents[0]!.staff.displayStatus).toBe('out_of_service');
    expect(emitter.slotEvents[0]!.staff.inService).toBe(false);
    // Nothing happened to a booking, so no driver is told.
    expect(emitter.bookingEvents).toHaveLength(0);
  });

  it('emits when a slot is returned to service', async () => {
    await setSlotService({ ...t.ctx, emitter }, lot.slotIds[0]!, false);
    emitter.reset();

    await setSlotService({ ...t.ctx, emitter }, lot.slotIds[0]!, true);
    expect(emitter.slotEvents).toHaveLength(1);
    expect(emitter.slotEvents[0]!.staff.displayStatus).toBe('free');
  });

  it('advances the lot version, so clients accept the event', async () => {
    const before = await t.db.db
      .selectFrom('lots')
      .select('version')
      .where('id', '=', lot.lotId)
      .executeTakeFirstOrThrow();

    emitter.reset();
    await setSlotService({ ...t.ctx, emitter }, lot.slotIds[1]!, false);

    expect(emitter.slotEvents[0]!.staff.lotVersion).toBe(before.version + 1);
  });
});

describe('INVARIANT 5: a rolled-back transaction emits nothing', () => {
  it('emits nothing when the caller throws after a successful transition', async () => {
    const bookingId = await bookingIn('RESERVED', 0, '+251911780001');
    emitter.reset();

    await expect(
      inTransaction({ db: t.db.db, logger: t.ctx.logger, emitter }, async (trx) => {
        const outcome = await transition(trx, t.ctx.clock, {
          bookingId,
          from: 'RESERVED',
          to: 'CANCELLED',
          actorId: null,
        });
        expect(outcome.ok).toBe(true);
        throw new Error('caller failed after the transition');
      }),
    ).rejects.toThrow('caller failed');

    // The transition happened, the emit was recorded — and then the
    // transaction rolled back. Telling a dashboard about a cancellation the
    // database never kept is exactly what invariant 5 exists to prevent.
    expect(emitter.slotEvents, 'a rollback must emit no slot event').toHaveLength(0);
    expect(emitter.bookingEvents, 'a rollback must emit no booking event').toHaveLength(0);

    const still = await t.db.db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    expect(still.status).toBe('RESERVED');
  });

  it('emits nothing when a transition is REFUSED', async () => {
    const bookingId = await bookingIn('RESERVED', 0, '+251911780002');
    await inTransaction({ db: t.db.db, logger: t.ctx.logger, emitter }, (trx) =>
      transition(trx, t.ctx.clock, {
        bookingId,
        from: 'RESERVED',
        to: 'CANCELLED',
        actorId: null,
      }),
    );
    emitter.reset();

    // Already cancelled: the compare-and-set matches nothing.
    const refused = await inTransaction({ db: t.db.db, logger: t.ctx.logger, emitter }, (trx) =>
      transition(trx, t.ctx.clock, {
        bookingId,
        from: 'RESERVED',
        to: 'CANCELLED',
        actorId: null,
      }),
    );

    expect(refused.ok).toBe(false);
    expect(emitter.slotEvents, 'nothing changed, so nothing is announced').toHaveLength(0);
  });

  it('emits nothing when a booking creation finds no free slot', async () => {
    const full = await createLot(t.db.db, { name: 'Full', slots: 1, depositSantim: 0 });
    const taker = await createUser(t.db.db, 'driver', '+251911780003');
    await seedBooking(t.db.db, {
      lotId: full.lotId,
      slotId: full.slotIds[0]!,
      userId: taker,
      status: 'RESERVED',
    });

    const userId = await createUser(t.db.db, 'driver', '+251911780004');
    emitter.reset();

    await expect(
      createBooking(
        { db: t.db.db, clock: t.ctx.clock, logger: t.ctx.logger, scheduler: t.scheduler, emitter },
        {
          lotId: full.lotId,
          userId,
          plannedMinutes: 60,
          latitude: full.latitude,
          longitude: full.longitude,
        },
      ),
    ).rejects.toThrow(/LOT_FULL|No slot is available/u);

    expect(emitter.slotEvents).toHaveLength(0);
  });
});
