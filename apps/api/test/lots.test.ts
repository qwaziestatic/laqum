import {
  STAFF_ONLY_FIELDS,
  type BillableLot,
  billableLotFromSummary,
  computeBill,
  lotSummarySchema,
  nearbyLotSchema,
  publicSnapshotSchema,
} from '@laqum/shared';
import { z } from 'zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, createUser, seedBooking } from './helpers/fixtures.js';

let t: TestContext;
let driver: Actor;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  driver = await makeActor(t, 'driver');
});

const BOLE = { latitude: 9.0092, longitude: 38.7869 };
const PIASSA = { latitude: 9.0348, longitude: 38.7508 };

interface NearbyBody {
  lots: {
    id: string;
    name: string;
    distanceM: number;
    freeSlots: number;
    totalAppBookableSlots: number;
    withinBookingRange: boolean;
    ratePerBlockSantim: number;
  }[];
}

describe('authentication', () => {
  it('refuses every lot endpoint without a token', async () => {
    for (const path of ['/v1/lots/nearby?lat=9&lng=38.7', '/v1/lots/x', '/v1/lots/x/layout']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('refuses a token signed with the wrong key', async () => {
    const res = await request(t.app)
      .get('/v1/lots/nearby?lat=9&lng=38.7')
      .set({ Authorization: 'Bearer not.a.token' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/lots/nearby', () => {
  it('sorts by distance and reports live free counts', async () => {
    const bole = await createLot(t.db.db, { name: 'Bole', slots: 4, ...BOLE });
    await createLot(t.db.db, { name: 'Piassa', slots: 2, ...PIASSA });

    // Two of Bole's four slots are taken.
    const other = await createUser(t.db.db, 'driver', '+251911770001');
    const another = await createUser(t.db.db, 'driver', '+251911770002');
    await seedBooking(t.db.db, {
      lotId: bole.lotId,
      slotId: bole.slotIds[0]!,
      userId: other,
      status: 'RESERVED',
    });
    await seedBooking(t.db.db, {
      lotId: bole.lotId,
      slotId: bole.slotIds[1]!,
      userId: another,
      status: 'CHECKED_IN',
    });

    const res = await request(t.app)
      .get(
        `/v1/lots/nearby?lat=${String(BOLE.latitude)}&lng=${String(BOLE.longitude)}&radius_m=10000`,
      )
      .set(driver.header);

    expect(res.status).toBe(200);
    const body = res.body as NearbyBody;
    expect(body.lots.map((l) => l.name)).toEqual(['Bole', 'Piassa']);
    expect(body.lots[0]?.distanceM).toBe(0);
    expect(body.lots[0]?.freeSlots).toBe(2);
    expect(body.lots[0]?.totalAppBookableSlots).toBe(4);
    expect(body.lots[1]?.distanceM).toBeGreaterThan(4_000);
  });

  it('excludes lots beyond the requested radius', async () => {
    await createLot(t.db.db, { name: 'Bole', slots: 1, ...BOLE });
    await createLot(t.db.db, { name: 'Piassa', slots: 1, ...PIASSA });

    const res = await request(t.app)
      .get(
        `/v1/lots/nearby?lat=${String(BOLE.latitude)}&lng=${String(BOLE.longitude)}&radius_m=1000`,
      )
      .set(driver.header);

    const body = res.body as NearbyBody;
    expect(body.lots.map((l) => l.name)).toEqual(['Bole']);
  });

  it('counts only app-bookable, in-service slots', async () => {
    const lot = await createLot(t.db.db, { slots: 0, ...BOLE });
    await t.db.db
      .insertInto('slots')
      .values([
        { lot_id: lot.lotId, label: 'A-1', zone: 'main', grid_row: 0, grid_col: 0 },
        {
          lot_id: lot.lotId,
          label: 'A-2',
          zone: 'main',
          grid_row: 0,
          grid_col: 1,
          app_bookable: false,
        },
        {
          lot_id: lot.lotId,
          label: 'A-3',
          zone: 'main',
          grid_row: 0,
          grid_col: 2,
          in_service: false,
        },
      ])
      .execute();

    const res = await request(t.app)
      .get(`/v1/lots/nearby?lat=${String(BOLE.latitude)}&lng=${String(BOLE.longitude)}`)
      .set(driver.header);

    const body = res.body as NearbyBody;
    // A-2 is not app-bookable so it is not counted at all; A-3 is app-bookable
    // but out of service, so it counts toward the total and not toward free.
    expect(body.lots[0]?.freeSlots).toBe(1);
    expect(body.lots[0]?.totalAppBookableSlots).toBe(2);
  });

  it('hides inactive lots', async () => {
    const lot = await createLot(t.db.db, { name: 'Closed', slots: 1, ...BOLE });
    await t.db.db
      .updateTable('lots')
      .set({ is_active: false })
      .where('id', '=', lot.lotId)
      .execute();

    const res = await request(t.app)
      .get(`/v1/lots/nearby?lat=${String(BOLE.latitude)}&lng=${String(BOLE.longitude)}`)
      .set(driver.header);
    expect((res.body as NearbyBody).lots).toEqual([]);
  });

  it('flags a lot the driver is too far from to book', async () => {
    await createLot(t.db.db, { slots: 1, maxBookingDistanceM: 500, ...BOLE });

    const res = await request(t.app)
      .get(
        `/v1/lots/nearby?lat=${String(BOLE.latitude + 0.02)}&lng=${String(BOLE.longitude)}&radius_m=10000`,
      )
      .set(driver.header);

    const body = res.body as NearbyBody;
    expect(body.lots).toHaveLength(1);
    expect(body.lots[0]?.withinBookingRange).toBe(false);
  });

  it('rejects malformed coordinates', async () => {
    for (const q of ['lat=91&lng=38', 'lat=9&lng=200', 'lat=abc&lng=38', 'lng=38']) {
      const res = await request(t.app).get(`/v1/lots/nearby?${q}`).set(driver.header);
      expect(res.status, q).toBe(400);
    }
  });
});

describe('GET /v1/lots/:id/layout', () => {
  it("returns the grid without any other driver's data", async () => {
    const lot = await createLot(t.db.db, { slots: 2, ...BOLE });
    const other = await createUser(t.db.db, 'driver', '+251911770010');
    await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: other,
      status: 'CHECKED_IN',
    });
    await t.db.db
      .updateTable('bookings')
      .set({ vehicle_plate: 'AA-12345' })
      .where('slot_id', '=', lot.slotIds[0]!)
      .execute();

    const res = await request(t.app).get(`/v1/lots/${lot.lotId}/layout`).set(driver.header);
    expect(res.status).toBe(200);

    const body = res.body as { lotVersion: number; slots: Record<string, unknown>[] };
    expect(body.slots).toHaveLength(2);
    expect(body.slots[0]?.['displayStatus']).toBe('occupied');
    expect(body.slots[1]?.['displayStatus']).toBe('free');

    // The snapshot names the version it was read at, so a client has something
    // to compare buffered events against.
    expect(publicSnapshotSchema.parse(body).lotVersion).toBeGreaterThanOrEqual(0);

    // THE privacy assertion: no plate, no booking id, no hold deadline. Driven
    // off the shared list, so adding a staff-only field to the contract
    // without excluding it here fails this test rather than leaking quietly.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('AA-12345');
    for (const key of STAFF_ONLY_FIELDS) {
      expect(Object.keys(body.slots[0] ?? {}), key).not.toContain(key);
    }
  });

  it('404s for an unknown lot', async () => {
    const res = await request(t.app)
      .get('/v1/lots/00000000-0000-0000-0000-000000000000/layout')
      .set(driver.header);
    expect(res.status).toBe(404);
  });

  it('400s for an id that is not a uuid', async () => {
    const res = await request(t.app).get('/v1/lots/not-a-uuid/layout').set(driver.header);
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/lots/:id', () => {
  it('returns rates and the live free count', async () => {
    const lot = await createLot(t.db.db, {
      slots: 3,
      ratePerBlockSantim: 2500,
      overstayRatePerBlockSantim: 5000,
      depositSantim: 1000,
      ...BOLE,
    });

    const res = await request(t.app).get(`/v1/lots/${lot.lotId}`).set(driver.header);
    expect(res.status).toBe(200);

    const body = res.body as {
      ratePerBlockSantim: number;
      overstayRatePerBlockSantim: number;
      depositAmountSantim: number;
      freeSlots: number;
      contactPhone: string;
    };
    expect(body.ratePerBlockSantim).toBe(2500);
    expect(body.overstayRatePerBlockSantim).toBe(5000);
    expect(body.depositAmountSantim).toBe(1000);
    expect(body.freeSlots).toBe(3);
    // The tap-to-call target.
    expect(body.contactPhone).toMatch(/^\+251/u);
  });
});

/*
 * THE MOBILE APP'S CONTRACT, against REAL responses.
 *
 * The app parses lot responses with the shared schemas (apps/mobile/src/api/
 * endpoints.ts) and prices a booking preview with billableLotFromSummary +
 * computeBill. The unit tests on both sides passed while the device crashed:
 * the Book screen cast the API's camelCase lot straight into computeBill's
 * snake_case BillableLot, and nothing ran the one against the other. These
 * run the app's exact path on what this API actually sends.
 */
describe("the mobile app's contract, on real responses", () => {
  // TEST LOT's values from the device test: 5-minute blocks, no deposit.
  const TEST_LOT = {
    blockMinutes: 5,
    ratePerBlockSantim: 500,
    overstayRatePerBlockSantim: 1000,
    depositSantim: 0,
  };
  const strictLot = z.strictObject(lotSummarySchema.shape);
  const strictNearbyLot = z.strictObject(nearbyLotSchema.shape);

  it('GET /lots/:id is exactly a LotSummary: no field missing, none undescribed', async () => {
    const lot = await createLot(t.db.db, { slots: 6, ...TEST_LOT, ...BOLE });

    const res = await request(t.app).get(`/v1/lots/${lot.lotId}`).set(driver.header);

    expect(res.status).toBe(200);
    const parsed = strictLot.safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('GET /lots/nearby is exactly a list of NearbyLot', async () => {
    await createLot(t.db.db, { slots: 6, ...TEST_LOT, ...BOLE });

    const res = await request(t.app)
      .get(`/v1/lots/nearby?lat=${String(BOLE.latitude)}&lng=${String(BOLE.longitude)}`)
      .set(driver.header);

    expect(res.status).toBe(200);
    const parsed = z.strictObject({ lots: z.array(strictNearbyLot) }).safeParse(res.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect((res.body as { lots: unknown[] }).lots).toHaveLength(1);
  });

  it('GET /lots/:id is NOT a NearbyLot, which the app used to assume', async () => {
    // The old client typed this endpoint as NearbyLot; it has no distance.
    const lot = await createLot(t.db.db, { slots: 1, ...TEST_LOT, ...BOLE });

    const res = await request(t.app).get(`/v1/lots/${lot.lotId}`).set(driver.header);

    expect(nearbyLotSchema.safeParse(res.body).success).toBe(false);
  });

  it('prices the real response exactly as the Book screen does', async () => {
    const created = await createLot(t.db.db, { slots: 6, ...TEST_LOT, ...BOLE });
    const res = await request(t.app).get(`/v1/lots/${created.lotId}`).set(driver.header);

    // The app's path: parse with the shared schema, bridge, bill.
    const lot = lotSummarySchema.parse(res.body);
    const blocks = 2;
    const minutes = blocks * lot.blockMinutes;
    const bill = computeBill(
      {
        source: 'app',
        planned_minutes: minutes,
        checked_in_at: new Date(0),
        planned_end_at: new Date(minutes * 60_000),
        deposit_paid_santim: 0,
      },
      billableLotFromSummary(lot),
      new Date(minutes * 60_000),
    );

    expect(bill.subtotalSantim).toBe(blocks * TEST_LOT.ratePerBlockSantim);
    expect(bill.amountDueSantim).toBe(1000);
  });

  it('reproduces the device crash when the raw response is passed as a BillableLot', async () => {
    // What the Book screen did (`as unknown as`), on a real response: the
    // exact render error from the device. billableLotFromSummary is the fix.
    const created = await createLot(t.db.db, { slots: 1, ...TEST_LOT, ...BOLE });
    const res = await request(t.app).get(`/v1/lots/${created.lotId}`).set(driver.header);

    expect(() =>
      computeBill(
        {
          source: 'app',
          planned_minutes: 10,
          checked_in_at: new Date(0),
          planned_end_at: new Date(10 * 60_000),
          deposit_paid_santim: 0,
        },
        res.body as BillableLot,
        new Date(10 * 60_000),
      ),
    ).toThrow('blockMinutes must be a positive safe integer, received undefined');
  });
});
