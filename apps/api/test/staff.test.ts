import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeActor, reissue, staffLot, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, seedBooking, type LotFixture } from './helpers/fixtures.js';

let t: TestContext;
let attendant: Actor;
let driver: Actor;
let lot: LotFixture;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.scheduler.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');

  lot = await createLot(t.db.db, {
    slots: 3,
    blockMinutes: 30,
    ratePerBlockSantim: 2000,
    overstayRatePerBlockSantim: 4000,
    depositSantim: 0,
  });
  attendant = await makeActor(t, 'attendant');
  driver = await makeActor(t, 'driver');
  await staffLot(t, attendant, lot.lotId);
});

interface ErrorBody {
  error: { code: string; message: string };
}
const errorCode = (res: { body: unknown }): string => (res.body as ErrorBody).error.code;

interface BookingBody {
  booking: { id: string; status: string; shortCode: string | null; amountDueSantim: number | null };
  bill?: { amountDueSantim: number; subtotalSantim: number; lines: { kind: string }[] };
  settled?: boolean;
}

async function reservedBooking() {
  const res = await request(t.app)
    .post('/v1/bookings')
    .set(driver.header)
    .send({ lotId: lot.lotId, plannedMinutes: 60, lat: lot.latitude, lng: lot.longitude });
  expect(res.status).toBe(201);
  return res.body as { booking: { id: string; shortCode: string; qrToken: string } };
}

describe('authorisation', () => {
  it('refuses a driver on every staff endpoint', async () => {
    const res = await request(t.app).get('/v1/staff/lots').set(driver.header);
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('refuses an attendant at a lot they do not staff', async () => {
    const other = await makeActor(t, 'attendant');
    const res = await request(t.app).get(`/v1/staff/lots/${lot.lotId}/slots`).set(other.header);
    expect(res.status).toBe(403);
  });

  it('lists only the lots the attendant staffs', async () => {
    await createLot(t.db.db, { name: 'Elsewhere', slots: 1 });
    const res = await request(t.app).get('/v1/staff/lots').set(attendant.header);
    expect(res.status).toBe(200);
    expect((res.body as { lots: { id: string }[] }).lots.map((l) => l.id)).toEqual([lot.lotId]);
  });
});

describe('GET /v1/staff/lots/:id/slots', () => {
  it('returns the full rows, including the plate a driver may not see', async () => {
    await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0], vehiclePlate: 'AA-54321' });

    const res = await request(t.app).get(`/v1/staff/lots/${lot.lotId}/slots`).set(attendant.header);

    const body = res.body as { slots: Record<string, unknown>[] };
    expect(body.slots).toHaveLength(3);
    expect(JSON.stringify(body)).toContain('AA-54321');
    expect(body.slots[0]?.['display_status']).toBe('occupied');
  });
});

describe('POST /v1/staff/lots/:id/walk-ins', () => {
  it('parks a car with no user, no planned end and no QR', async () => {
    const res = await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0], vehiclePlate: 'AA-00001' });

    expect(res.status).toBe(201);
    const row = await t.db.db
      .selectFrom('bookings')
      .selectAll()
      .where('slot_id', '=', lot.slotIds[0]!)
      .executeTakeFirstOrThrow();

    expect(row.source).toBe('walk_in');
    expect(row.status).toBe('CHECKED_IN');
    expect(row.user_id).toBeNull();
    expect(row.qr_token).toBeNull();
    expect(row.short_code).toBeNull();
    expect(row.planned_end_at).toBeNull();
    expect(row.created_by).toBe(attendant.userId);
    expect(row.checked_in_at?.toISOString()).toBe('2026-03-01T08:00:00.000Z');

    // Walk-ins never enter OVERSTAY, so no overstay job is scheduled.
    expect(t.scheduler.forQueue('mark-overstay')).toEqual([]);
  });

  it('refuses a slot that already holds a live booking', async () => {
    await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0] });

    const res = await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0] });

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('SLOT_TAKEN');
  });

  it('refuses a slot that is out of service', async () => {
    await t.db.db
      .updateTable('slots')
      .set({ in_service: false })
      .where('id', '=', lot.slotIds[1]!)
      .execute();

    const res = await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[1] });

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('SLOT_IN_USE');
  });
});

describe('POST /v1/staff/check-in', () => {
  it('checks in by short code and starts the clock', async () => {
    const created = await reservedBooking();
    t.clock.set('2026-03-01T08:05:00.000Z');
    attendant = await reissue(t, attendant);

    const res = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.shortCode });

    expect(res.status).toBe(200);
    const row = await t.db.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', created.booking.id)
      .executeTakeFirstOrThrow();

    expect(row.status).toBe('CHECKED_IN');
    expect(row.checked_in_at?.toISOString()).toBe('2026-03-01T08:05:00.000Z');
    // planned_end_at is checked_in_at + planned_minutes, not booking time.
    expect(row.planned_end_at?.toISOString()).toBe('2026-03-01T09:05:00.000Z');
  });

  it('checks in by QR token', async () => {
    const created = await reservedBooking();
    const res = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.qrToken });
    expect(res.status).toBe(200);
  });

  it('accepts a short code typed in lower case', async () => {
    const created = await reservedBooking();
    const res = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.shortCode.toLowerCase() });
    expect(res.status).toBe(200);
  });

  it('swaps the hold expiry job for overstay and reminder jobs', async () => {
    const created = await reservedBooking();
    t.scheduler.reset();

    await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.shortCode });

    expect(t.scheduler.cancelled.map((c) => c.queue)).toContain('expire-hold');
    expect(t.scheduler.forQueue('mark-overstay')[0]?.runAt.toISOString()).toBe(
      '2026-03-01T09:00:00.000Z',
    );
    expect(t.scheduler.forQueue('time-reminder')[0]?.runAt.toISOString()).toBe(
      '2026-03-01T08:50:00.000Z',
    );
  });

  it('rejects an unknown code', async () => {
    const res = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: 'ZZZZZZ' });
    expect(res.status).toBe(404);
  });

  it('refuses a booking at a lot the attendant does not staff', async () => {
    const created = await reservedBooking();
    const other = await makeActor(t, 'attendant');

    const res = await request(t.app)
      .post('/v1/staff/check-in')
      .set(other.header)
      .send({ code: created.booking.shortCode });
    expect(res.status).toBe(403);
  });

  it('refuses to check the same booking in twice', async () => {
    const created = await reservedBooking();
    await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.qrToken });

    const again = await request(t.app)
      .post('/v1/staff/check-in')
      .set(attendant.header)
      .send({ code: created.booking.qrToken });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('STATE_CONFLICT');
  });
});

describe('POST /v1/staff/bookings/:id/check-out', () => {
  async function parkedAppBooking(plannedMinutes = 60) {
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    return seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedMinutes,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, plannedMinutes),
    });
  }

  it('bills the planned blocks and frees the slot', async () => {
    const id = await parkedAppBooking(60);
    t.clock.set('2026-03-01T09:00:00.000Z');
    attendant = await reissue(t, attendant);

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/check-out`)
      .set(attendant.header);

    expect(res.status).toBe(200);
    const body = res.body as BookingBody;
    expect(body.booking.status).toBe('CHECKED_OUT');
    expect(body.bill?.amountDueSantim).toBe(4000);
    expect(body.bill?.lines.map((l) => l.kind)).toEqual(['planned']);
    expect(body.settled).toBe(false);

    const free = await t.db.db
      .selectFrom('slot_status')
      .select('slot_id')
      .where('lot_id', '=', lot.lotId)
      .where('display_status', '=', 'free')
      .execute();
    expect(free).toHaveLength(3);
  });

  it('adds an overstay line when the car stayed past its planned end', async () => {
    const id = await parkedAppBooking(60);
    t.clock.set('2026-03-01T09:31:00.000Z');
    attendant = await reissue(t, attendant);

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/check-out`)
      .set(attendant.header);

    const body = res.body as BookingBody;
    expect(body.bill?.lines.map((l) => l.kind)).toEqual(['planned', 'overstay']);
    // 2 planned blocks x 20 + 2 overstay blocks x 40.
    expect(body.bill?.amountDueSantim).toBe(4000 + 8000);
  });

  it('checks out from OVERSTAY too', async () => {
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'OVERSTAY',
      plannedMinutes: 60,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, 60),
    });
    t.clock.set('2026-03-01T09:15:00.000Z');
    attendant = await reissue(t, attendant);

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/check-out`)
      .set(attendant.header);
    expect(res.status).toBe(200);
    expect((res.body as BookingBody).booking.status).toBe('CHECKED_OUT');
  });

  it('settles a zero bill straight to PAID', async () => {
    const freeLot = await createLot(t.db.db, {
      slots: 1,
      ratePerBlockSantim: 0,
      overstayRatePerBlockSantim: 0,
    });
    await staffLot(t, attendant, freeLot.lotId);

    const id = await seedBooking(t.db.db, {
      lotId: freeLot.lotId,
      slotId: freeLot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedMinutes: 30,
      checkedInAt: new Date('2026-03-01T08:00:00.000Z'),
      plannedEndAt: new Date('2026-03-01T08:30:00.000Z'),
    });

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/check-out`)
      .set(attendant.header);

    const body = res.body as BookingBody;
    expect(body.bill?.amountDueSantim).toBe(0);
    expect(body.settled).toBe(true);
    expect(body.booking.status).toBe('PAID');

    // Both transitions are recorded, in order.
    const events = await t.db.db
      .selectFrom('booking_events')
      .select(['from_status', 'to_status'])
      .where('booking_id', '=', id)
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.to_status)).toEqual(['CHECKED_IN', 'CHECKED_OUT', 'PAID']);
  });

  it('bills a walk-in by actual time with a one-block minimum', async () => {
    await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0] });

    const row = await t.db.db
      .selectFrom('bookings')
      .select('id')
      .where('source', '=', 'walk_in')
      .executeTakeFirstOrThrow();

    // Left after one minute: still a full block.
    t.clock.set('2026-03-01T08:01:00.000Z');
    attendant = await reissue(t, attendant);

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${row.id}/check-out`)
      .set(attendant.header);

    const body = res.body as BookingBody;
    expect(body.bill?.lines.map((l) => l.kind)).toEqual(['walk_in']);
    expect(body.bill?.amountDueSantim).toBe(2000);
  });
});

describe('POST /v1/staff/bookings/:id/cash', () => {
  async function checkedOut() {
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedMinutes: 60,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, 60),
    });
    t.clock.set('2026-03-01T09:00:00.000Z');
    attendant = await reissue(t, attendant);
    await request(t.app).post(`/v1/staff/bookings/${id}/check-out`).set(attendant.header);
    return id;
  }

  it('records the cash and settles the booking', async () => {
    const id = await checkedOut();

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000 });

    expect(res.status).toBe(200);
    expect((res.body as BookingBody).booking.status).toBe('PAID');

    const payment = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', id)
      .executeTakeFirstOrThrow();

    expect(payment.provider).toBe('cash');
    expect(payment.kind).toBe('final');
    expect(payment.status).toBe('success');
    expect(payment.amount_santim).toBe(4000);
    // cash_has_recorder: the schema refuses a cash row without one.
    expect(payment.recorded_by).toBe(attendant.userId);
  });

  it('refuses an amount that does not match the bill', async () => {
    const id = await checkedOut();
    for (const amountSantim of [3999, 4001]) {
      const res = await request(t.app)
        .post(`/v1/staff/bookings/${id}/cash`)
        .set(attendant.header)
        .send({ amountSantim });
      expect(res.status, String(amountSantim)).toBe(400);
    }
  });

  it('refuses to settle a booking that is not checked out', async () => {
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
    });

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 2000 });
    expect(res.status).toBe(409);
  });

  it('unblocks the driver from booking again', async () => {
    const id = await checkedOut();
    const blocked = await request(t.app)
      .post('/v1/bookings')
      .set(await reissue(t, driver).then((d) => d.header))
      .send({ lotId: lot.lotId, plannedMinutes: 30, lat: lot.latitude, lng: lot.longitude });
    expect(errorCode(blocked)).toBe('OUTSTANDING_BALANCE');

    await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000 });

    const allowed = await request(t.app)
      .post('/v1/bookings')
      .set(await reissue(t, driver).then((d) => d.header))
      .send({ lotId: lot.lotId, plannedMinutes: 30, lat: lot.latitude, lng: lot.longitude });
    expect(allowed.status).toBe(201);
  });
});

describe('PATCH /v1/staff/slots/:id', () => {
  it('takes a free slot out of service and back', async () => {
    const off = await request(t.app)
      .patch(`/v1/staff/slots/${lot.slotIds[0]!}`)
      .set(attendant.header)
      .send({ inService: false });
    expect(off.status).toBe(200);

    const status = await t.db.db
      .selectFrom('slot_status')
      .select('display_status')
      .where('slot_id', '=', lot.slotIds[0]!)
      .executeTakeFirstOrThrow();
    expect(status.display_status).toBe('out_of_service');

    const on = await request(t.app)
      .patch(`/v1/staff/slots/${lot.slotIds[0]!}`)
      .set(attendant.header)
      .send({ inService: true });
    expect(on.status).toBe(200);
  });

  it('refuses while the slot holds a live booking', async () => {
    await request(t.app)
      .post(`/v1/staff/lots/${lot.lotId}/walk-ins`)
      .set(attendant.header)
      .send({ slotId: lot.slotIds[0] });

    const res = await request(t.app)
      .patch(`/v1/staff/slots/${lot.slotIds[0]!}`)
      .set(attendant.header)
      .send({ inService: false });

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('SLOT_IN_USE');
  });

  it('refuses a slot at a lot the attendant does not staff', async () => {
    const other = await makeActor(t, 'attendant');
    const res = await request(t.app)
      .patch(`/v1/staff/slots/${lot.slotIds[0]!}`)
      .set(other.header)
      .send({ inService: false });
    expect(res.status).toBe(404);
  });
});
