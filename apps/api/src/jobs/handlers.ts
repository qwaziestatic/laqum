import type { Database } from '@laqum/db';
import type { Clock } from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { inTransaction } from '../afterCommit.js';
import { transition } from '../bookings/transition.js';
import { isAppError } from '@laqum/shared';
import { confirmPayment, type PaymentsContext } from '../payments/service.js';
import type { JobQueue } from './scheduler.js';

/**
 * Job handlers are PURE FUNCTIONS of their dependencies and a booking id.
 *
 * BullMQ is a thin adapter over them, so idempotency and timing can be tested
 * by calling a handler twice with a FakeClock — no Redis, no sleeping, no
 * waiting for a queue to drain.
 *
 * INVARIANT 6: every handler goes through transition(). A booking that has
 * already moved on is a no-op, not an error, which is what makes running a
 * job twice identical to running it once.
 */

export interface JobDeps {
  db: Kysely<Database>;
  clock: Clock;
  logger: Logger;
  /**
   * Present in the running application; omitted by tests that exercise the
   * handlers in isolation. Without it the payment pre-check is skipped, which
   * is the pre-Phase-2 behaviour.
   */
  payments?: PaymentsContext | undefined;
}

export interface JobResult {
  queue: JobQueue;
  bookingId: string;
  applied: boolean;
  /** Why nothing happened. Present only when applied is false. */
  reason?:
    | 'NOT_FOUND'
    | 'WRONG_STATUS'
    | 'NOT_DUE'
    | 'NOT_IMPLEMENTED'
    /** The provider confirmed the deposit; the booking was reserved instead. */
    | 'PAYMENT_CONFIRMED';
}

/**
 * A pending deposit could not be checked because the provider is unreachable.
 *
 * Thrown, not returned: BullMQ retries a thrown job with backoff, and the
 * sweeper tries again next minute. Expiring on "I don't know" would destroy a
 * reservation the driver has already paid for.
 */
export class ExpiryDeferredError extends Error {
  readonly bookingId: string;

  constructor(bookingId: string) {
    super(`Deferring expiry of ${bookingId}: the payment provider is unreachable`);
    this.name = 'ExpiryDeferredError';
    this.bookingId = bookingId;
  }
}

/**
 * The hold lapsed: either the payment window (PENDING_PAYMENT) or the arrival
 * window (RESERVED). The deposit is kept in both cases.
 *
 * Guarded on hold_expires_at as well as status. A stale job left over from
 * before a PENDING_PAYMENT -> RESERVED transition would otherwise find the
 * booking in an allowed status and expire a driver who is still en route.
 */
export async function expireHold(deps: JobDeps, bookingId: string): Promise<JobResult> {
  const now = deps.clock.now();

  /*
   * Never expire a booking whose payment might have succeeded.
   *
   * A webhook can be delayed or lost. Before letting the hold lapse, ask the
   * provider directly about any pending deposit for this booking. A success
   * reserves the booking instead of expiring it.
   */
  const confirmed = await checkPendingDeposit(deps, bookingId, now);
  if (confirmed) {
    return { queue: 'expire-hold', bookingId, applied: false, reason: 'PAYMENT_CONFIRMED' };
  }

  return inTransaction(deps.db, deps.logger, async (trx) => {
    const outcome = await transition(trx, deps.clock, {
      bookingId,
      from: ['PENDING_PAYMENT', 'RESERVED'],
      to: 'EXPIRED',
      actorId: null,
      note: 'hold expired',
      due: { column: 'hold_expires_at', notAfter: now },
    });

    return outcome.ok
      ? { queue: 'expire-hold' as const, bookingId, applied: true }
      : { queue: 'expire-hold' as const, bookingId, applied: false, reason: outcome.reason };
  });
}

/**
 * The planned end passed and the car is still there.
 *
 * Guarded on planned_end_at. THE case this prevents: a booking is CHECKED_IN
 * until 09:00, a job is queued for 09:00, the driver extends to 10:00. Without
 * the time guard the stale 09:00 job still finds CHECKED_IN and marks the car
 * over an hour early, at the overstay rate.
 */
export async function markOverstay(deps: JobDeps, bookingId: string): Promise<JobResult> {
  const now = deps.clock.now();

  return inTransaction(deps.db, deps.logger, async (trx) => {
    const outcome = await transition(trx, deps.clock, {
      bookingId,
      from: 'CHECKED_IN',
      to: 'OVERSTAY',
      actorId: null,
      note: 'planned end passed',
      due: { column: 'planned_end_at', notAfter: now },
    });

    return outcome.ok
      ? { queue: 'mark-overstay' as const, bookingId, applied: true }
      : { queue: 'mark-overstay' as const, bookingId, applied: false, reason: outcome.reason };
  });
}

/**
 * Ten minutes before the planned end.
 *
 * Push notification only — no state change. Sending is Phase 5, so this is a
 * deliberate no-op that records the intent rather than a silently missing job.
 */
export function timeReminder(deps: JobDeps, bookingId: string): Promise<JobResult> {
  deps.logger.debug({ bookingId }, 'time-reminder: push notifications arrive in Phase 5');
  return Promise.resolve({
    queue: 'time-reminder',
    bookingId,
    applied: false,
    reason: 'NOT_IMPLEMENTED',
  });
}

export const JOB_HANDLERS = {
  'expire-hold': expireHold,
  'mark-overstay': markOverstay,
  'time-reminder': timeReminder,
} as const satisfies Record<JobQueue, (deps: JobDeps, bookingId: string) => Promise<JobResult>>;

/**
 * Returns true when a pending deposit turned out to be paid, in which case the
 * booking has been reserved and must not expire.
 *
 * Throws ExpiryDeferredError while the provider is unreachable, up to
 * PAYMENT_VERIFY_DEFERRAL_MINUTES past the deadline. Past that bound it gives
 * up and lets the expiry proceed: one outage must not hold a slot forever, and
 * a payment that lands afterwards is caught by the operator refund queue.
 */
async function checkPendingDeposit(deps: JobDeps, bookingId: string, now: Date): Promise<boolean> {
  const payments = deps.payments;
  if (!payments) return false;

  const booking = await deps.db
    .selectFrom('bookings')
    .select(['status', 'hold_expires_at'])
    .where('id', '=', bookingId)
    .executeTakeFirst();

  // Only a booking still awaiting payment can have an unsettled deposit. A
  // RESERVED booking's deposit already succeeded, or there was never one.
  if (booking?.status !== 'PENDING_PAYMENT') return false;

  const pending = await deps.db
    .selectFrom('payments')
    .select(['tx_ref'])
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'deposit')
    .where('status', '=', 'pending')
    .where('tx_ref', 'is not', null)
    .executeTakeFirst();

  if (!pending?.tx_ref) return false;

  try {
    const outcome = await confirmPayment(payments, pending.tx_ref);
    if (outcome.kind === 'confirmed') {
      deps.logger.info(
        { bookingId, txRef: pending.tx_ref },
        'expiry cancelled: the provider confirmed the deposit after all',
      );
      return true;
    }
    if (outcome.kind === 'already_settled') return true;
    return false;
  } catch (err) {
    if (!isAppError(err) || err.code !== 'PROVIDER_UNAVAILABLE') throw err;

    const deadline = booking.hold_expires_at;
    const deferralMs = payments.config.PAYMENT_VERIFY_DEFERRAL_MINUTES * 60_000;
    const pastDeadlineMs = deadline === null ? 0 : now.getTime() - deadline.getTime();

    if (pastDeadlineMs <= deferralMs) {
      deps.logger.warn(
        { bookingId, txRef: pending.tx_ref, pastDeadlineMs },
        'deferring expiry: the payment provider is unreachable',
      );
      throw new ExpiryDeferredError(bookingId);
    }

    deps.logger.error(
      { bookingId, txRef: pending.tx_ref, pastDeadlineMs, deferralMs },
      'EXPIRING an unverified booking: the provider has been unreachable past the deferral bound. ' +
        'If the payment later succeeds it will appear in the operator refund queue.',
    );
    return false;
  }
}
