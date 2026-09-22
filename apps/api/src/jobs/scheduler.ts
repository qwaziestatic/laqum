/**
 * Job scheduling, behind an interface.
 *
 * The BullMQ implementation lands with the jobs commit. Services depend on
 * this interface so that scheduling can be asserted precisely in tests, and so
 * that the after-commit rule is visible at the call site.
 */

export const JOB_QUEUES = ['expire-hold', 'mark-overstay', 'time-reminder'] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

export interface ScheduledJob {
  queue: JobQueue;
  bookingId: string;
  /** When the job should run. The scheduler converts this to a delay. */
  runAt: Date;
}

/**
 * Deterministic, so rescheduling replaces rather than duplicates.
 *
 * DEVIATION FROM THE BRIEF, forced by the library. The brief specifies
 * `expire-hold:{bookingId}`, but BullMQ 6 rejects a custom job id containing
 * a colon — "Custom Id cannot contain :" — because ':' is its Redis key
 * separator. The separator is a '.' instead; the id stays deterministic and
 * per-booking, which is the property the brief is actually after.
 */
export const JOB_ID_SEPARATOR = '.';

export function jobIdFor(queue: JobQueue, bookingId: string): string {
  return `${queue}${JOB_ID_SEPARATOR}${bookingId}`;
}

export interface JobScheduler {
  /**
   * Schedule a job, REPLACING any existing job with the same deterministic id.
   *
   * Replacement is not the default: BullMQ deduplicates by jobId and ignores a
   * re-add, keeping the original delay. An extension that moves planned_end_at
   * would otherwise leave the old deadline in place.
   */
  schedule(job: ScheduledJob): Promise<void>;
  cancel(queue: JobQueue, bookingId: string): Promise<void>;
}

/** Used where scheduling is irrelevant, such as the seed script. */
export class NoopScheduler implements JobScheduler {
  schedule(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
