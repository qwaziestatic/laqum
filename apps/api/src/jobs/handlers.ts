import type { Database } from '@laqum/db';
import type { Clock } from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { inTransaction } from '../afterCommit.js';
import { transition } from '../bookings/transition.js';
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
}

export interface JobResult {
  queue: JobQueue;
  bookingId: string;
  applied: boolean;
  /** Why nothing happened. Present only when applied is false. */
  reason?: 'NOT_FOUND' | 'WRONG_STATUS' | 'NOT_DUE' | 'NOT_IMPLEMENTED';
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
