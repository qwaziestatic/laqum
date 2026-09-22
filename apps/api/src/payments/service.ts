import { randomBytes } from 'node:crypto';
import type { Database } from '@laqum/db';
import {
  AppError,
  PAYMENT_CURRENCY,
  type PaymentNotice,
  type RefundReason,
  providerAmountToSantim,
} from '@laqum/shared';
import { sql, type Selectable } from 'kysely';
import { inTransaction } from '../afterCommit.js';
import { transition } from '../bookings/transition.js';
import type { AppContext } from '../context.js';
import { jobIdFor } from '../jobs/scheduler.js';
import { CONSTRAINTS, isUniqueViolation } from '../db/pgError.js';
import { isProviderUnavailable, type VerifyResult } from './provider.js';

export type PaymentRow = Selectable<Database['payments']>;

/** Our reference, sent to the provider and used to look the payment back up. */
export function makeTxRef(kind: 'dep' | 'fin'): string {
  return `laqum-${kind}-${randomBytes(12).toString('hex')}`;
}

/** AppContext already carries the provider; the alias keeps call sites clear. */
export type PaymentsContext = AppContext;

// ─── Integrity ────────────────────────────────────────────────────────────

export type IntegrityFailure =
  | { field: 'status'; expected: string; actual: string }
  | { field: 'amount'; expected: number; actual: number }
  | { field: 'currency'; expected: string; actual: string }
  | { field: 'tx_ref'; expected: string; actual: string };

/**
 * A provider's "success" is not sufficient to move money in our ledger.
 *
 * The confirmed amount, currency and reference must match the row we created
 * BEFORE the customer was sent to the checkout page. Anything else means we
 * are looking at a different transaction, a tampered callback, or a price that
 * changed under us — none of which may settle a booking.
 */
export function checkIntegrity(payment: PaymentRow, verified: VerifyResult): IntegrityFailure[] {
  const failures: IntegrityFailure[] = [];

  if (verified.status !== 'success') {
    failures.push({ field: 'status', expected: 'success', actual: verified.status });
  }
  if (verified.amountSantim !== payment.amount_santim) {
    failures.push({
      field: 'amount',
      expected: payment.amount_santim,
      actual: verified.amountSantim,
    });
  }
  if (verified.currency !== PAYMENT_CURRENCY) {
    failures.push({ field: 'currency', expected: PAYMENT_CURRENCY, actual: verified.currency });
  }
  // Chapa v1 binds the reference in the verify URL, so an echoed field is a
  // bonus rather than the guarantee. When it is present it must still agree.
  if (
    verified.txRef !== undefined &&
    payment.tx_ref !== null &&
    verified.txRef !== payment.tx_ref
  ) {
    failures.push({ field: 'tx_ref', expected: payment.tx_ref, actual: verified.txRef });
  }

  return failures;
}

/** Ask the provider, converting its decimal amount to santim on the way in. */
export async function verifyWithProvider(
  ctx: PaymentsContext,
  txRef: string,
): Promise<VerifyResult> {
  try {
    return await ctx.provider.verify(txRef);
  } catch (err) {
    if (isProviderUnavailable(err)) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The payment provider could not be reached');
    }
    throw err;
  }
}

// ─── Confirmation ─────────────────────────────────────────────────────────

export type ConfirmOutcome =
  | { kind: 'confirmed'; payment: PaymentRow; bookingStatus: string }
  /** Money is real, but the booking could not accept it. Operator refund. */
  | { kind: 'late'; payment: PaymentRow; reason: RefundReason }
  | { kind: 'rejected'; failures: IntegrityFailure[] }
  | { kind: 'not_successful'; status: string }
  | { kind: 'already_settled'; payment: PaymentRow }
  | { kind: 'unknown_reference' };

/**
 * Confirm a payment from its reference, by asking the provider.
 *
 * This is the ONLY path that marks a payment successful. It is called by the
 * webhook worker, by the expiry pre-check, and by the cash endpoint, so all
 * three agree on what "paid" means. It is idempotent: a payment already marked
 * success returns `already_settled` without touching anything.
 */
export async function confirmPayment(ctx: PaymentsContext, txRef: string): Promise<ConfirmOutcome> {
  const payment = await ctx.db
    .selectFrom('payments')
    .selectAll()
    .where('tx_ref', '=', txRef)
    .executeTakeFirst();

  if (!payment) return { kind: 'unknown_reference' };
  if (payment.status === 'success') return { kind: 'already_settled', payment };

  const verified = await verifyWithProvider(ctx, txRef);
  const failures = checkIntegrity(payment, verified);

  if (failures.length > 0) {
    const onlyStatus = failures.every((f) => f.field === 'status');

    if (!onlyStatus) {
      // An amount or currency disagreement is not a "not yet paid"; it is a
      // discrepancy an operator must see. Recorded as failed, with the whole
      // provider response kept for the dispute.
      await ctx.db
        .updateTable('payments')
        .set({
          status: 'failed',
          provider_payload: JSON.stringify({ verified: verified.raw, failures }),
          updated_at: ctx.clock.now(),
        })
        .where('id', '=', payment.id)
        .execute();

      ctx.logger.error(
        { txRef, bookingId: payment.booking_id, failures },
        'payment REJECTED: the provider confirmed something other than what we recorded',
      );
      return { kind: 'rejected', failures };
    }

    // Simply not paid yet, or failed at the provider. Leave the row pending so
    // a later webhook can still settle it.
    return { kind: 'not_successful', status: verified.status };
  }

  return payment.kind === 'deposit'
    ? settleDeposit(ctx, payment, verified)
    : settleFinal(ctx, payment, verified);
}

/**
 * A confirmed deposit moves PENDING_PAYMENT to RESERVED.
 *
 * If the booking already expired, EXPIRED -> RESERVED stays illegal: the money
 * is still recorded truthfully, and the booking stays expired. That pair is
 * the late-deposit case, and it is what the operator refund queue finds.
 */
async function settleDeposit(
  ctx: PaymentsContext,
  payment: PaymentRow,
  verified: VerifyResult,
): Promise<ConfirmOutcome> {
  const now = ctx.clock.now();

  return inTransaction(ctx.db, ctx.logger, async (trx, effects) => {
    const settled = await trx
      .updateTable('payments')
      .set({
        status: 'success',
        provider_payload: JSON.stringify(verified.raw),
        updated_at: now,
      })
      .where('id', '=', payment.id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();

    if (!settled) {
      // Another delivery won. one_paid_deposit_per_booking guarantees only one
      // of them could have.
      const current = await trx
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', payment.id)
        .executeTakeFirstOrThrow();
      return { kind: 'already_settled', payment: current };
    }

    const booking = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', payment.booking_id)
      .executeTakeFirstOrThrow();

    if (booking.status !== 'PENDING_PAYMENT') {
      ctx.logger.warn(
        { txRef: payment.tx_ref, bookingId: booking.id, bookingStatus: booking.status },
        'deposit confirmed for a booking that is no longer awaiting payment; queued for refund',
      );
      return { kind: 'late', payment: settled, reason: 'late_deposit' };
    }

    const lot = await trx
      .selectFrom('lots')
      .select('hold_minutes')
      .where('id', '=', booking.lot_id)
      .executeTakeFirstOrThrow();

    const holdExpiresAt = new Date(now.getTime() + lot.hold_minutes * 60_000);

    const outcome = await transition(trx, ctx.clock, {
      bookingId: booking.id,
      from: 'PENDING_PAYMENT',
      to: 'RESERVED',
      actorId: null,
      note: 'deposit confirmed',
      // Entering RESERVED restarts the clock as the arrival window.
      patch: { hold_expires_at: holdExpiresAt },
    });

    if (!outcome.ok) {
      return { kind: 'late', payment: settled, reason: 'late_deposit' };
    }

    effects.add(jobIdFor('expire-hold', booking.id), async () => {
      await ctx.scheduler.schedule({
        queue: 'expire-hold',
        bookingId: booking.id,
        runAt: holdExpiresAt,
      });
    });

    return { kind: 'confirmed', payment: settled, bookingStatus: 'RESERVED' };
  });
}

/**
 * Marks a confirmed-but-unrecordable payment for refund.
 *
 * one_paid_final_per_booking permits AT MOST ONE successful final payment per
 * booking, so when a second one is genuinely collected our ledger cannot
 * record it as success. The row is therefore marked `failed` — meaning "not
 * accepted into our ledger", not "the driver was not charged" — and
 * provider_payload carries the provider's truth plus `refundOwed`, which is
 * what the operator refund queue looks for.
 */
async function flagAsOverpayment(
  ctx: PaymentsContext,
  payment: PaymentRow,
  verified: VerifyResult,
): Promise<ConfirmOutcome> {
  await ctx.db
    .updateTable('payments')
    .set({
      status: 'failed',
      provider_payload: JSON.stringify({
        providerConfirmed: true,
        refundOwed: true,
        note: 'collected by the provider but this booking already has a settled final payment',
        verified: verified.raw,
      }),
      updated_at: ctx.clock.now(),
    })
    .where('id', '=', payment.id)
    .execute();

  ctx.logger.warn(
    { txRef: payment.tx_ref, bookingId: payment.booking_id, amountSantim: payment.amount_santim },
    'OVERPAYMENT: the provider collected a final payment this booking had already settled',
  );

  const flagged = await ctx.db
    .selectFrom('payments')
    .selectAll()
    .where('id', '=', payment.id)
    .executeTakeFirstOrThrow();

  return { kind: 'late', payment: flagged, reason: 'overpayment' };
}

/** A confirmed final payment moves CHECKED_OUT to PAID. */
async function settleFinal(
  ctx: PaymentsContext,
  payment: PaymentRow,
  verified: VerifyResult,
): Promise<ConfirmOutcome> {
  const now = ctx.clock.now();

  /*
   * Cheap pre-check for the sequential case. It cannot see an uncommitted
   * competitor, so the unique violation below is the real guard.
   *
   * `id != payment.id` is load-bearing. Two concurrent confirmations of the
   * SAME tx_ref both reach here; if one has already settled this very row,
   * the other would otherwise find "a successful final exists", flag THIS row
   * as an overpayment, and turn a successful payment back into a failed one.
   */
  const alreadySettled = await ctx.db
    .selectFrom('payments')
    .select('id')
    .where('booking_id', '=', payment.booking_id)
    .where('kind', '=', 'final')
    .where('status', '=', 'success')
    .where('id', '!=', payment.id)
    .executeTakeFirst();

  if (alreadySettled) return flagAsOverpayment(ctx, payment, verified);

  try {
    return await inTransaction(ctx.db, ctx.logger, async (trx) => {
      const settled = await trx
        .updateTable('payments')
        .set({
          status: 'success',
          provider_payload: JSON.stringify(verified.raw),
          updated_at: now,
        })
        .where('id', '=', payment.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();

      if (!settled) {
        const current = await trx
          .selectFrom('payments')
          .selectAll()
          .where('id', '=', payment.id)
          .executeTakeFirstOrThrow();
        return { kind: 'already_settled', payment: current };
      }

      const outcome = await transition(trx, ctx.clock, {
        bookingId: payment.booking_id,
        from: 'CHECKED_OUT',
        to: 'PAID',
        actorId: null,
        note: 'paid in app',
      });

      if (!outcome.ok) {
        // The booking moved on without us. Roll the whole attempt back and
        // record it as an overpayment outside this transaction.
        throw new DuplicateFinalError();
      }

      return { kind: 'confirmed', payment: settled, bookingStatus: 'PAID' };
    });
  } catch (err) {
    // A cash settlement committed while we were mid-flight: its index entry
    // is what this collides with.
    if (
      err instanceof DuplicateFinalError ||
      isUniqueViolation(err, CONSTRAINTS.paidFinalPerBooking)
    ) {
      return flagAsOverpayment(ctx, payment, verified);
    }
    throw err;
  }
}

/** Internal signal: the booking was settled by someone else mid-transaction. */
class DuplicateFinalError extends Error {
  constructor() {
    super('another final payment settled this booking first');
    this.name = 'DuplicateFinalError';
  }
}

// ─── The operator refund queue ────────────────────────────────────────────

export interface RefundQueueItem {
  paymentId: string;
  bookingId: string;
  txRef: string | null;
  kind: string;
  amountSantim: number;
  collectedAt: Date;
  bookingStatus: string;
  lotId: string;
  reason: RefundReason;
}

/**
 * Money we hold that the driver should get back.
 *
 * A QUERY, not a table — which is why this phase needs no migration. Two
 * shapes qualify:
 *
 *   late_deposit  a successful deposit on a booking that NEVER reached
 *                 RESERVED. The driver paid and got no held slot. This is not
 *                 the brief's "deposit is kept on EXPIRED", which is about a
 *                 no-show who did hold a slot.
 *   overpayment   a successful final payment on a booking that already has
 *                 another successful final payment (cash and app collided).
 *
 * Anything already refunded drops out.
 */
export async function refundQueue(
  ctx: AppContext,
  options: { lotIds?: string[] } = {},
): Promise<RefundQueueItem[]> {
  let query = ctx.db
    .selectFrom('payments as p')
    .innerJoin('bookings as b', 'b.id', 'p.booking_id')
    .select([
      'p.id as paymentId',
      'p.booking_id as bookingId',
      'p.tx_ref as txRef',
      'p.kind as kind',
      'p.amount_santim as amountSantim',
      'p.created_at as collectedAt',
      'b.status as bookingStatus',
      'b.lot_id as lotId',
    ])
    .where('p.kind', '!=', 'refund')
    // Not already refunded.
    // Not destructured: pulling these off the builder detaches them from `this`.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('payments as r')
            .select('r.id')
            .whereRef('r.booking_id', '=', 'p.booking_id')
            .where('r.kind', '=', 'refund')
            .where('r.status', '=', 'success'),
        ),
      ),
    )
    .where((eb) =>
      eb.or([
        // A deposit on a booking that never reached RESERVED.
        eb.and([
          eb('p.kind', '=', 'deposit'),
          eb('p.status', '=', 'success'),
          eb.not(
            eb.exists(
              eb
                .selectFrom('booking_events as e')
                .select('e.id')
                .whereRef('e.booking_id', '=', 'p.booking_id')
                .where('e.to_status', '=', 'RESERVED'),
            ),
          ),
        ]),
        /*
         * A final payment the provider collected but our ledger could not
         * record, because one_paid_final_per_booking permits only ONE
         * successful final per booking. There can never be two success rows
         * to compare, so the flag written by flagAsOverpayment is the signal.
         */
        eb.and([
          eb('p.kind', '=', 'final'),
          eb('p.status', '=', 'failed'),
          eb(sql<string>`p.provider_payload ->> 'refundOwed'`, '=', 'true'),
        ]),
      ]),
    )
    .orderBy('p.created_at');

  if (options.lotIds !== undefined) {
    if (options.lotIds.length === 0) return [];
    query = query.where('b.lot_id', 'in', options.lotIds);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    ...row,
    reason: (row.kind === 'deposit' ? 'late_deposit' : 'overpayment') satisfies RefundReason,
  }));
}

/** What the driver is shown about money on this booking. */
export async function paymentNoticeFor(
  ctx: AppContext,
  bookingId: string,
): Promise<PaymentNotice | null> {
  const queued = await refundQueue(ctx);
  const mine = queued.find((item) => item.bookingId === bookingId);
  if (mine) {
    return mine.reason === 'late_deposit' ? 'deposit_refund_pending' : 'overpayment_refund_pending';
  }

  const pending = await ctx.db
    .selectFrom('payments')
    .select('id')
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'pending')
    .executeTakeFirst();

  return pending ? 'payment_pending' : null;
}

/** Re-exported so callers do not import the shared converter separately. */
export { providerAmountToSantim };
