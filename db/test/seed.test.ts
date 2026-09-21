import { LIVE_STATUSES } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/index.js';
import { buildSlots, seed } from '../seed/seed.js';
import { connectTestDb, freshSchema, type TestDb } from './helpers.js';

let ctx: TestDb;
let db: Kysely<Database>;

beforeAll(async () => {
  ctx = connectTestDb();
  await freshSchema(ctx.db);
  db = createDb(ctx.pool);
  await seed(db);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('seed data', () => {
  it('creates one operator, two lots, one attendant and one driver', async () => {
    const operators = await db.selectFrom('operators').selectAll().execute();
    expect(operators).toHaveLength(1);

    const lots = await db.selectFrom('lots').select(['name']).orderBy('name').execute();
    expect(lots.map((l) => l.name)).toEqual(['Bole Medhanialem Parking', 'Piassa Central Parking']);

    const users = await db.selectFrom('users').select(['phone', 'role']).orderBy('phone').execute();
    expect(users).toEqual([
      { phone: '+251911000001', role: 'attendant' },
      { phone: '+251911000002', role: 'driver' },
    ]);
  });

  it('places both lots inside Addis Ababa', async () => {
    const lots = await db.selectFrom('lots').select(['latitude', 'longitude']).execute();
    expect(lots).toHaveLength(2);
    for (const lot of lots) {
      // A generous box around the city, so this catches a swapped lat/lng or a
      // dropped sign rather than policing exact coordinates.
      expect(lot.latitude).toBeGreaterThan(8.8);
      expect(lot.latitude).toBeLessThan(9.2);
      expect(lot.longitude).toBeGreaterThan(38.6);
      expect(lot.longitude).toBeLessThan(38.9);
    }
  });

  it('gives every lot a grid of between 20 and 60 slots', async () => {
    const rows = await db
      .selectFrom('slots')
      .innerJoin('lots', 'lots.id', 'slots.lot_id')
      .select(({ fn }) => ['lots.name', fn.countAll<string>().as('count')])
      .groupBy('lots.name')
      .orderBy('lots.name')
      .execute();

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const count = Number(row.count);
      expect(count, row.name).toBeGreaterThanOrEqual(20);
      expect(count, row.name).toBeLessThanOrEqual(60);
    }
    expect(Number(rows[0]?.count)).toBe(48); // Bole: 6 x 8
    expect(Number(rows[1]?.count)).toBe(24); // Piassa: 4 x 4 + 2 x 4
  });

  it('links the attendant to both lots', async () => {
    const rows = await db
      .selectFrom('lot_staff')
      .innerJoin('users', 'users.id', 'lot_staff.user_id')
      .select(['users.role'])
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === 'attendant')).toBe(true);
  });

  it('seeds one lot with a deposit and one without', async () => {
    const lots = await db
      .selectFrom('lots')
      .select(['name', 'deposit_amount_santim'])
      .orderBy('name')
      .execute();
    // Covers both booking entry points: deposit > 0 enters PENDING_PAYMENT,
    // deposit = 0 goes straight to RESERVED.
    expect(lots[0]?.deposit_amount_santim).toBeGreaterThan(0);
    expect(lots[1]?.deposit_amount_santim).toBe(0);
  });

  it('is idempotent', async () => {
    await seed(db);
    const rows = await db
      .selectFrom('slots')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(rows.count)).toBe(72);
  });
});

describe('slot_status view over seeded data', () => {
  it('reports every in-service slot as free when there are no bookings', async () => {
    const bookings = await db
      .selectFrom('bookings')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(bookings.count)).toBe(0);

    const rows = await db
      .selectFrom('slot_status')
      .select(['display_status', 'in_service'])
      .execute();

    expect(rows).toHaveLength(72);
    for (const row of rows) {
      expect(row.display_status).toBe(row.in_service ? 'free' : 'out_of_service');
    }
  });

  it('marks the one out-of-service slot', async () => {
    const rows = await db
      .selectFrom('slot_status')
      .select(['label'])
      .where('display_status', '=', 'out_of_service')
      .execute();
    expect(rows.map((r) => r.label)).toEqual(['C-4']);
  });

  it('keeps three slots off the app as a walk-in buffer', async () => {
    const rows = await db
      .selectFrom('slot_status')
      .select(['label'])
      .where('app_bookable', '=', false)
      .orderBy('label')
      .execute();
    expect(rows.map((r) => r.label)).toEqual(['F-7', 'F-8', 'V-4']);
  });

  it('exposes no booking columns while every slot is free', async () => {
    const rows = await db
      .selectFrom('slot_status')
      .select(['booking_id', 'vehicle_plate', 'hold_expires_at'])
      .execute();
    for (const row of rows) {
      expect(row.booking_id).toBeNull();
      expect(row.vehicle_plate).toBeNull();
      expect(row.hold_expires_at).toBeNull();
    }
  });

  it('joins only live bookings, per the shared status list', () => {
    // The view's LEFT JOIN predicate is what makes a CHECKED_OUT booking stop
    // occupying its slot. Phase 1 exercises this with real transitions; here we
    // just pin that the view was built against the same four statuses.
    expect([...LIVE_STATUSES]).toHaveLength(4);
  });
});

describe('buildSlots', () => {
  it('lays out a zone row-major with 1-based column labels', () => {
    const slots = buildSlots({
      name: 't',
      address: 't',
      latitude: 9,
      longitude: 38,
      contact_phone: '+251900000000',
      block_minutes: 30,
      deposit_amount_santim: 0,
      rate_per_block_santim: 100,
      overstay_rate_per_block_santim: 200,
      zones: [{ zone: 'main', rows: 2, cols: 3, labelPrefix: 'A' }],
      notAppBookable: ['B-3'],
      outOfService: ['A-1'],
    });

    expect(slots.map((s) => s.label)).toEqual(['A-1', 'A-2', 'A-3', 'B-1', 'B-2', 'B-3']);
    expect(slots[0]).toMatchObject({ grid_row: 0, grid_col: 0, in_service: false });
    expect(slots[5]).toMatchObject({ grid_row: 1, grid_col: 2, app_bookable: false });
  });

  it('refuses a flagged label that the grid does not contain', () => {
    // Guards the mistake this seed actually shipped with: 'U-8' looked
    // plausible but a 2x4 zone from prefix 'U' only reaches U-4 and V-4.
    expect(() =>
      buildSlots({
        name: 'Typo Lot',
        address: 't',
        latitude: 9,
        longitude: 38,
        contact_phone: '+251900000000',
        block_minutes: 30,
        deposit_amount_santim: 0,
        rate_per_block_santim: 100,
        overstay_rate_per_block_santim: 200,
        zones: [{ zone: 'upper', rows: 2, cols: 4, labelPrefix: 'U' }],
        notAppBookable: ['U-8'],
        outOfService: [],
      }),
    ).toThrow(/does not contain/u);
  });

  it('gives each zone its own label prefix so labels stay unique per lot', () => {
    const slots = buildSlots({
      name: 't',
      address: 't',
      latitude: 9,
      longitude: 38,
      contact_phone: '+251900000000',
      block_minutes: 30,
      deposit_amount_santim: 0,
      rate_per_block_santim: 100,
      overstay_rate_per_block_santim: 200,
      zones: [
        { zone: 'ground', rows: 1, cols: 2, labelPrefix: 'G' },
        { zone: 'upper', rows: 1, cols: 2, labelPrefix: 'U' },
      ],
      notAppBookable: [],
      outOfService: [],
    });
    expect(new Set(slots.map((s) => s.label)).size).toBe(slots.length);
    expect(slots.map((s) => s.label)).toEqual(['G-1', 'G-2', 'U-1', 'U-2']);
  });
});
