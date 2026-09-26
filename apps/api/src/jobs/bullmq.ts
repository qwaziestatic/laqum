import type { Clock } from '@laqum/shared';
import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { JOB_HANDLERS, type JobDeps } from './handlers.js';
import { sweep } from './sweeper.js';
import { currentLogContext, withLogContext } from '../logContext.js';
import {
  JOB_QUEUES,
  type JobQueue,
  type JobScheduler,
  type ScheduledJob,
  jobIdFor,
} from './scheduler.js';

/**
 * BullMQ adapter.
 *
 * TWO behaviours here are not the defaults and matter:
 *
 * 1. removeOnComplete / removeOnFail. BullMQ keeps finished jobs, and a
 *    retained job KEEPS ITS ID RESERVED. Since every id here is deterministic
 *    (expire-hold.{bookingId}), a completed job would block re-adding the same
 *    id — so the next reschedule for that booking would be silently dropped.
 *
 * 2. Rescheduling must remove before adding. `add()` with an existing jobId is
 *    a no-op in BullMQ: it keeps the ORIGINAL job, including its original
 *    delay. An extension that moves planned_end_at would otherwise leave the
 *    overstay job firing at the old deadline.
 */

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: true,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
};

export const SWEEPER_QUEUE = 'sweeper';
export const SWEEP_INTERVAL_MS = 60_000;

export interface JobPayload {
  bookingId: string;
  /** The request that scheduled it, so its log lines can be followed there. */
  reqId?: string;
}

export interface BullMqOptions {
  connection: Redis;
  clock: Clock;
  logger: Logger;
  /** Keyspace isolation, so tests cannot collide with a dev queue. */
  prefix?: string;
}

export class BullMqScheduler implements JobScheduler {
  readonly #queues: Map<JobQueue, Queue<JobPayload>>;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(options: BullMqOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#queues = new Map(
      JOB_QUEUES.map((name) => [
        name,
        new Queue<JobPayload>(name, {
          connection: options.connection,
          ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        }),
      ]),
    );
  }

  queueFor(name: JobQueue): Queue<JobPayload> {
    const queue = this.#queues.get(name);
    if (!queue) throw new Error(`Unknown queue ${name}`);
    return queue;
  }

  async schedule(job: ScheduledJob): Promise<void> {
    const jobId = jobIdFor(job.queue, job.bookingId);
    const queue = this.queueFor(job.queue);

    // Remove first: add() with an existing jobId keeps the OLD delay.
    await queue.remove(jobId).catch(() => 0);

    const delay = Math.max(0, job.runAt.getTime() - this.#clock.now().getTime());
    const { reqId } = currentLogContext();
    const payload: JobPayload = { bookingId: job.bookingId, ...(reqId ? { reqId } : {}) };
    await queue.add(job.queue, payload, { jobId, delay });

    this.#logger.debug({ jobId, delay }, 'scheduled job');
  }

  async cancel(queue: JobQueue, bookingId: string): Promise<void> {
    await this.queueFor(queue)
      .remove(jobIdFor(queue, bookingId))
      .catch(() => 0);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
  }
}

/**
 * One job, in its own log context: every line it writes carries the job's id
 * and the id of the request that scheduled it.
 */
export function runJob(
  deps: JobDeps,
  name: JobQueue,
  job: { id?: string | undefined; data: JobPayload },
): Promise<unknown> {
  const context = {
    ...(job.id === undefined ? {} : { jobId: job.id }),
    ...(job.data.reqId === undefined ? {} : { reqId: job.data.reqId }),
  };
  return withLogContext(context, async () => {
    const result = await JOB_HANDLERS[name](deps, job.data.bookingId);
    deps.logger.debug({ result }, 'job finished');
    return result;
  });
}

/**
 * Workers for each queue, plus the repeatable sweeper.
 *
 * The sweeper uses upsertJobScheduler, which is BullMQ's current repeatable-job
 * API; the older `repeat` job option is not used.
 */
export function startWorkers(
  deps: JobDeps,
  options: BullMqOptions,
): {
  queueWorkers: Worker<JobPayload>[];
  sweeperWorker: Worker;
  sweeperQueue: Queue;
  close: () => Promise<void>;
} {
  const workerOptions: WorkerOptions = {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };

  const workers = JOB_QUEUES.map(
    (name) => new Worker<JobPayload>(name, (job) => runJob(deps, name, job), workerOptions),
  );

  const sweeperQueue = new Queue(SWEEPER_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  // Kept out of the JobPayload-typed array: the sweeper takes no payload and
  // returns a different shape, so pushing it in would widen both to any.
  const sweeperWorker = new Worker(SWEEPER_QUEUE, async () => sweep(deps), workerOptions);

  void sweeperQueue.upsertJobScheduler(
    'every-minute',
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEPER_QUEUE },
  );

  return {
    queueWorkers: workers,
    sweeperWorker,
    sweeperQueue,
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
      await sweeperWorker.close();
      await sweeperQueue.close();
    },
  };
}
