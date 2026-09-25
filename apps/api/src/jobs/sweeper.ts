import { LIVE_STATUSES } from '@laqum/shared';
import {
  ExpiryDeferredError,
  expireHold,
  markOverstay,
  type JobDeps,
  type JobResult,
} from './handlers.js';

/**
 * The safety net.
 *
 * Delayed jobs are the fast path; this catches anything they missed — a
 * flushed Redis, a worker that was down, a job that was never enqueued because
 * the process died between commit and schedule.
 *
 * It re-uses the SAME handlers, so it cannot drift from them and inherits
 * their idempotency: a booking a delayed job already handled is simply not
 * found by these queries.
 *
 * The `now` bound comes from the injected clock as a query PARAMETER. Using
 * Postgres' now() here would make the sweeper untestable without sleeping.
 */

export interface SweepReport {
  expired: JobResult[];
  overstayed: JobResult[];
  /** Rows the queries found. Not all of them necessarily applied. */
  examined: number;
}

/** Bounded so one sweep cannot monopolise a connection on a large backlog. */
const SWEEP_LIMIT = 500;

export async function sweep(deps: JobDeps): Promise<SweepReport> {
  const now = deps.clock.now();

  const overdueHolds = await deps.db
    .selectFrom('bookings')
    .select('id')
    // Uses bookings_hold_expiry: PENDING_PAYMENT or RESERVED, by deadline.
    .where('status', 'in', ['PENDING_PAYMENT', 'RESERVED'])
    .where('hold_expires_at', '<=', now)
    .orderBy('hold_expires_at')
    .limit(SWEEP_LIMIT)
    .execute();

  const overdueEnds = await deps.db
    .selectFrom('bookings')
    .select('id')
    // Uses bookings_planned_end.
    .where('status', '=', 'CHECKED_IN')
    .where('planned_end_at', '<=', now)
    .orderBy('planned_end_at')
    .limit(SWEEP_LIMIT)
    .execute();

  const expired: JobResult[] = [];
  for (const row of overdueHolds) {
    expired.push(await expireOrDefer(deps, row.id));
  }

  const overstayed: JobResult[] = [];
  for (const row of overdueEnds) {
    overstayed.push(await markOverstay(deps, row.id));
  }

  const applied = [...expired, ...overstayed].filter((r) => r.applied).length;
  if (applied > 0) {
    deps.logger.info(
      { applied, examined: overdueHolds.length + overdueEnds.length },
      'sweeper applied overdue transitions the delayed jobs missed',
    );
  }

  return { expired, overstayed, examined: overdueHolds.length + overdueEnds.length };
}

/**
 * One deferred expiry must not end the sweep.
 *
 * expireHold THROWS while the provider cannot be asked about an initialized
 * deposit, so that BullMQ retries the job. Here that throw used to abandon
 * the loop, skipping every later hold and every overstay: one provider outage
 * switched the safety net off for the whole system. The booking is reported
 * and the next sweep asks again.
 */
async function expireOrDefer(deps: JobDeps, bookingId: string): Promise<JobResult> {
  try {
    return await expireHold(deps, bookingId);
  } catch (err) {
    if (!(err instanceof ExpiryDeferredError)) throw err;
    return { queue: 'expire-hold', bookingId, applied: false, reason: 'DEFERRED' };
  }
}

/** Exported so a test can assert the sweeper and the view agree on "live". */
export const SWEPT_STATUSES = LIVE_STATUSES;
