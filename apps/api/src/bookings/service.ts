import { AppError, LIVE_STATUSES, type Clock, addMinutes } from '@laqum/shared';
import { inTransaction } from '../afterCommit.js';
import type { AppContext } from '../context.js';
import { jobIdFor } from '../jobs/scheduler.js';
import type { BookingRow } from './transition.js';
import { transitionOrThrow } from './transition.js';

/**
 * Driver-facing booking operations.
 *
 * Every read is scoped by user_id: a driver may only ever see their own
 * booking, and an unknown id is indistinguishable from someone else's.
 */

async function ownedBooking(
  ctx: AppContext,
  userId: string,
  bookingId: string,
): Promise<BookingRow> {
  const booking = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', bookingId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!booking) throw new AppError('NOT_FOUND', 'No such booking');
  return booking;
}

export { ownedBooking };

/**
 * The booking that currently needs the driver's attention.
 *
 * A live booking first; otherwise an unpaid CHECKED_OUT one, because that is
 * what blocks them from booking again and is the thing they must act on.
 */
export async function currentBooking(ctx: AppContext, userId: string): Promise<BookingRow | null> {
  const live = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', 'in', [...LIVE_STATUSES])
    .executeTakeFirst();

  if (live) return live;

  const unpaid = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', '=', 'CHECKED_OUT')
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();

  return unpaid ?? null;
}

/** Driver cancels before arrival. The deposit is kept. */
export async function cancelBooking(
  ctx: AppContext,
  userId: string,
  bookingId: string,
): Promise<BookingRow> {
  await ownedBooking(ctx, userId, bookingId);

  return inTransaction(ctx.db, ctx.logger, async (trx, effects) => {
    const booking = await transitionOrThrow(trx, ctx.clock, {
      bookingId,
      from: 'RESERVED',
      to: 'CANCELLED',
      actorId: userId,
      note: 'cancelled by driver',
    });

    // The hold is gone, so its expiry job is pointless.
    effects.add(jobIdFor('expire-hold', bookingId), async () => {
      await ctx.scheduler.cancel('expire-hold', bookingId);
    });

    return booking;
  });
}

export interface ExtendResult {
  booking: BookingRow;
  addedMinutes: number;
}

/**
 * Extend a stay, in whole blocks.
 *
 * Allowed only while CHECKED_IN and BEFORE planned_end_at: once the deadline
 * passes the booking is heading for OVERSTAY, which is billed at a different
 * rate, and letting a driver extend retroactively would let them buy their way
 * out of it at the cheaper price.
 *
 * This is not a status change, so it does not go through transition(). It does
 * move planned_end_at, which means the overstay job must be RESCHEDULED —
 * a stale job would otherwise fire at the old deadline. transition()'s due
 * guard is the second line of defence if that reschedule is ever missed.
 */
export async function extendBooking(
  ctx: AppContext,
  userId: string,
  bookingId: string,
  additionalBlocks: number,
): Promise<ExtendResult> {
  const existing = await ownedBooking(ctx, userId, bookingId);

  if (existing.status !== 'CHECKED_IN') {
    throw new AppError('STATE_CONFLICT', 'Only a checked-in booking can be extended', {
      status: existing.status,
    });
  }

  const now = ctx.clock.now();
  if (existing.planned_end_at === null || existing.planned_end_at.getTime() <= now.getTime()) {
    throw new AppError('STATE_CONFLICT', 'This booking has already reached its planned end');
  }

  const lot = await ctx.db
    .selectFrom('lots')
    .select('block_minutes')
    .where('id', '=', existing.lot_id)
    .executeTakeFirstOrThrow();

  const addedMinutes = additionalBlocks * lot.block_minutes;
  const plannedMinutes = (existing.planned_minutes ?? 0) + addedMinutes;
  const plannedEndAt = addMinutes(existing.planned_end_at, addedMinutes);

  const booking = await inTransaction(ctx.db, ctx.logger, async (trx, effects) => {
    // No status column is written here, so this is not a transition.
    const updated = await trx
      .updateTable('bookings')
      .set({
        planned_minutes: plannedMinutes,
        planned_end_at: plannedEndAt,
        updated_at: now,
      })
      .where('id', '=', bookingId)
      .where('status', '=', 'CHECKED_IN')
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      throw new AppError('STATE_CONFLICT', 'This booking changed while being extended');
    }

    effects.add(jobIdFor('mark-overstay', bookingId), async () => {
      await ctx.scheduler.schedule({
        queue: 'mark-overstay',
        bookingId,
        runAt: plannedEndAt,
      });
    });
    effects.add(jobIdFor('time-reminder', bookingId), async () => {
      await ctx.scheduler.schedule({
        queue: 'time-reminder',
        bookingId,
        runAt: reminderTimeFor(plannedEndAt),
      });
    });

    return updated;
  });

  return { booking, addedMinutes };
}

/** Ten minutes before the planned end, per the brief. */
export const REMINDER_LEAD_MINUTES = 10;

export function reminderTimeFor(plannedEndAt: Date): Date {
  return addMinutes(plannedEndAt, -REMINDER_LEAD_MINUTES);
}

/** Exposed for the staff check-in path, which schedules the same jobs. */
export function overstayScheduleFor(
  _clock: Clock,
  plannedEndAt: Date,
): { overstayAt: Date; reminderAt: Date } {
  return { overstayAt: plannedEndAt, reminderAt: reminderTimeFor(plannedEndAt) };
}
