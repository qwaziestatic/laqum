import type { Database } from '@laqum/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideEffects, inTransaction } from '../src/afterCommit.js';
import { createBooking } from '../src/bookings/create.js';
import {
  RecordingScheduler,
  connect,
  migrateFresh,
  testClock,
  testLogger,
  truncateAll,
  type TestDb,
} from './helpers/db.js';
import { createLot, createUser } from './helpers/fixtures.js';

let ctx: TestDb;
let db: Kysely<Database>;
const logger = testLogger();

beforeAll(async () => {
  await migrateFresh();
  ctx = connect();
  db = ctx.db;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('SideEffects', () => {
  it('runs nothing until it is told to', async () => {
    const effects = new SideEffects();
    const ran: string[] = [];
    effects.add('one', async () => {
      ran.push('one');
      return Promise.resolve();
    });

    expect(ran).toEqual([]);
    expect(effects.names).toEqual(['one']);

    await effects.run(logger);
    expect(ran).toEqual(['one']);
  });

  it('runs effects in registration order', async () => {
    const effects = new SideEffects();
    const ran: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      effects.add(name, async () => {
        ran.push(name);
        return Promise.resolve();
      });
    }
    await effects.run(logger);
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('does not let one failed effect stop the others, or fail the caller', async () => {
    // The transaction already committed: the booking is real whether or not a
    // notification went out.
    const effects = new SideEffects();
    const ran: string[] = [];
    effects.add('boom', () => Promise.reject(new Error('push service down')));
    effects.add('after', async () => {
      ran.push('after');
      return Promise.resolve();
    });

    await expect(effects.run(logger)).resolves.toBeUndefined();
    expect(ran).toEqual(['after']);
  });

  it('empties itself so a second run cannot double-fire', async () => {
    const effects = new SideEffects();
    const run = vi.fn(() => Promise.resolve());
    effects.add('once', run);

    await effects.run(logger);
    await effects.run(logger);

    expect(run).toHaveBeenCalledTimes(1);
    expect(effects.size).toBe(0);
  });
});

describe('inTransaction', () => {
  it('runs effects only after the commit', async () => {
    const order: string[] = [];
    await inTransaction({ db, logger }, async (trx, effects) => {
      await trx
        .insertInto('operators')
        .values({ name: 'Ordering Co', phone: '+251911000300' })
        .execute();
      order.push('inside transaction');
      effects.add('after', async () => {
        order.push('after commit');
        return Promise.resolve();
      });
    });

    expect(order).toEqual(['inside transaction', 'after commit']);
  });

  it('runs NO effect when the transaction rolls back', async () => {
    const ran: string[] = [];

    await expect(
      inTransaction({ db, logger }, async (trx, effects) => {
        await trx
          .insertInto('operators')
          .values({ name: 'Doomed Co', phone: '+251911000301' })
          .execute();
        effects.add('must-not-run', async () => {
          ran.push('must-not-run');
          return Promise.resolve();
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(ran).toEqual([]);

    const operators = await db.selectFrom('operators').selectAll().execute();
    expect(operators).toHaveLength(0);
  });
});

describe('booking creation honours the after-commit rule', () => {
  it('schedules no job when the booking insert fails', async () => {
    const scheduler = new RecordingScheduler();
    const lot = await createLot(db, { slots: 1 });
    const userId = await createUser(db, 'driver', '+251911000302');

    // A lot with no free slot: creation fails before any commit.
    await db
      .updateTable('slots')
      .set({ in_service: false })
      .where('lot_id', '=', lot.lotId)
      .execute();

    await expect(
      createBooking(
        { db, clock: testClock(), logger, scheduler },
        {
          lotId: lot.lotId,
          userId,
          plannedMinutes: 30,
          latitude: lot.latitude,
          longitude: lot.longitude,
        },
      ),
    ).rejects.toMatchObject({ code: 'LOT_FULL' });

    // A scheduled expiry for a booking that does not exist would be a leak.
    expect(scheduler.scheduled).toEqual([]);
  });
});
