import type { Database } from '@laqum/db';
import {
  AppError,
  type BookingStatus,
  type Clock,
  LIVE_STATUSES,
  addMinutes,
  haversineMeters,
} from '@laqum/shared';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Logger } from 'pino';
import { CONSTRAINTS, isUniqueViolation } from '../db/pgError.js';
import { type JobScheduler, jobIdFor } from '../jobs/scheduler.js';
import { inTransaction } from '../afterCommit.js';
import { generateQrToken, generateShortCode } from './codes.js';
import type { BookingRow } from './transition.js';

/**
 * Booking creation. Together with transition.ts, the only writer of
 * bookings.status — creation is an INSERT, so it cannot be a compare-and-set.
 */

type LotRow = Selectable<Database['lots']>;

/**
 * "On a unique violation, retry the next free slot up to 3 times before
 * returning LOT_FULL": one initial attempt plus three retries.
 */
export const MAX_SLOT_ATTEMPTS = 4;

/** A short-code or QR collision is not a lost race; regenerate and retry. */
const MAX_CODE_ATTEMPTS = 5;

export interface CreateBookingInput {
  lotId: string;
  userId: string;
  plannedMinutes: number;
  vehiclePlate?: string | null;
  latitude: number;
  longitude: number;
}

export interface CreateBookingDeps {
  db: Kysely<Database>;
  clock: Clock;
  logger: Logger;
  scheduler: JobScheduler;
}

export interface CreateBookingResult {
  booking: BookingRow;
  lot: LotRow;
  /** True when the booking is PENDING_PAYMENT and a deposit is owed. */
  paymentRequired: boolean;
}

export async function createBooking(
  deps: CreateBookingDeps,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const lot = await deps.db
    .selectFrom('lots')
    .selectAll()
    .where('id', '=', input.lotId)
    .executeTakeFirst();

  if (!lot?.is_active) {
    throw new AppError('NOT_FOUND', `Lot ${input.lotId} is not available`);
  }

  assertWithinRange(lot, input);
  assertWholeBlocks(lot, input.plannedMinutes);
  await assertNoOutstandingBalance(deps.db, input.userId);

  // A deposit means the slot is held only for the payment window; without one
  // the booking is reserved immediately and holds for the arrival window.
  const paymentRequired = lot.deposit_amount_santim > 0;
  const status: BookingStatus = paymentRequired ? 'PENDING_PAYMENT' : 'RESERVED';
  const holdMinutes = paymentRequired ? lot.payment_window_minutes : lot.hold_minutes;

  const booking = await insertIntoFirstFreeSlot(deps, input, lot, status, holdMinutes);

  return { booking, lot, paymentRequired };
}

function assertWithinRange(lot: LotRow, input: CreateBookingInput): void {
  const distance = haversineMeters(
    { latitude: input.latitude, longitude: input.longitude },
    { latitude: lot.latitude, longitude: lot.longitude },
  );

  if (distance > lot.max_booking_distance_m) {
    throw new AppError('TOO_FAR', 'You are too far from this lot to book a slot', {
      distanceM: Math.round(distance),
      maxDistanceM: lot.max_booking_distance_m,
    });
  }
}

function assertWholeBlocks(lot: LotRow, plannedMinutes: number): void {
  if (plannedMinutes <= 0 || plannedMinutes % lot.block_minutes !== 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `plannedMinutes must be a positive multiple of ${lot.block_minutes}`,
      { plannedMinutes, blockMinutes: lot.block_minutes },
    );
  }
}

/**
 * A driver who owes money for a previous stay cannot start another one.
 *
 * one_live_booking_per_user does not cover this: CHECKED_OUT is not a live
 * status, so the index permits a second booking. This is the application rule
 * the brief specifies, backed by bookings_unpaid_by_user.
 */
async function assertNoOutstandingBalance(db: Kysely<Database>, userId: string): Promise<void> {
  const unpaid = await db
    .selectFrom('bookings')
    .select(['id', 'amount_due_santim'])
    .where('user_id', '=', userId)
    .where('status', '=', 'CHECKED_OUT')
    .executeTakeFirst();

  if (unpaid) {
    throw new AppError('OUTSTANDING_BALANCE', 'Settle your previous booking first', {
      bookingId: unpaid.id,
      amountDueSantim: unpaid.amount_due_santim,
    });
  }
}

/**
 * Assign a slot by LOCKING one, then inserting.
 *
 * The naive form — read the first free slot, then insert — makes every
 * concurrent request pick the SAME slot and collide in a herd. With a bounded
 * retry budget that produces LOT_FULL for drivers while slots sit free: a
 * 20-way burst on a 5-slot lot filled only 4 slots.
 *
 * SELECT ... FOR UPDATE SKIP LOCKED fixes the cause. Each request locks a
 * different free slot row, so concurrent requests spread across the lot
 * instead of piling onto its first slot. The lock is held until the
 * transaction commits, which is why the candidate is selected INSIDE the
 * insert transaction rather than before it.
 *
 * one_live_booking_per_slot remains the backstop: a writer that does not take
 * the slot lock can still collide, and the bounded retry covers that. It is no
 * longer the common path.
 *
 * Each attempt runs in its OWN transaction. A failed statement aborts its
 * transaction, and an aborted transaction cannot continue — so retrying inside
 * one transaction would fail with "current transaction is aborted" instead of
 * trying the next slot.
 */
type AttemptOutcome =
  | { kind: 'created'; booking: BookingRow }
  | { kind: 'no-free-slot' }
  | { kind: 'slot-taken' }
  | { kind: 'code-collision' };

async function insertIntoFirstFreeSlot(
  deps: CreateBookingDeps,
  input: CreateBookingInput,
  lot: LotRow,
  status: BookingStatus,
  holdMinutes: number,
): Promise<BookingRow> {
  let slotConflicts = 0;
  let codeConflicts = 0;

  while (slotConflicts < MAX_SLOT_ATTEMPTS && codeConflicts < MAX_CODE_ATTEMPTS) {
    const outcome = await attemptOnce(deps, input, lot, status, holdMinutes);

    if (outcome.kind === 'created') return outcome.booking;

    // Every free slot is either taken or locked by another request in flight.
    // Retrying cannot help: a locked slot is about to become a booked one.
    if (outcome.kind === 'no-free-slot') break;

    if (outcome.kind === 'slot-taken') slotConflicts++;
    else codeConflicts++;
  }

  throw new AppError('LOT_FULL', 'No slot is available in this lot right now');
}

/** One transaction: lock a free slot, insert the booking, record the event. */
async function attemptOnce(
  deps: CreateBookingDeps,
  input: CreateBookingInput,
  lot: LotRow,
  status: BookingStatus,
  holdMinutes: number,
): Promise<AttemptOutcome> {
  const now = deps.clock.now();
  const holdExpiresAt = addMinutes(now, holdMinutes);

  try {
    return await inTransaction(deps.db, deps.logger, async (trx, effects) => {
      const slot = await lockFreeSlot(trx, lot.id);
      if (!slot) return { kind: 'no-free-slot' };

      const booking = await trx
        .insertInto('bookings')
        .values({
          lot_id: lot.id,
          slot_id: slot.id,
          user_id: input.userId,
          source: 'app',
          status,
          vehicle_plate: input.vehiclePlate ?? null,
          planned_minutes: input.plannedMinutes,
          qr_token: generateQrToken(),
          short_code: generateShortCode(),
          hold_expires_at: holdExpiresAt,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('booking_events')
        .values({
          booking_id: booking.id,
          from_status: null,
          to_status: status,
          actor_id: input.userId,
          note: null,
          at: now,
        })
        .execute();

      // INVARIANT 5: registered here, run only after the commit returns.
      effects.add(jobIdFor('expire-hold', booking.id), async () => {
        await deps.scheduler.schedule({
          queue: 'expire-hold',
          bookingId: booking.id,
          runAt: holdExpiresAt,
        });
      });

      return { kind: 'created', booking };
    });
  } catch (err) {
    // A writer that did not hold the slot lock beat us to it.
    if (isUniqueViolation(err, CONSTRAINTS.liveBookingPerSlot)) return { kind: 'slot-taken' };

    // Another slot will not help: this driver already holds a live booking.
    if (isUniqueViolation(err, CONSTRAINTS.liveBookingPerUser)) {
      throw new AppError('ALREADY_HAS_ACTIVE_BOOKING', 'You already have an active booking');
    }

    if (
      isUniqueViolation(err, CONSTRAINTS.liveBookingPerShortCode) ||
      isUniqueViolation(err, CONSTRAINTS.qrToken)
    ) {
      deps.logger.warn({ lotId: lot.id }, 'booking code collision; regenerating');
      return { kind: 'code-collision' };
    }

    throw err;
  }
}

/**
 * Lock the first free, app-bookable, in-service slot, skipping any row another
 * transaction already holds.
 *
 * This cannot read through slot_status: FOR UPDATE is not permitted on a view
 * with an outer join. The liveness condition is therefore spelled out here,
 * but from LIVE_STATUSES — the same constant the view and the partial indexes
 * are built from, which db/test/schema.test.ts pins to the database.
 */
async function lockFreeSlot(
  trx: Transaction<Database>,
  lotId: string,
): Promise<{ id: string } | undefined> {
  return (
    trx
      .selectFrom('slots')
      .select('slots.id')
      .where('slots.lot_id', '=', lotId)
      .where('slots.app_bookable', '=', true)
      .where('slots.in_service', '=', true)
      // Not destructured: pulling `not`/`exists`/`selectFrom` off the builder
      // detaches them from their `this`.
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bookings')
              .select('bookings.id')
              .whereRef('bookings.slot_id', '=', 'slots.id')
              .where('bookings.status', 'in', [...LIVE_STATUSES]),
          ),
        ),
      )
      .orderBy('slots.zone')
      .orderBy('slots.grid_row')
      .orderBy('slots.grid_col')
      .limit(1)
      .forUpdate('slots')
      .skipLocked()
      .executeTakeFirst()
  );
}

export interface CreateWalkInInput {
  lotId: string;
  slotId: string;
  attendantId: string;
  vehiclePlate?: string | null;
}

/**
 * Park a walk-in on a slot the attendant chose.
 *
 * Lives here, beside createBooking, because it is the OTHER way a booking is
 * born — and because keeping every status-writing INSERT in one file is what
 * makes the single-writer guard in guards.test.ts meaningful. The staff
 * service calls this rather than inserting its own row.
 *
 * Walk-ins have no user, no planned end and no entry credentials: the
 * attendant is standing at the car. They never enter OVERSTAY, so no overstay
 * job is scheduled.
 */
export async function createWalkIn(
  deps: CreateBookingDeps,
  input: CreateWalkInInput,
): Promise<BookingRow> {
  const now = deps.clock.now();

  try {
    return await inTransaction(deps.db, deps.logger, async (trx) => {
      const booking = await trx
        .insertInto('bookings')
        .values({
          lot_id: input.lotId,
          slot_id: input.slotId,
          user_id: null,
          source: 'walk_in',
          status: 'CHECKED_IN',
          vehicle_plate: input.vehiclePlate ?? null,
          planned_minutes: null,
          checked_in_at: now,
          created_by: input.attendantId,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('booking_events')
        .values({
          booking_id: booking.id,
          from_status: null,
          to_status: 'CHECKED_IN',
          actor_id: input.attendantId,
          note: 'walk-in',
          at: now,
        })
        .execute();

      return booking;
    });
  } catch (err) {
    if (isUniqueViolation(err, CONSTRAINTS.liveBookingPerSlot)) {
      throw new AppError('SLOT_TAKEN', 'That slot already has a live booking');
    }
    throw err;
  }
}
