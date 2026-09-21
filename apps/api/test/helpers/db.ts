import { createDb, createPool, createUntypedDb, type Database } from '@laqum/db';
import { createMigrator } from '@laqum/db';
import { FakeClock } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import pino, { type Logger } from 'pino';
import type { JobScheduler, JobQueue, ScheduledJob } from '../../src/jobs/scheduler.js';
import { jobIdFor } from '../../src/jobs/scheduler.js';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';

/** Silent by default; a failing test shows assertions, not log noise. */
export function testLogger(): Logger {
  return pino({ level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });
}

/**
 * `pg` is not a direct dependency of @laqum/api — it arrives through
 * @laqum/db, and pnpm's isolated linker correctly refuses to resolve it here.
 * Deriving the type from createPool keeps `pool.options.max` and
 * `pool.totalCount` available to the concurrency test without adding a
 * dependency the application does not use.
 */
export type TestPool = ReturnType<typeof createPool>;

export interface TestDb {
  db: Kysely<Database>;
  pool: TestPool;
  close: () => Promise<void>;
}

export function connect(max = 10): TestDb {
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max });
  const db = createDb(pool);
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

/** Migrate a completely clean schema. Slow, so callers do it once per file. */
export async function migrateFresh(): Promise<void> {
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 2 });
  const untyped = createUntypedDb(pool);
  try {
    await sql.raw('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;').execute(untyped);
    const { error } = await createMigrator(untyped).migrateToLatest();
    if (error !== undefined) {
      // Kysely types the failure as unknown; JSON.stringify keeps a non-Error
      // readable instead of collapsing it to [object Object].
      throw error instanceof Error
        ? error
        : new Error(`Migration failed: ${JSON.stringify(error)}`);
    }
  } finally {
    await untyped.destroy();
  }
}

/**
 * Empty every table between tests. Faster than re-migrating, and TRUNCATE
 * CASCADE also resets booking_events' identity sequence.
 */
export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await sql
    .raw(
      `TRUNCATE booking_events, payments, bookings, lot_staff, slots, lots, operators,
                push_tokens, refresh_tokens, otp_codes, users RESTART IDENTITY CASCADE`,
    )
    .execute(db);
}

/** A clock fixed at a readable instant, so failures are easy to reason about. */
export function testClock(start = '2026-03-01T08:00:00.000Z'): FakeClock {
  return new FakeClock(start);
}

/** Records what was scheduled instead of talking to Redis. */
export class RecordingScheduler implements JobScheduler {
  readonly scheduled: (ScheduledJob & { jobId: string })[] = [];
  readonly cancelled: { queue: JobQueue; bookingId: string; jobId: string }[] = [];

  schedule(job: ScheduledJob): Promise<void> {
    this.scheduled.push({ ...job, jobId: jobIdFor(job.queue, job.bookingId) });
    return Promise.resolve();
  }

  cancel(queue: JobQueue, bookingId: string): Promise<void> {
    this.cancelled.push({ queue, bookingId, jobId: jobIdFor(queue, bookingId) });
    return Promise.resolve();
  }

  forQueue(queue: JobQueue): (ScheduledJob & { jobId: string })[] {
    return this.scheduled.filter((j) => j.queue === queue);
  }

  reset(): void {
    this.scheduled.length = 0;
    this.cancelled.length = 0;
  }
}
