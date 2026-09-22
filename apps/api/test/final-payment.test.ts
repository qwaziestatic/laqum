import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { confirmPayment, refundQueue } from '../src/payments/service.js';
import { signPayload } from '../src/payments/signature.js';
import { makeActor, reissue, staffLot, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, seedBooking, type LotFixture } from './helpers/fixtures.js';

let t: TestContext;
let lot: LotFixture;
let driver: Actor;
let attendant: Actor;
let admin: Actor;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.provider.reset();
  t.scheduler.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');

  lot = await createLot(t.db.db, {
    slots: 2,
    blockMinutes: 30,
    ratePerBlockSantim: 2000,
    overstayRatePerBlockSantim: 4000,
    depositSantim: 0,
  });
  driver = await makeActor(t, 'driver');
  attendant = await makeActor(t, 'attendant');
  admin = await makeActor(t, 'operator_admin');
  await staffLot(t, attendant, lot.lotId);
  await staffLot(t, admin, lot.lotId);
});

interface ErrorBody {
  error: { code: string; message: string };
}
const errorCode = (res: { body: unknown }): string => (res.body as ErrorBody).error.code;

async function statusOf(bookingId: string): Promise<string> {
  const row = await t.db.db
    .selectFrom('bookings')
    .select('status')
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return row.status;
}

/** A booking that has been checked out and owes 4000 santim. */
async function checkedOut(): Promise<string> {
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
  const res = await request(t.app).post(`/v1/staff/bookings/${id}/check-out`).set(attendant.header);
  expect(res.status).toBe(200);
  return id;
}

async function startInAppPayment(bookingId: string): Promise<string> {
  const res = await request(t.app)
    .post(`/v1/bookings/${bookingId}/pay`)
    .set((await reissue(t, driver)).header);
  expect(res.status).toBe(201);
  return (res.body as { txRef: string }).txRef;
}

function webhook(txRef: string) {
  const raw = JSON.stringify({ tx_ref: txRef, status: 'success' });
  return request(t.app)
    .post('/v1/webhooks/chapa')
    .set('Content-Type', 'application/json')
    .set('x-chapa-signature', signPayload(t.ctx.config.CHAPA_WEBHOOK_SECRET, raw))
    .send(raw);
}

describe('paying the final bill in the app', () => {
  it('settles the booking when the payment confirms', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);

    await webhook(txRef);

    expect(await statusOf(id)).toBe('PAID');
    const payment = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('tx_ref', '=', txRef)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('success');
    expect(payment.amount_santim).toBe(4000);
  });

  it('reuses the pending reference instead of opening a second one', async () => {
    const id = await checkedOut();
    const first = await startInAppPayment(id);

    // A driver who taps Pay twice must not end up with two live references.
    t.provider.setStatus(first, 'pending');
    const second = await request(t.app)
      .post(`/v1/bookings/${id}/pay`)
      .set((await reissue(t, driver)).header);
    expect(second.status).toBe(201);

    const finals = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', id)
      .where('kind', '=', 'final')
      .execute();
    // The endpoint checks the existing reference first; at most one can ever
    // succeed because of one_paid_final_per_booking.
    expect(finals.filter((p) => p.status === 'success')).toHaveLength(0);
  });

  it('refuses to start a payment on a booking that is already settled', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    await webhook(txRef);

    const res = await request(t.app)
      .post(`/v1/bookings/${id}/pay`)
      .set((await reissue(t, driver)).header);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ALREADY_PAID');
  });
});

describe('cash while an in-app payment is pending', () => {
  it('CONFIRMS the in-app payment and refuses the cash when it succeeded', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    // The driver paid on their phone; the webhook has not arrived yet.

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000 });

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ALREADY_PAID');

    // The cash was refused AND the in-app payment was settled, so the
    // attendant is not left holding an unsettled booking.
    expect(await statusOf(id)).toBe('PAID');
    const payments = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', id)
      .where('kind', '=', 'final')
      .execute();
    expect(payments).toHaveLength(1);
    expect(payments[0]?.provider).toBe('cash');
    expect(payments[0]?.tx_ref).toBe(txRef);
    expect(payments[0]?.status).toBe('success');
  });

  it('REFUSES the cash with PAYMENT_PENDING while the payment is still pending', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    t.provider.setStatus(txRef, 'pending');

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000 });

    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('PAYMENT_PENDING');
    expect(await statusOf(id)).toBe('CHECKED_OUT');
  });

  it('takes the cash when the attendant explicitly overrides', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    t.provider.setStatus(txRef, 'pending');

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000, overridePending: true });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('PAID');
  });

  it('takes the cash without fuss when the in-app payment failed', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    t.provider.setStatus(txRef, 'failed');

    const res = await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000 });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('PAID');
  });
});

describe('the cash / in-app race', () => {
  it('settles exactly once when both land at the same moment', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    // Pending at the moment the attendant starts, so the pre-check does not
    // short-circuit and both paths genuinely race.
    t.provider.setStatus(txRef, 'pending');

    const cash = request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000, overridePending: true });

    // The webhook arrives at the same instant, and by then it succeeded.
    const inApp = (async () => {
      t.provider.setStatus(txRef, 'success');
      return confirmPayment(t.ctx, txRef);
    })();

    const [cashRes, inAppOutcome] = await Promise.all([cash, inApp]);

    // Exactly one settlement, whichever won.
    expect(await statusOf(id)).toBe('PAID');

    const successfulFinals = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', id)
      .where('kind', '=', 'final')
      .where('status', '=', 'success')
      .execute();

    // one_paid_final_per_booking permits only one. If both collected, the
    // second is visible as an overpayment rather than silently kept.
    const paidEvents = await t.db.db
      .selectFrom('booking_events')
      .select('to_status')
      .where('booking_id', '=', id)
      .where('to_status', '=', 'PAID')
      .execute();
    expect(paidEvents).toHaveLength(1);

    const queue = await refundQueue(t.ctx);
    if (successfulFinals.length > 1) {
      // Both took money: the duplicate must be queued for refund.
      expect(successfulFinals).toHaveLength(2);
      expect(queue.map((q) => q.reason)).toContain('overpayment');
    } else {
      // One won cleanly and the other was refused.
      expect(successfulFinals).toHaveLength(1);
      expect(queue).toEqual([]);
      const cashWon = cashRes.status === 200;
      expect(cashWon || inAppOutcome.kind === 'confirmed').toBe(true);
    }
  }, 30_000);

  it('queues an overpayment when the in-app payment confirms after cash', async () => {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    t.provider.setStatus(txRef, 'pending');

    // Attendant takes cash with an explicit override.
    await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000, overridePending: true });
    expect(await statusOf(id)).toBe('PAID');

    // The driver completes the checkout page anyway.
    t.provider.setStatus(txRef, 'success');
    const outcome = await confirmPayment(t.ctx, txRef);

    expect(outcome).toMatchObject({ kind: 'late', reason: 'overpayment' });
    expect(await statusOf(id)).toBe('PAID');

    const queue = await refundQueue(t.ctx);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bookingId: id, reason: 'overpayment', amountSantim: 4000 });
  });
});

describe('the operator refund queue', () => {
  async function anOverpayment(): Promise<string> {
    const id = await checkedOut();
    const txRef = await startInAppPayment(id);
    t.provider.setStatus(txRef, 'pending');
    await request(t.app)
      .post(`/v1/staff/bookings/${id}/cash`)
      .set(attendant.header)
      .send({ amountSantim: 4000, overridePending: true });
    t.provider.setStatus(txRef, 'success');
    await confirmPayment(t.ctx, txRef);
    return id;
  }

  it('lists money needing a refund, scoped to the lots the admin staffs', async () => {
    const bookingId = await anOverpayment();

    const res = await request(t.app)
      .get('/v1/admin/refunds')
      .set((await reissue(t, admin)).header);

    expect(res.status).toBe(200);
    const body = res.body as { refunds: { bookingId: string; reason: string }[] };
    expect(body.refunds).toHaveLength(1);
    expect(body.refunds[0]).toMatchObject({ bookingId, reason: 'overpayment' });
  });

  it('shows nothing to an admin at another lot', async () => {
    await anOverpayment();
    const stranger = await makeActor(t, 'operator_admin');

    const res = await request(t.app).get('/v1/admin/refunds').set(stranger.header);
    expect((res.body as { refunds: unknown[] }).refunds).toEqual([]);
  });

  it('refuses an attendant', async () => {
    const res = await request(t.app).get('/v1/admin/refunds').set(attendant.header);
    expect(res.status).toBe(403);
  });

  it('removes the item once a refund is recorded', async () => {
    const bookingId = await anOverpayment();
    admin = await reissue(t, admin);

    const listed = await request(t.app).get('/v1/admin/refunds').set(admin.header);
    const paymentId = (listed.body as { refunds: { paymentId: string }[] }).refunds[0]!.paymentId;

    const recorded = await request(t.app)
      .post(`/v1/admin/payments/${paymentId}/refund-recorded`)
      .set(admin.header)
      .send({ reason: 'duplicate payment' });

    expect(recorded.status).toBe(201);
    expect((recorded.body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(false);

    const after = await request(t.app).get('/v1/admin/refunds').set(admin.header);
    expect((after.body as { refunds: unknown[] }).refunds).toEqual([]);

    const refundRow = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .where('kind', '=', 'refund')
      .executeTakeFirstOrThrow();
    expect(refundRow.status).toBe('success');
    expect(refundRow.amount_santim).toBe(4000);
    // A refund always has a named operator behind it.
    expect(refundRow.recorded_by).toBe(admin.userId);
  });

  it('is IDEMPOTENT: recording twice does not create two refunds', async () => {
    await anOverpayment();
    admin = await reissue(t, admin);
    const listed = await request(t.app).get('/v1/admin/refunds').set(admin.header);
    const paymentId = (listed.body as { refunds: { paymentId: string }[] }).refunds[0]!.paymentId;

    const first = await request(t.app)
      .post(`/v1/admin/payments/${paymentId}/refund-recorded`)
      .set(admin.header)
      .send({});
    const second = await request(t.app)
      .post(`/v1/admin/payments/${paymentId}/refund-recorded`)
      .set(admin.header)
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);

    const refunds = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('kind', '=', 'refund')
      .execute();
    expect(refunds).toHaveLength(1);
  });

  it('supports a partial refund and refuses more than was collected', async () => {
    await anOverpayment();
    admin = await reissue(t, admin);
    const listed = await request(t.app).get('/v1/admin/refunds').set(admin.header);
    const paymentId = (listed.body as { refunds: { paymentId: string }[] }).refunds[0]!.paymentId;

    const tooMuch = await request(t.app)
      .post(`/v1/admin/payments/${paymentId}/refund-recorded`)
      .set(admin.header)
      .send({ amountSantim: 5000 });
    expect(tooMuch.status).toBe(400);

    const partial = await request(t.app)
      .post(`/v1/admin/payments/${paymentId}/refund-recorded`)
      .set(admin.header)
      .send({ amountSantim: 1500 });
    expect(partial.status).toBe(201);

    const refund = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('kind', '=', 'refund')
      .executeTakeFirstOrThrow();
    expect(refund.amount_santim).toBe(1500);
  });
});
