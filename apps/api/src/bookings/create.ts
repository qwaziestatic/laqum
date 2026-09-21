import type { Database } from '@laqum/db';
import {
  AppError,
  type BookingStatus,
  type Clock,
  addMinutes,
  haversineMeters,
} from '@laqum/shared';
import type { Kysely, Selectable } from 'kysely';
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
 * Assign a slot by attempting the insert, never by checking first.
 *
 * The candidate list is an ORDERING HINT, not a guard: between reading it and
 * inserting, another driver may take the slot. That is precisely what
 * one_live_booking_per_slot is for, and a 23505 simply means we move on. This
 * is why the brief forbids check-then-insert.
 *
 * Each attempt runs in its OWN transaction. A failed statement aborts its
 * transaction, and an aborted transaction cannot continue — so retrying inside
 * one transaction would fail with "current transaction is aborted" instead of
 * trying the next slot.
 */
async function insertIntoFirstFreeSlot(
  deps: CreateBookingDeps,
  input: CreateBookingInput,
  lot: LotRow,
  status: BookingStatus,
  holdMinutes: number,
): Promise<BookingRow> {
  const candidates = await freeSlotCandidates(deps.db, lot.id, MAX_SLOT_ATTEMPTS);

  for (const slotId of candidates) {
    const booking = await tryInsert(deps, input, lot, status, holdMinutes, slotId);
    if (booking) return booking;
  }

  throw new AppError('LOT_FULL', 'No slot is available in this lot right now');
}

/**
 * Free, app-bookable, in-service slots in the brief's order.
 *
 * Read through slot_status so "free" has exactly one definition, the view's.
 */
async function freeSlotCandidates(
  db: Kysely<Database>,
  lotId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .selectFrom('slot_status')
    .select('slot_id')
    .where('lot_id', '=', lotId)
    .where('display_status', '=', 'free')
    .where('app_bookable', '=', true)
    .orderBy('zone')
    .orderBy('grid_row')
    .orderBy('grid_col')
    .limit(limit)
    .execute();

  return rows.flatMap((row) => (row.slot_id === null ? [] : [row.slot_id]));
}

/** Null when this slot was taken by someone else; throws for anything else. */
async function tryInsert(
  deps: CreateBookingDeps,
  input: CreateBookingInput,
  lot: LotRow,
  status: BookingStatus,
  holdMinutes: number,
  slotId: string,
): Promise<BookingRow | null> {
  for (let codeAttempt = 0; codeAttempt < MAX_CODE_ATTEMPTS; codeAttempt++) {
    const now = deps.clock.now();
    const holdExpiresAt = addMinutes(now, holdMinutes);

    try {
      return await inTransaction(deps.db, deps.logger, async (trx, effects) => {
        const booking = await trx
          .insertInto('bookings')
          .values({
            lot_id: lot.id,
            slot_id: slotId,
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

        return booking;
      });
    } catch (err) {
      // Someone else took this slot. Move to the next candidate.
      if (isUniqueViolation(err, CONSTRAINTS.liveBookingPerSlot)) return null;

      // Another slot will not help: this driver already holds a live booking.
      if (isUniqueViolation(err, CONSTRAINTS.liveBookingPerUser)) {
        throw new AppError('ALREADY_HAS_ACTIVE_BOOKING', 'You already have an active booking');
      }

      // A generated code collided. Regenerate and retry the SAME slot.
      if (
        isUniqueViolation(err, CONSTRAINTS.liveBookingPerShortCode) ||
        isUniqueViolation(err, CONSTRAINTS.qrToken)
      ) {
        deps.logger.warn({ slotId, codeAttempt }, 'booking code collision; regenerating');
        continue;
      }

      throw err;
    }
  }

  throw new AppError(
    'INTERNAL',
    `Could not generate a unique booking code after ${MAX_CODE_ATTEMPTS} attempts`,
  );
}
