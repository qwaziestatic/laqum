import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireHold, type JobDeps } from '../src/jobs/handlers.js';
import { sweep } from '../src/jobs/sweeper.js';
import { initiatePayment } from '../src/payments/initiate.js';
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
let jobDeps: JobDeps;

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
  t.provider.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');

  lot = await createLot(t.db.db, {
    slots: 3,
    blockMinutes: 30,
    ratePerBlockSantim: 2000,
    overstayRatePerBlockSantim: 4000,
    depositSantim: 2000,
    paymentWindowMinutes: 3,
    holdMinutes: 15,
  });
  driver = await makeActor(t, 'driver');
  attendant = await makeActor(t, 'attendant');
  await staffLot(t, attendant, lot.lotId);
  jobDeps = { db: t.db.db, clock: t.clock, logger: t.ctx.logger, payments: t.ctx };
});

/**
 * The webhook answers 200 BEFORE it processes, on purpose — Chapa must not be
 * kept waiting on our database. So a test that asserts the effect has to wait
 * for it. Polling real milliseconds here is fine: this is waiting for an async
 * task to finish, not for a business deadline, which is what the FakeClock is
 * for.
 */
async function waitUntil(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForStatus(bookingId: string, status: string): Promise<void> {
  await waitUntil(async () => (await statusOf(bookingId)) === status, `booking to be ${status}`);
}

/** Give the fire-and-forget webhook processing a chance to run and settle. */
async function settleWebhook(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function statusOf(bookingId: string): Promise<string> {
  const row = await t.db.db
    .selectFrom('bookings')
    .select('status')
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function paymentFor(bookingId: string, kind: 'deposit' | 'final') {
  return t.db.db
    .selectFrom('payments')
    .selectAll()
    .where('booking_id', '=', bookingId)
    .where('kind', '=', kind)
    .executeTakeFirst();
}

/** A booking sitting in PENDING_PAYMENT with an initialised deposit. */
async function bookingAwaitingDeposit(): Promise<{ bookingId: string; txRef: string }> {
  const bookingId = await seedBooking(t.db.db, {
    lotId: lot.lotId,
    slotId: lot.slotIds[0]!,
    userId: driver.userId,
    status: 'PENDING_PAYMENT',
    holdExpiresAt: addMinutes(t.clock.now(), 3),
    at: t.clock.now(),
  });

  const initiated = await initiatePayment(t.ctx, {
    bookingId,
    kind: 'deposit',
    amountSantim: 2000,
  });
  return { bookingId, txRef: initiated.payment.tx_ref! };
}

// ─────────────────────────────────────────────────────────────────────────
describe('amount integrity', () => {
  it('confirms a deposit whose amount, currency and reference all match', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();

    const outcome = await confirmPayment(t.ctx, txRef);

    expect(outcome.kind).toBe('confirmed');
    expect(await statusOf(bookingId)).toBe('RESERVED');
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('success');
  });

  it('REJECTS a success whose amount disagrees, and records why', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    // The provider says success, but for a different amount.
    t.provider.reportDifferentAmount(txRef, 500);

    const outcome = await confirmPayment(t.ctx, txRef);

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.failures).toContainEqual({ field: 'amount', expected: 2000, actual: 500 });
    }

    // A success status alone did NOT move the booking.
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');

    const payment = await paymentFor(bookingId, 'deposit');
    expect(payment?.status).toBe('failed');
    // The whole provider response is kept for the dispute.
    expect(JSON.stringify(payment?.provider_payload)).toContain('amount');
  });

  it('REJECTS a success in the wrong currency', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    t.provider.reportDifferentCurrency(txRef, 'USD');

    const outcome = await confirmPayment(t.ctx, txRef);

    expect(outcome.kind).toBe('rejected');
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('failed');
  });

  it('leaves a pending payment pending, so a later webhook can still settle it', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    t.provider.setStatus(txRef, 'pending');

    const outcome = await confirmPayment(t.ctx, txRef);

    expect(outcome).toMatchObject({ kind: 'not_successful', status: 'pending' });
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('pending');
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
  });

  it('treats an unknown reference as unknown, never as success', async () => {
    expect(await confirmPayment(t.ctx, 'laqum-dep-doesnotexist')).toEqual({
      kind: 'unknown_reference',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('late payment: the deposit succeeds after the booking expired', () => {
  it('keeps EXPIRED, records the money, and queues it for an operator refund', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();

    // The payment window lapses with no webhook, and the provider says the
    // payment never succeeded, so the booking expires.
    t.provider.setStatus(txRef, 'failed');
    t.clock.advanceMinutes(4);
    expect((await expireHold(jobDeps, bookingId)).applied).toBe(true);
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    // The money then lands anyway.
    t.provider.setStatus(txRef, 'success');
    const outcome = await confirmPayment(t.ctx, txRef);

    // EXPIRED -> RESERVED stays illegal; the booking does not move.
    expect(outcome).toMatchObject({ kind: 'late', reason: 'late_deposit' });
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    // The payment is recorded truthfully: it really did succeed.
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('success');

    // And an operator can see it needs refunding.
    const queue = await refundQueue(t.ctx);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      bookingId,
      reason: 'late_deposit',
      amountSantim: 2000,
      bookingStatus: 'EXPIRED',
    });
  });

  it('tells the driver, through their own booking', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    t.provider.setStatus(txRef, 'failed');
    t.clock.advanceMinutes(4);
    await expireHold(jobDeps, bookingId);
    t.provider.setStatus(txRef, 'success');
    await confirmPayment(t.ctx, txRef);

    const res = await request(t.app)
      .get(`/v1/bookings/${bookingId}`)
      .set((await reissue(t, driver)).header);

    expect(res.status).toBe(200);
    expect((res.body as { paymentNotice: string }).paymentNotice).toBe('deposit_refund_pending');
  });

  it('does NOT queue a deposit on a booking that really did reserve', async () => {
    // The normal forfeit case: the driver held a slot and did not show up.
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    await confirmPayment(t.ctx, txRef);
    expect(await statusOf(bookingId)).toBe('RESERVED');

    t.clock.advanceMinutes(20);
    await expireHold(jobDeps, bookingId);
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    // Deposits are kept on EXPIRED when the slot was actually held.
    expect(await refundQueue(t.ctx)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('lost webhook: expiry asks the provider first', () => {
  it('reserves instead of expiring when the payment actually succeeded', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();

    // No webhook ever arrives, but the money is there.
    t.clock.advanceMinutes(4);
    const result = await expireHold(jobDeps, bookingId);

    expect(result).toMatchObject({ applied: false, reason: 'PAYMENT_CONFIRMED' });
    expect(await statusOf(bookingId)).toBe('RESERVED');
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('success');
    expect(txRef).toMatch(/^laqum-dep-/u);
  });

  it('expires normally when the provider says the payment failed', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    t.provider.setStatus(txRef, 'failed');

    t.clock.advanceMinutes(4);
    expect((await expireHold(jobDeps, bookingId)).applied).toBe(true);
    expect(await statusOf(bookingId)).toBe('EXPIRED');
  });

  it('DEFERS rather than expiring while the provider is unreachable', async () => {
    const { bookingId } = await bookingAwaitingDeposit();
    t.provider.unavailable = true;

    t.clock.advanceMinutes(4);

    // Thrown, so BullMQ retries and the sweeper tries again. Expiring on
    // "I don't know" would destroy a reservation the driver paid for.
    await expect(expireHold(jobDeps, bookingId)).rejects.toThrow(/unreachable/iu);
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
  });

  it('expires anyway once the deferral window is exhausted', async () => {
    const { bookingId } = await bookingAwaitingDeposit();
    t.provider.unavailable = true;

    // Just inside the bound: still deferring.
    t.clock.advanceMinutes(3 + 15);
    await expect(expireHold(jobDeps, bookingId)).rejects.toThrow(/unreachable/iu);
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');

    // Past it: a slot cannot be held hostage by an outage forever.
    t.clock.advanceMinutes(2);
    expect((await expireHold(jobDeps, bookingId)).applied).toBe(true);
    expect(await statusOf(bookingId)).toBe('EXPIRED');
  });

  it('recovers: a payment that lands after a forced expiry goes to the refund queue', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    t.provider.unavailable = true;
    t.clock.advanceMinutes(3 + 16);
    await expireHold(jobDeps, bookingId);
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    t.provider.unavailable = false;
    await confirmPayment(t.ctx, txRef);

    const queue = await refundQueue(t.ctx);
    expect(queue.map((q) => q.reason)).toEqual(['late_deposit']);
  });

  it('a deferred expiry does not stop the sweeper handling everything else', async () => {
    // The first overdue hold in the sweep is a deposit the provider cannot be
    // asked about. The sweeper is the safety net for jobs that were lost; one
    // outage must not switch it off for every other booking.
    const { bookingId: deferred } = await bookingAwaitingDeposit();
    const other = await makeActor(t, 'driver');
    const parked = await makeActor(t, 'driver');
    const lapsed = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: other.userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 4),
    });
    const overstaying = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[2]!,
      userId: parked.userId,
      status: 'CHECKED_IN',
      plannedMinutes: 30,
      checkedInAt: t.clock.now(),
      plannedEndAt: addMinutes(t.clock.now(), 5),
    });

    t.provider.unavailable = true;
    t.clock.advanceMinutes(6);
    const report = await sweep(jobDeps);

    expect(await statusOf(deferred)).toBe('PENDING_PAYMENT');
    expect(await statusOf(lapsed)).toBe('EXPIRED');
    expect(await statusOf(overstaying)).toBe('OVERSTAY');
    expect(report.expired.find((r) => r.bookingId === deferred)).toMatchObject({
      applied: false,
      reason: 'DEFERRED',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the webhook endpoint', () => {
  function post(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    const sig = signature ?? signPayload(t.ctx.config.CHAPA_WEBHOOK_SECRET, raw);
    return request(t.app)
      .post('/v1/webhooks/chapa')
      .set('Content-Type', 'application/json')
      .set('x-chapa-signature', sig)
      .send(raw);
  }

  it('confirms a deposit and answers 200', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();

    const res = await post({ tx_ref: txRef, status: 'success' });

    expect(res.status).toBe(200);
    await waitForStatus(bookingId, 'RESERVED');
  });

  it('is idempotent across DUPLICATE deliveries', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    const body = { tx_ref: txRef, status: 'success' };

    for (let i = 0; i < 3; i++) {
      expect((await post(body)).status).toBe(200);
      await settleWebhook();
    }

    await waitForStatus(bookingId, 'RESERVED');

    // one_paid_deposit_per_booking permits only one, and the CAS permits only
    // one transition: creation + the single RESERVED event.
    const events = await t.db.db
      .selectFrom('booking_events')
      .select('to_status')
      .where('booking_id', '=', bookingId)
      .execute();
    expect(events.map((e) => e.to_status)).toEqual(['PENDING_PAYMENT', 'RESERVED']);

    const deposits = await t.db.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .where('kind', '=', 'deposit')
      .execute();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.status).toBe('success');
  });

  it('ignores an OUT-OF-ORDER stale delivery arriving after success', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    await post({ tx_ref: txRef, status: 'success' });
    await waitForStatus(bookingId, 'RESERVED');

    // A stale 'pending' notification turns up late. The body is never acted
    // on, and the payment is already settled, so nothing changes.
    t.provider.setStatus(txRef, 'pending');
    expect((await post({ tx_ref: txRef, status: 'pending' })).status).toBe(200);
    await settleWebhook();

    expect(await statusOf(bookingId)).toBe('RESERVED');
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('success');
  });

  it('never trusts the body: a forged success does not settle anything', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    // The provider says pending; the body claims success. verify() decides.
    t.provider.setStatus(txRef, 'pending');

    expect((await post({ tx_ref: txRef, status: 'success', amount: '999999' })).status).toBe(200);
    await settleWebhook();

    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
    expect((await paymentFor(bookingId, 'deposit'))?.status).toBe('pending');
  });

  it('rejects an invalid signature with 401 and does nothing', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();

    const res = await post({ tx_ref: txRef, status: 'success' }, 'a'.repeat(64));

    expect(res.status).toBe(401);
    await settleWebhook();
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');
  });

  it('rejects a missing signature', async () => {
    const { txRef } = await bookingAwaitingDeposit();
    const res = await request(t.app)
      .post('/v1/webhooks/chapa')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ tx_ref: txRef }));
    expect(res.status).toBe(401);
  });

  it('rejects a caller presenting only the weak chapa-signature header', async () => {
    const { txRef } = await bookingAwaitingDeposit();
    const body = JSON.stringify({ tx_ref: txRef, status: 'success' });

    const res = await request(t.app)
      .post('/v1/webhooks/chapa')
      .set('Content-Type', 'application/json')
      .set('chapa-signature', signPayload(t.ctx.config.CHAPA_WEBHOOK_SECRET, 'anything'))
      .send(body);

    // Deliberately stricter than Chapa's "either header is sufficient".
    expect(res.status).toBe(401);
  });

  it('acknowledges an unknown reference without failing', async () => {
    const res = await post({ tx_ref: 'laqum-dep-nope', status: 'success' });
    expect(res.status).toBe(200);
  });

  it('accepts trx_ref, which Chapa uses in its callback payload', async () => {
    const { bookingId, txRef } = await bookingAwaitingDeposit();
    expect((await post({ trx_ref: txRef, status: 'success' })).status).toBe(200);
    await waitForStatus(bookingId, 'RESERVED');
  });
});
