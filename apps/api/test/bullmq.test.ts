import { FakeClock } from '@laqum/shared';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BullMqScheduler, DEFAULT_JOB_OPTIONS } from '../src/jobs/bullmq.js';
import { jobIdFor } from '../src/jobs/scheduler.js';
import { withLogContext } from '../src/logContext.js';
import { TEST_REDIS_URL } from './helpers/context.js';
import { testLogger } from './helpers/db.js';

/**
 * The BullMQ wiring, against REAL Redis.
 *
 * Handler behaviour is covered by jobs.test.ts without any queue. This file
 * exists for the two BullMQ behaviours that are not the defaults and that
 * would fail silently in production:
 *
 *   - a retained finished job keeps its id RESERVED, blocking a re-add;
 *   - add() with an existing jobId keeps the ORIGINAL delay.
 *
 * Both matter because every job id here is deterministic.
 */

const PREFIX = `{laqum-test-${String(process.pid)}}`;
const BOOKING = '11111111-1111-4111-8111-111111111111';

let connection: Redis;
let scheduler: BullMqScheduler;
let clock: FakeClock;

beforeAll(async () => {
  // BullMQ requires this for blocking commands.
  connection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await connection.connect();
  clock = new FakeClock('2026-03-01T08:00:00.000Z');
  scheduler = new BullMqScheduler({ connection, clock, logger: testLogger(), prefix: PREFIX });
}, 60_000);

afterAll(async () => {
  await scheduler.close();
  const keys = await connection.keys(`${PREFIX}*`);
  if (keys.length > 0) await connection.del(...keys);
  connection.disconnect();
});

beforeEach(async () => {
  await scheduler.queueFor('expire-hold').obliterate({ force: true });
  await scheduler.queueFor('mark-overstay').obliterate({ force: true });
  clock.set('2026-03-01T08:00:00.000Z');
});

describe('default job options', () => {
  it('removes finished jobs, so a deterministic id is never left reserved', () => {
    // A retained completed job keeps expire-hold:{bookingId} taken, and the
    // next add() for that booking would be silently ignored.
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(true);
  });

  it('applies them to every scheduled job', async () => {
    await scheduler.schedule({
      queue: 'expire-hold',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T08:15:00.000Z'),
    });

    const job = await scheduler.queueFor('expire-hold').getJob(jobIdFor('expire-hold', BOOKING));
    expect(job?.opts.removeOnComplete).toBe(true);
    expect(job?.opts.removeOnFail).toBe(true);
  });
});

describe('scheduling', () => {
  it('uses the deterministic id and a delay derived from the injected clock', async () => {
    await scheduler.schedule({
      queue: 'expire-hold',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T08:15:00.000Z'),
    });

    const job = await scheduler.queueFor('expire-hold').getJob(`expire-hold.${BOOKING}`);
    expect(job).toBeDefined();
    expect(job?.data.bookingId).toBe(BOOKING);
    // 15 minutes from the fake clock, not from real time.
    expect(job?.opts.delay).toBe(15 * 60_000);
  });

  it('records the request that scheduled it, so its log lines can be followed there', async () => {
    await withLogContext({ reqId: 'req-42' }, () =>
      scheduler.schedule({ queue: 'expire-hold', bookingId: BOOKING, runAt: clock.now() }),
    );
    const job = await scheduler.queueFor('expire-hold').getJob(`expire-hold.${BOOKING}`);
    expect(job?.data).toEqual({ bookingId: BOOKING, reqId: 'req-42' });

    // Outside a request (the sweeper, a startup task) there is none to record.
    await scheduler.schedule({ queue: 'mark-overstay', bookingId: BOOKING, runAt: clock.now() });
    const plain = await scheduler.queueFor('mark-overstay').getJob(`mark-overstay.${BOOKING}`);
    expect(plain?.data).toEqual({ bookingId: BOOKING });
  });

  it('clamps a deadline in the past to no delay', async () => {
    await scheduler.schedule({
      queue: 'expire-hold',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T07:00:00.000Z'),
    });

    const job = await scheduler.queueFor('expire-hold').getJob(`expire-hold.${BOOKING}`);
    expect(job?.opts.delay).toBe(0);
  });

  it('REPLACES an existing job rather than keeping its old delay', async () => {
    await scheduler.schedule({
      queue: 'mark-overstay',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T09:00:00.000Z'),
    });

    const before = await scheduler.queueFor('mark-overstay').getJob(`mark-overstay.${BOOKING}`);
    expect(before?.opts.delay).toBe(60 * 60_000);

    // The driver extends: the deadline moves an hour later.
    await scheduler.schedule({
      queue: 'mark-overstay',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T10:00:00.000Z'),
    });

    const after = await scheduler.queueFor('mark-overstay').getJob(`mark-overstay.${BOOKING}`);
    // A plain add() would have left this at 60 minutes: BullMQ ignores an add
    // for an id it already holds. This is why schedule() removes first.
    expect(after?.opts.delay).toBe(120 * 60_000);

    // And only one job exists for the booking.
    const counts = await scheduler.queueFor('mark-overstay').getJobCounts();
    expect((counts['delayed'] ?? 0) + (counts['waiting'] ?? 0)).toBe(1);
  });

  it('cancels a job, and cancelling a missing one is harmless', async () => {
    await scheduler.schedule({
      queue: 'expire-hold',
      bookingId: BOOKING,
      runAt: new Date('2026-03-01T08:15:00.000Z'),
    });
    await scheduler.cancel('expire-hold', BOOKING);

    expect(
      await scheduler.queueFor('expire-hold').getJob(`expire-hold.${BOOKING}`),
    ).toBeUndefined();
    await expect(scheduler.cancel('expire-hold', BOOKING)).resolves.toBeUndefined();
  });
});

describe('after a job has run', () => {
  it('frees the deterministic id, so the same booking can be scheduled again', async () => {
    // THE reason removeOnComplete is set. Without it this second schedule()
    // would be a silent no-op and the booking would never expire.
    const queue = scheduler.queueFor('expire-hold');
    const processed: string[] = [];

    const worker = new Worker(
      'expire-hold',
      (job) => {
        processed.push(job.id ?? '');
        return Promise.resolve('ok');
      },
      { connection, prefix: PREFIX },
    );

    try {
      const completed = new Promise<void>((resolve) => {
        worker.on('completed', () => {
          resolve();
        });
      });

      await scheduler.schedule({
        queue: 'expire-hold',
        bookingId: BOOKING,
        runAt: clock.now(), // no delay
      });
      await completed;

      expect(processed).toEqual([`expire-hold.${BOOKING}`]);
      // The finished job was removed, so its id is free again.
      expect(await queue.getJob(`expire-hold.${BOOKING}`)).toBeUndefined();

      await worker.close();

      clock.advanceMinutes(30);
      await scheduler.schedule({
        queue: 'expire-hold',
        bookingId: BOOKING,
        runAt: new Date(clock.now().getTime() + 15 * 60_000),
      });

      const requeued = await queue.getJob(`expire-hold.${BOOKING}`);
      expect(requeued, 'the id must be re-usable after completion').toBeDefined();
      expect(requeued?.opts.delay).toBe(15 * 60_000);
    } finally {
      await worker.close();
    }
  }, 30_000);
});
