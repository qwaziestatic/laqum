import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';

let t: TestContext;
let admin: Actor;
let attendant: Actor;
let operatorId: string;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.clock.set('2026-03-01T08:00:00.000Z');
  admin = await makeActor(t, 'operator_admin');
  attendant = await makeActor(t, 'attendant');

  const operator = await t.db.db
    .insertInto('operators')
    .values({ name: 'Sunrise PLC', phone: '+251911500000' })
    .returning('id')
    .executeTakeFirstOrThrow();
  operatorId = operator.id;
});

interface ErrorBody {
  error: { code: string; message: string };
}
const errorCode = (res: { body: unknown }): string => (res.body as ErrorBody).error.code;

const LOT_BODY = {
  name: 'Kazanchis Parking',
  address: 'Kazanchis, Addis Ababa',
  latitude: 9.0157,
  longitude: 38.7626,
  contactPhone: '+251911500001',
  ratePerBlockSantim: 2500,
  overstayRatePerBlockSantim: 5000,
};

async function createLotViaApi(actor = admin) {
  return request(t.app)
    .post('/v1/admin/lots')
    .set(actor.header)
    .send({ ...LOT_BODY, operatorId });
}

describe('POST /v1/admin/lots', () => {
  it('creates a lot with the documented defaults', async () => {
    const res = await createLotViaApi();
    expect(res.status).toBe(201);

    const { lot } = res.body as { lot: Record<string, unknown> };
    expect(lot['name']).toBe('Kazanchis Parking');
    expect(lot['block_minutes']).toBe(30);
    expect(lot['payment_window_minutes']).toBe(3);
    expect(lot['hold_minutes']).toBe(15);
    expect(lot['deposit_amount_santim']).toBe(0);
    // 5 km, not the brief's 10 km: an approved deviation (CLAUDE.md).
    expect(lot['max_booking_distance_m']).toBe(5_000);
  });

  it('staffs the creating admin, so they can manage what they made', async () => {
    const res = await createLotViaApi();
    const { lot } = res.body as { lot: { id: string } };

    const staffed = await request(t.app).get('/v1/staff/lots').set(admin.header);
    expect((staffed.body as { lots: { id: string }[] }).lots.map((l) => l.id)).toEqual([lot.id]);
  });

  it('refuses an attendant', async () => {
    const res = await createLotViaApi(attendant);
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('refuses an unknown operator', async () => {
    const res = await request(t.app)
      .post('/v1/admin/lots')
      .set(admin.header)
      .send({ ...LOT_BODY, operatorId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('rejects coordinates outside the world', async () => {
    const res = await request(t.app)
      .post('/v1/admin/lots')
      .set(admin.header)
      .send({ ...LOT_BODY, operatorId, latitude: 95 });
    expect(res.status).toBe(400);
  });

  it('rejects a negative rate', async () => {
    const res = await request(t.app)
      .post('/v1/admin/lots')
      .set(admin.header)
      .send({ ...LOT_BODY, operatorId, ratePerBlockSantim: -1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/admin/lots/:id/slots/bulk', () => {
  async function newLot(): Promise<string> {
    const res = await createLotViaApi();
    return (res.body as { lot: { id: string } }).lot.id;
  }

  it('generates a labelled grid', async () => {
    const lotId = await newLot();

    const res = await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(admin.header)
      .send({ zone: 'main', rows: 2, cols: 3, labelPrefix: 'A' });

    expect(res.status).toBe(201);
    expect((res.body as { created: number }).created).toBe(6);

    const slots = await t.db.db
      .selectFrom('slots')
      .select(['label', 'grid_row', 'grid_col', 'zone'])
      .where('lot_id', '=', lotId)
      .orderBy('grid_row')
      .orderBy('grid_col')
      .execute();

    expect(slots.map((s) => s.label)).toEqual(['A-1', 'A-2', 'A-3', 'B-1', 'B-2', 'B-3']);
    expect(slots.every((s) => s.zone === 'main')).toBe(true);
  });

  it('supports a second zone with its own prefix', async () => {
    const lotId = await newLot();
    await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(admin.header)
      .send({ zone: 'ground', rows: 1, cols: 2, labelPrefix: 'G' });

    const res = await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(admin.header)
      .send({ zone: 'upper', rows: 1, cols: 2, labelPrefix: 'U' });

    expect(res.status).toBe(201);
    const labels = await t.db.db
      .selectFrom('slots')
      .select('label')
      .where('lot_id', '=', lotId)
      .orderBy('label')
      .execute();
    expect(labels.map((l) => l.label)).toEqual(['G-1', 'G-2', 'U-1', 'U-2']);
  });

  it('refuses a grid that overlaps existing labels', async () => {
    const lotId = await newLot();
    const body = { zone: 'main', rows: 1, cols: 2, labelPrefix: 'A' };
    await request(t.app).post(`/v1/admin/lots/${lotId}/slots/bulk`).set(admin.header).send(body);

    const res = await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(admin.header)
      .send(body);

    // UNIQUE (lot_id, label) decides this; generating over an existing grid is
    // a mistake, not a merge.
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_ERROR');
  });

  it('rejects a multi-character label prefix', async () => {
    const lotId = await newLot();
    const res = await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(admin.header)
      .send({ zone: 'main', rows: 1, cols: 1, labelPrefix: 'AB' });
    expect(res.status).toBe(400);
  });

  it('refuses an admin who does not staff the lot', async () => {
    const lotId = await newLot();
    const stranger = await makeActor(t, 'operator_admin');

    const res = await request(t.app)
      .post(`/v1/admin/lots/${lotId}/slots/bulk`)
      .set(stranger.header)
      .send({ zone: 'main', rows: 1, cols: 1, labelPrefix: 'A' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/admin/lots/:id', () => {
  it('updates rates, windows and the deposit', async () => {
    const created = await createLotViaApi();
    const lotId = (created.body as { lot: { id: string } }).lot.id;

    const res = await request(t.app)
      .patch(`/v1/admin/lots/${lotId}`)
      .set(admin.header)
      .send({ ratePerBlockSantim: 3000, holdMinutes: 20, depositAmountSantim: 1500 });

    expect(res.status).toBe(200);
    const { lot } = res.body as { lot: Record<string, unknown> };
    expect(lot['rate_per_block_santim']).toBe(3000);
    expect(lot['hold_minutes']).toBe(20);
    expect(lot['deposit_amount_santim']).toBe(1500);
    // Untouched fields keep their values.
    expect(lot['overstay_rate_per_block_santim']).toBe(5000);
  });

  it('rejects an empty patch', async () => {
    const created = await createLotViaApi();
    const lotId = (created.body as { lot: { id: string } }).lot.id;

    const res = await request(t.app).patch(`/v1/admin/lots/${lotId}`).set(admin.header).send({});
    expect(res.status).toBe(400);
  });
});
