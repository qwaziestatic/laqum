import {
  AppError,
  type BillBreakdown,
  LIVE_STATUSES,
  addMinutes,
  computeBill,
  looksLikeShortCode,
} from '@laqum/shared';
import type { Database } from '@laqum/db';
import type { Selectable } from 'kysely';
import { inTransaction } from '../afterCommit.js';
import { createWalkIn } from '../bookings/create.js';
import { reminderTimeFor } from '../bookings/service.js';
import type { BookingRow } from '../bookings/transition.js';
import { transitionOrThrow } from '../bookings/transition.js';
import type { AppContext } from '../context.js';
import { CONSTRAINTS, isUniqueViolation } from '../db/pgError.js';
import { confirmPayment, type PaymentsContext } from '../payments/service.js';
import { jobIdFor } from '../jobs/scheduler.js';

/** Attendant operations at the gate. */

export async function listStaffedLots(ctx: AppContext, userId: string) {
  return ctx.db
    .selectFrom('lots')
    .innerJoin('lot_staff', 'lot_staff.lot_id', 'lots.id')
    .select([
      'lots.id',
      'lots.name',
      'lots.address',
      'lots.block_minutes',
      'lots.rate_per_block_santim',
      'lots.overstay_rate_per_block_santim',
      'lots.deposit_amount_santim',
    ])
    .where('lot_staff.user_id', '=', userId)
    .orderBy('lots.name')
    .execute();
}

/** The FULL slot_status rows: staff see plates and deadlines, drivers do not. */
export type StaffSlotRow = Selectable<Database['slot_status']>;

export async function listLotSlots(ctx: AppContext, lotId: string): Promise<StaffSlotRow[]> {
  return ctx.db
    .selectFrom('slot_status')
    .selectAll()
    .where('lot_id', '=', lotId)
    .orderBy('zone')
    .orderBy('grid_row')
    .orderBy('grid_col')
    .execute();
}

/**
 * Park a walk-in on a specific slot.
 *
 * The attendant has chosen the slot by looking at the car, so there is no
 * assignment to do. one_live_booking_per_slot still decides: a plain INSERT,
 * and a violation means the dashboard was stale.
 */
export async function parkWalkIn(
  ctx: AppContext,
  attendantId: string,
  lotId: string,
  input: { slotId: string; vehiclePlate?: string | null },
): Promise<BookingRow> {
  const slot = await ctx.db
    .selectFrom('slots')
    .select(['id', 'in_service'])
    .where('id', '=', input.slotId)
    .where('lot_id', '=', lotId)
    .executeTakeFirst();

  if (!slot) throw new AppError('NOT_FOUND', 'No such slot in this lot');
  if (!slot.in_service) {
    throw new AppError('SLOT_IN_USE', 'That slot is out of service');
  }

  // Delegated so that every INSERT of a booking status lives in create.ts.
  return createWalkIn(
    { db: ctx.db, clock: ctx.clock, logger: ctx.logger, scheduler: ctx.scheduler },
    {
      lotId,
      slotId: input.slotId,
      attendantId,
      vehiclePlate: input.vehiclePlate ?? null,
    },
  );
}

/**
 * Check a driver in from a scanned QR token or a manually typed short code.
 *
 * Short codes are only unique among LIVE bookings, so the lookup is scoped to
 * live statuses; QR tokens are globally unique.
 */
export async function checkIn(
  ctx: AppContext,
  attendantId: string,
  code: string,
): Promise<BookingRow> {
  const trimmed = code.trim();
  const isShortCode = looksLikeShortCode(trimmed);

  const found = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .$if(isShortCode, (qb) =>
      qb.where('short_code', '=', trimmed.toUpperCase()).where('status', 'in', [...LIVE_STATUSES]),
    )
    .$if(!isShortCode, (qb) => qb.where('qr_token', '=', trimmed))
    .executeTakeFirst();

  if (!found) throw new AppError('NOT_FOUND', 'No booking matches that code');

  const staffed = await ctx.db
    .selectFrom('lot_staff')
    .select('lot_id')
    .where('lot_id', '=', found.lot_id)
    .where('user_id', '=', attendantId)
    .executeTakeFirst();
  if (!staffed) throw new AppError('FORBIDDEN', 'That booking is not at a lot you staff');

  const now = ctx.clock.now();
  const plannedEndAt = addMinutes(now, found.planned_minutes ?? 0);

  return inTransaction(ctx.db, ctx.logger, async (trx, effects) => {
    const booking = await transitionOrThrow(trx, ctx.clock, {
      bookingId: found.id,
      from: 'RESERVED',
      to: 'CHECKED_IN',
      actorId: attendantId,
      // planned_end_at is set at CHECK-IN, not at booking: the clock starts
      // when the car arrives.
      patch: { checked_in_at: now, planned_end_at: plannedEndAt },
    });

    effects.add(jobIdFor('expire-hold', booking.id), async () => {
      await ctx.scheduler.cancel('expire-hold', booking.id);
    });
    effects.add(jobIdFor('mark-overstay', booking.id), async () => {
      await ctx.scheduler.schedule({
        queue: 'mark-overstay',
        bookingId: booking.id,
        runAt: plannedEndAt,
      });
    });
    effects.add(jobIdFor('time-reminder', booking.id), async () => {
      await ctx.scheduler.schedule({
        queue: 'time-reminder',
        bookingId: booking.id,
        runAt: reminderTimeFor(plannedEndAt),
      });
    });

    return booking;
  });
}

export interface CheckOutResult {
  booking: BookingRow;
  bill: BillBreakdown;
  /** True when the bill was zero and the booking went straight to PAID. */
  settled: boolean;
}

/**
 * Release the slot and compute the bill.
 *
 * A zero bill goes straight to PAID in the SAME transaction: leaving it
 * CHECKED_OUT would block the driver's next booking over nothing owed.
 */
export async function checkOut(
  ctx: AppContext,
  attendantId: string,
  bookingId: string,
): Promise<CheckOutResult> {
  const existing = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', bookingId)
    .executeTakeFirst();
  if (!existing) throw new AppError('NOT_FOUND', 'No such booking');

  const lot = await ctx.db
    .selectFrom('lots')
    .selectAll()
    .where('id', '=', existing.lot_id)
    .executeTakeFirstOrThrow();

  const depositPaid = await sumSuccessfulDeposits(ctx, bookingId);
  const now = ctx.clock.now();

  const bill = computeBill(
    {
      source: existing.source,
      planned_minutes: existing.planned_minutes,
      checked_in_at: existing.checked_in_at,
      planned_end_at: existing.planned_end_at,
      deposit_paid_santim: depositPaid,
    },
    lot,
    now,
  );

  const result = await inTransaction(ctx.db, ctx.logger, async (trx, effects) => {
    let booking = await transitionOrThrow(trx, ctx.clock, {
      bookingId,
      from: ['CHECKED_IN', 'OVERSTAY'],
      to: 'CHECKED_OUT',
      actorId: attendantId,
      patch: { checked_out_at: now, amount_due_santim: bill.amountDueSantim },
    });

    let settled = false;
    if (bill.amountDueSantim === 0) {
      booking = await transitionOrThrow(trx, ctx.clock, {
        bookingId,
        from: 'CHECKED_OUT',
        to: 'PAID',
        actorId: attendantId,
        note: 'nothing to pay',
      });
      settled = true;
    }

    for (const queue of ['mark-overstay', 'time-reminder'] as const) {
      effects.add(jobIdFor(queue, bookingId), async () => {
        await ctx.scheduler.cancel(queue, bookingId);
      });
    }

    return { booking, settled };
  });

  return { ...result, bill };
}

async function sumSuccessfulDeposits(ctx: AppContext, bookingId: string): Promise<number> {
  const rows = await ctx.db
    .selectFrom('payments')
    .select('amount_santim')
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'deposit')
    .where('status', '=', 'success')
    .execute();
  return rows.reduce((total, row) => total + row.amount_santim, 0);
}

/**
 * Record cash and settle the booking.
 *
 * The amount must match the bill exactly. Partial cash would leave a booking
 * that is neither CHECKED_OUT nor PAID in any meaningful sense, and the state
 * machine has no room for it.
 */
export interface RecordCashOptions {
  /**
   * Settle in cash even though an in-app payment is still pending.
   *
   * Requires a deliberate act by the attendant, because the driver may still
   * complete that checkout page. If they do, the money is detected as an
   * overpayment and lands in the operator refund queue.
   */
  overridePending?: boolean;
}

export async function recordCash(
  ctx: PaymentsContext,
  attendantId: string,
  bookingId: string,
  amountSantim: number,
  options: RecordCashOptions = {},
): Promise<BookingRow> {
  const booking = await ctx.db
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', bookingId)
    .executeTakeFirst();
  if (!booking) throw new AppError('NOT_FOUND', 'No such booking');

  if (booking.status !== 'CHECKED_OUT') {
    throw new AppError('STATE_CONFLICT', 'Only a checked-out booking can be settled', {
      status: booking.status,
    });
  }

  /*
   * Before taking cash, ask the provider about any in-flight in-app payment.
   *
   * The driver may have paid on their phone seconds ago and the webhook may
   * not have arrived. Taking cash on top of that charges them twice, and the
   * refund queue is a worse outcome than a question at the gate.
   */
  const pending = await ctx.db
    .selectFrom('payments')
    .selectAll()
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'final')
    .where('status', '=', 'pending')
    .where('tx_ref', 'is not', null)
    .executeTakeFirst();

  if (pending?.tx_ref) {
    const outcome = await confirmPayment(ctx, pending.tx_ref);

    if (outcome.kind === 'confirmed' || outcome.kind === 'already_settled') {
      // They already paid. Do not take the cash.
      throw new AppError('ALREADY_PAID', 'The driver has already paid in the app', {
        txRef: pending.tx_ref,
      });
    }

    if (
      outcome.kind === 'not_successful' &&
      outcome.status === 'pending' &&
      !options.overridePending
    ) {
      throw new AppError(
        'PAYMENT_PENDING',
        'An in-app payment is still pending for this booking. Confirm with the driver, then retry with overridePending.',
        { txRef: pending.tx_ref },
      );
    }
    // 'rejected', 'failed', 'late', or an explicit override: cash proceeds.
  }

  const due = booking.amount_due_santim ?? 0;
  if (amountSantim !== due) {
    throw new AppError('VALIDATION_ERROR', 'Cash must match the amount due exactly', {
      amountDueSantim: due,
      received: amountSantim,
    });
  }

  const now = ctx.clock.now();

  try {
    return await inTransaction(ctx.db, ctx.logger, async (trx) => {
      await trx
        .insertInto('payments')
        .values({
          booking_id: bookingId,
          kind: 'final',
          provider: 'cash',
          amount_santim: amountSantim,
          status: 'success',
          // cash_has_recorder: the schema refuses a cash row without one.
          recorded_by: attendantId,
          created_at: now,
          updated_at: now,
        })
        .execute();

      return await transitionOrThrow(trx, ctx.clock, {
        bookingId,
        from: 'CHECKED_OUT',
        to: 'PAID',
        actorId: attendantId,
        note: 'cash',
      });
    });
  } catch (err) {
    /*
     * An in-app payment settled while the attendant was taking the cash.
     * one_paid_final_per_booking is what decides: only one final payment can
     * ever succeed, and this one lost. The cash was not accepted, so the
     * attendant must be told plainly rather than shown a 500.
     */
    if (isUniqueViolation(err, CONSTRAINTS.paidFinalPerBooking)) {
      throw new AppError('ALREADY_PAID', 'This booking was settled in the app a moment ago');
    }
    throw err;
  }
}

/**
 * Take a slot out of service, or return it.
 *
 * Refused while the slot holds a live booking: the car is still there, and a
 * slot that is both out of service and occupied is a state the dashboard
 * cannot act on.
 */
export async function setSlotService(
  ctx: AppContext,
  slotId: string,
  inService: boolean,
): Promise<{ slotId: string; inService: boolean }> {
  const slot = await ctx.db
    .selectFrom('slots')
    .select(['id', 'lot_id'])
    .where('id', '=', slotId)
    .executeTakeFirst();
  if (!slot) throw new AppError('NOT_FOUND', 'No such slot');

  if (!inService) {
    const live = await ctx.db
      .selectFrom('bookings')
      .select('id')
      .where('slot_id', '=', slotId)
      .where('status', 'in', [...LIVE_STATUSES])
      .executeTakeFirst();

    if (live) {
      throw new AppError(
        'SLOT_IN_USE',
        'Check the car out before taking this slot out of service',
        {
          bookingId: live.id,
        },
      );
    }
  }

  await ctx.db
    .updateTable('slots')
    .set({ in_service: inService })
    .where('id', '=', slotId)
    .execute();
  return { slotId, inService };
}
