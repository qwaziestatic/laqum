import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeActor, reissue, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, seedBooking, type LotFixture } from './helpers/fixtures.js';

let t: TestContext;
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
  driver = await makeActor(t, 'driver');
  lot = await createLot(t.db.db, { slots: 3, depositSantim: 0, blockMinutes: 30 });
});

interface BookingBody {
  booking: {
    id: string;
    status: string;
    slotId: string;
    shortCode: string | null;
    qrToken: string | null;
    plannedMinutes: number | null;
    plannedEndAt: string | null;
    holdExpiresAt: string | null;
    updatedAt: string;
  };
  paymentRequired?: boolean;
  depositAmountSantim?: number;
  checkoutUrl?: string | null;
  addedMinutes?: number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const errorCode = (res: { body: unknown }): string => (res.body as ErrorBody).error.code;

async function book(actor = driver, plannedMinutes = 60) {
  return request(t.app).post('/v1/bookings').set(actor.header).send({
    lotId: lot.lotId,
    plannedMinutes,
    vehiclePlate: 'AA-11111',
    lat: lot.latitude,
    lng: lot.longitude,
  });
}

describe('POST /v1/bookings', () => {
  it('creates a reserved booking and returns its credentials', async () => {
    const res = await book();
    expect(res.status).toBe(201);

    const body = res.body as BookingBody;
    expect(body.booking.status).toBe('RESERVED');
    expect(body.booking.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/u);
    expect(body.booking.qrToken).toBeTruthy();
    expect(body.booking.holdExpiresAt).toBe('2026-03-01T08:15:00.000Z');
    expect(body.paymentRequired).toBe(false);
    expect(body.checkoutUrl).toBeNull();
  });

  it('reports a deposit as pending payment with no checkout url yet', async () => {
    const paid = await createLot(t.db.db, { slots: 1, depositSantim: 2000 });
    const res = await request(t.app)
      .post('/v1/bookings')
      .set(driver.header)
      .send({ lotId: paid.lotId, plannedMinutes: 30, lat: paid.latitude, lng: paid.longitude });

    expect(res.status).toBe(201);
    const body = res.body as BookingBody;
    expect(body.booking.status).toBe('PENDING_PAYMENT');
    expect(body.paymentRequired).toBe(true);
    expect(body.depositAmountSantim).toBe(2000);
    // Phase 2 fills this in.
    expect(body.checkoutUrl).toBeNull();
    // The payment window, not the arrival hold.
    expect(body.booking.holdExpiresAt).toBe('2026-03-01T08:03:00.000Z');
  });

  it('requires authentication', async () => {
    const res = await request(t.app).post('/v1/bookings').send({});
    expect(res.status).toBe(401);
  });

  it('rejects a duration that is not a whole number of blocks', async () => {
    const res = await book(driver, 45);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_ERROR');
  });

  it('rejects a driver who is too far away', async () => {
    const far = await createLot(t.db.db, { slots: 1, maxBookingDistanceM: 100 });
    const res = await request(t.app)
      .post('/v1/bookings')
      .set(driver.header)
      .send({
        lotId: far.lotId,
        plannedMinutes: 30,
        lat: far.latitude + 0.05,
        lng: far.longitude,
      });

    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('TOO_FAR');
  });

  it('refuses a second live booking', async () => {
    expect((await book()).status).toBe(201);
    const second = await book();
    expect(second.status).toBe(409);
    expect(['ALREADY_HAS_ACTIVE_BOOKING', 'SLOT_TAKEN']).toContain(errorCode(second));
  });

  it('refuses a driver with an unpaid checkout', async () => {
    await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[2]!,
      userId: driver.userId,
      status: 'CHECKED_OUT',
    });

    const res = await book();
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('OUTSTANDING_BALANCE');
  });
});

describe('GET /v1/bookings/current', () => {
  it('returns null when the driver has nothing outstanding', async () => {
    const res = await request(t.app).get('/v1/bookings/current').set(driver.header);
    expect(res.status).toBe(200);
    expect((res.body as BookingBody).booking).toBeNull();
  });

  it('returns the live booking', async () => {
    const created = (await book()).body as BookingBody;
    const res = await request(t.app).get('/v1/bookings/current').set(driver.header);
    expect((res.body as BookingBody).booking.id).toBe(created.booking.id);
  });

  it('returns an unpaid checkout, because it is what blocks a new booking', async () => {
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_OUT',
    });

    const res = await request(t.app).get('/v1/bookings/current').set(driver.header);
    expect((res.body as BookingBody).booking.id).toBe(id);
  });
});

describe('GET /v1/bookings/:id', () => {
  it("refuses another driver's booking as if it did not exist", async () => {
    const created = (await book()).body as BookingBody;
    const stranger = await makeActor(t, 'driver');

    const res = await request(t.app).get(`/v1/bookings/${created.booking.id}`).set(stranger.header);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/bookings/:id/cancel', () => {
  it('cancels a reserved booking and frees the slot', async () => {
    const created = (await book()).body as BookingBody;

    const res = await request(t.app)
      .post(`/v1/bookings/${created.booking.id}/cancel`)
      .set(driver.header);

    expect(res.status).toBe(200);
    expect((res.body as BookingBody).booking.status).toBe('CANCELLED');

    const free = await t.db.db
      .selectFrom('slot_status')
      .select('slot_id')
      .where('lot_id', '=', lot.lotId)
      .where('display_status', '=', 'free')
      .execute();
    expect(free).toHaveLength(3);

    // The hold expiry job is pointless now.
    expect(t.scheduler.cancelled.map((c) => c.queue)).toContain('expire-hold');
  });

  it('refuses to cancel once the car is in the slot', async () => {
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
    });

    const res = await request(t.app).post(`/v1/bookings/${id}/cancel`).set(driver.header);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('STATE_CONFLICT');
  });
});

describe('POST /v1/bookings/:id/extend', () => {
  async function checkedIn(plannedMinutes = 60) {
    const checkedInAt = new Date('2026-03-01T08:00:00.000Z');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedMinutes,
      checkedInAt,
      plannedEndAt: addMinutes(checkedInAt, plannedMinutes),
    });
    return id;
  }

  it('adds whole blocks and moves the planned end', async () => {
    const id = await checkedIn(60);
    t.clock.set('2026-03-01T08:30:00.000Z');
    driver = await reissue(t, driver);

    const res = await request(t.app)
      .post(`/v1/bookings/${id}/extend`)
      .set(driver.header)
      .send({ additionalBlocks: 2 });

    expect(res.status).toBe(200);
    const body = res.body as BookingBody;
    expect(body.addedMinutes).toBe(60);
    expect(body.booking.plannedMinutes).toBe(120);
    expect(body.booking.plannedEndAt).toBe('2026-03-01T10:00:00.000Z');
  });

  it('reschedules the overstay and reminder jobs to the new deadline', async () => {
    const id = await checkedIn(60);
    t.clock.set('2026-03-01T08:30:00.000Z');
    driver = await reissue(t, driver);
    t.scheduler.reset();

    await request(t.app)
      .post(`/v1/bookings/${id}/extend`)
      .set(driver.header)
      .send({ additionalBlocks: 1 });

    const overstay = t.scheduler.forQueue('mark-overstay');
    const reminder = t.scheduler.forQueue('time-reminder');

    expect(overstay).toHaveLength(1);
    expect(overstay[0]?.runAt.toISOString()).toBe('2026-03-01T09:30:00.000Z');
    expect(overstay[0]?.jobId).toBe(`mark-overstay:${id}`);

    // Ten minutes before the new planned end.
    expect(reminder[0]?.runAt.toISOString()).toBe('2026-03-01T09:20:00.000Z');
  });

  it('refuses once the planned end has passed', async () => {
    const id = await checkedIn(60);
    t.clock.set('2026-03-01T09:00:01.000Z');
    driver = await reissue(t, driver);

    const res = await request(t.app)
      .post(`/v1/bookings/${id}/extend`)
      .set(driver.header)
      .send({ additionalBlocks: 1 });

    // Extending retroactively would let a driver buy out of the overstay rate.
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('STATE_CONFLICT');
  });

  it('refuses unless the booking is checked in', async () => {
    const created = (await book()).body as BookingBody;
    const res = await request(t.app)
      .post(`/v1/bookings/${created.booking.id}/extend`)
      .set(driver.header)
      .send({ additionalBlocks: 1 });

    expect(res.status).toBe(409);
  });

  it('rejects a non-positive or fractional block count', async () => {
    const id = await checkedIn(60);
    for (const additionalBlocks of [0, -1, 1.5]) {
      const res = await request(t.app)
        .post(`/v1/bookings/${id}/extend`)
        .set(driver.header)
        .send({ additionalBlocks });
      expect(res.status, String(additionalBlocks)).toBe(400);
    }
  });

  it('does not change the status, so it is not a transition', async () => {
    const id = await checkedIn(60);
    t.clock.set('2026-03-01T08:10:00.000Z');
    driver = await reissue(t, driver);

    await request(t.app)
      .post(`/v1/bookings/${id}/extend`)
      .set(driver.header)
      .send({ additionalBlocks: 1 });

    const events = await t.db.db
      .selectFrom('booking_events')
      .selectAll()
      .where('booking_id', '=', id)
      .execute();
    // Only the seeded creation event: an extension is not a state change.
    expect(events).toHaveLength(1);
  });
});
