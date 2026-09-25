import {
  bookingResponseSchema,
  createBookingResponseSchema,
  payDepositResponseSchema,
  type CreateBookingResponse,
} from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireHold, type JobDeps } from '../src/jobs/handlers.js';
import { sweep } from '../src/jobs/sweeper.js';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * DEPOSITS AT BOOKING TIME.
 *
 * A deposit booking starts in PENDING_PAYMENT and its payment is started with
 * it. The product owner's decisions, each tested here:
 *
 *   - if the provider cannot be reached, the booking still stands, with a
 *     retry, and expires after its payment window;
 *   - THE GUARD: expiry is deferred during an outage ONLY for a payment that
 *     was actually initialized. A booking whose payment never started expires
 *     exactly at its payment window, so an outage cannot hold slots for the
 *     15-minute deferral bound.
 */

let t: TestContext;
let lot: LotFixture;
let driver: Actor;
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
    depositSantim: 2000,
    paymentWindowMinutes: 3,
    holdMinutes: 15,
  });
  driver = await makeActor(t, 'driver');
  jobDeps = { db: t.db.db, clock: t.clock, logger: t.ctx.logger, payments: t.ctx };
});

function errorCode(res: { body: unknown }): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code;
}

async function book(actor: Actor = driver): Promise<CreateBookingResponse> {
  const res = await request(t.app)
    .post('/v1/bookings')
    .set(actor.header)
    .send({ lotId: lot.lotId, plannedMinutes: 30, lat: lot.latitude, lng: lot.longitude });
  expect(res.status).toBe(201);
  return createBookingResponseSchema.parse(res.body);
}

function openDeposit(bookingId: string, actor: Actor = driver) {
  return request(t.app).post(`/v1/bookings/${bookingId}/deposit`).set(actor.header);
}

function verifyDeposit(bookingId: string, actor: Actor = driver) {
  return request(t.app).post(`/v1/bookings/${bookingId}/deposit/verify`).set(actor.header);
}

async function deposits(bookingId: string) {
  return t.db.db
    .selectFrom('payments')
    .selectAll()
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'deposit')
    .orderBy('created_at')
    .execute();
}

async function booking(bookingId: string) {
  return t.db.db
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow();
}

// ─────────────────────────────────────────────────────────────────────────
describe('a deposit booking starts its payment', () => {
  it('returns the checkout, and records the payment as initialized', async () => {
    const created = await book();

    expect(created.booking.status).toBe('PENDING_PAYMENT');
    expect(created.checkoutUrl).toMatch(/^https:\/\/checkout\.test\/pay\/laqum-dep-/u);

    const [payment, ...others] = await deposits(created.booking.id);
    expect(others).toEqual([]);
    expect(payment).toMatchObject({
      status: 'pending',
      amount_santim: 2000,
      checkout_url: created.checkoutUrl,
    });
  });

  it('reserves the booking once the provider confirms, restarting the clock as the arrival hold', async () => {
    const created = await book();
    t.clock.advanceMinutes(1);

    const res = await verifyDeposit(created.booking.id);
    expect(res.status).toBe(200);
    const body = bookingResponseSchema.parse(res.body);
    expect(body.booking.status).toBe('RESERVED');
    // Confirmed at 08:01; the lot holds for 15 minutes.
    expect(body.booking.holdExpiresAt).toBe('2026-03-01T08:16:00.000Z');
  });

  it('starts no payment on a lot without a deposit', async () => {
    lot = await createLot(t.db.db, { slots: 1, depositSantim: 0 });
    const created = await book();

    expect(created.booking.status).toBe('RESERVED');
    expect(created.checkoutUrl).toBeNull();
    expect(await deposits(created.booking.id)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the provider cannot be reached at booking time', () => {
  it('still creates the booking, in PENDING_PAYMENT with no checkout', async () => {
    t.provider.unavailable = true;
    const created = await book();

    expect(created.booking.status).toBe('PENDING_PAYMENT');
    expect(created.paymentRequired).toBe(true);
    expect(created.checkoutUrl).toBeNull();

    // The row stays, so a webhook for a transaction the provider did create
    // can still be resolved. It was never given a checkout.
    const [payment] = await deposits(created.booking.id);
    expect(payment).toMatchObject({ status: 'pending', checkout_url: null });
  });

  it('THE GUARD: expires exactly at its payment window while the provider is still down', async () => {
    t.provider.unavailable = true;
    const created = await book();
    const deadline = (await booking(created.booking.id)).hold_expires_at!;

    // A second early: not yet.
    t.clock.set(new Date(deadline.getTime() - 1000).toISOString());
    expect(await expireHold(jobDeps, created.booking.id)).toMatchObject({
      applied: false,
      reason: 'NOT_DUE',
    });

    // Exactly at the window, with the provider STILL unreachable: nothing was
    // initialized, so there is nothing to ask about and nothing to defer for.
    t.clock.set(deadline.toISOString());
    expect(await expireHold(jobDeps, created.booking.id)).toMatchObject({ applied: true });
    expect((await booking(created.booking.id)).status).toBe('EXPIRED');
  });

  it('THE GUARD, through the sweeper: expired, not deferred', async () => {
    t.provider.unavailable = true;
    const created = await book();
    t.clock.advanceMinutes(3);

    const report = await sweep(jobDeps);
    expect(report.expired).toEqual([
      { queue: 'expire-hold', bookingId: created.booking.id, applied: true },
    ]);
  });

  it('by contrast, an INITIALIZED deposit is deferred during the outage: the driver may have paid', async () => {
    const created = await book();
    t.provider.unavailable = true;
    t.clock.advanceMinutes(3);

    await expect(expireHold(jobDeps, created.booking.id)).rejects.toThrow(/unreachable/iu);
    expect((await booking(created.booking.id)).status).toBe('PENDING_PAYMENT');
  });

  it('retry: starts the payment once the provider is back, and the booking can then be paid', async () => {
    t.provider.unavailable = true;
    const created = await book();
    t.provider.unavailable = false;
    t.clock.advanceMinutes(1);

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(201);
    const opened = payDepositResponseSchema.parse(res.body);
    expect(opened.amountSantim).toBe(2000);
    expect(opened.checkoutUrl).toMatch(/^https:\/\/checkout\.test\/pay\/laqum-dep-/u);

    const rows = await deposits(created.booking.id);
    expect(rows.map((r) => r.checkout_url)).toEqual([null, opened.checkoutUrl]);

    const verified = bookingResponseSchema.parse((await verifyDeposit(created.booking.id)).body);
    expect(verified.booking.status).toBe('RESERVED');
  });

  it('retry while the provider is still down answers 503 and changes nothing', async () => {
    t.provider.unavailable = true;
    const created = await book();

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe('PROVIDER_UNAVAILABLE');
    expect((await booking(created.booking.id)).status).toBe('PENDING_PAYMENT');
    // Two attempts, neither initialized: the guard still applies.
    expect((await deposits(created.booking.id)).map((r) => r.checkout_url)).toEqual([null, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('reopening the deposit', () => {
  it('reopens the same checkout while it is still payable, rather than opening a second one', async () => {
    const created = await book();
    const [first] = await deposits(created.booking.id);
    t.provider.setStatus(first!.tx_ref!, 'pending');

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(200);
    const opened = payDepositResponseSchema.parse(res.body);
    expect(opened).toEqual({
      checkoutUrl: created.checkoutUrl,
      txRef: first!.tx_ref,
      amountSantim: 2000,
    });
    expect(await deposits(created.booking.id)).toHaveLength(1);
  });

  it('starts a new one when the provider reports the last one failed', async () => {
    const created = await book();
    const [first] = await deposits(created.booking.id);
    t.provider.setStatus(first!.tx_ref!, 'failed');

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(201);
    const opened = payDepositResponseSchema.parse(res.body);
    expect(opened.txRef).not.toBe(first!.tx_ref);
    expect(await deposits(created.booking.id)).toHaveLength(2);
  });

  it('finds a payment made on EITHER reference: expiry does not stop at the newest', async () => {
    // First checkout abandoned mid-payment (still pending), a second opened
    // after it was reported failed... then the FIRST one is paid, and its
    // webhook is lost. The expiry pre-check must still find it.
    const created = await book();
    const [first] = await deposits(created.booking.id);
    t.provider.setStatus(first!.tx_ref!, 'failed');
    await openDeposit(created.booking.id);
    const [, second] = await deposits(created.booking.id);
    t.provider.setStatus(second!.tx_ref!, 'pending');
    t.provider.setStatus(first!.tx_ref!, 'success');

    t.clock.advanceMinutes(3);
    expect(await expireHold(jobDeps, created.booking.id)).toMatchObject({
      applied: false,
      reason: 'PAYMENT_CONFIRMED',
    });
    expect((await booking(created.booking.id)).status).toBe('RESERVED');
  });

  it('reports ALREADY_PAID, and reserves, when the deposit was paid but the webhook was lost', async () => {
    const created = await book();

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ALREADY_PAID');
    expect((await booking(created.booking.id)).status).toBe('RESERVED');
  });

  it('refuses a booking with no deposit to pay', async () => {
    lot = await createLot(t.db.db, { slots: 1, depositSantim: 0 });
    const created = await book();

    const res = await openDeposit(created.booking.id);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('STATE_CONFLICT');
  });

  it("does not reveal another driver's booking", async () => {
    const created = await book();
    const stranger = await makeActor(t, 'driver');

    expect((await openDeposit(created.booking.id, stranger)).status).toBe(404);
    expect((await verifyDeposit(created.booking.id, stranger)).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('verifying on return from the checkout', () => {
  it('leaves the booking pending while the payment is', async () => {
    const created = await book();
    const [first] = await deposits(created.booking.id);
    t.provider.setStatus(first!.tx_ref!, 'pending');

    const body = bookingResponseSchema.parse((await verifyDeposit(created.booking.id)).body);
    expect(body.booking.status).toBe('PENDING_PAYMENT');
    expect(body.paymentNotice).toBe('payment_pending');
  });

  it('never starts a payment', async () => {
    t.provider.unavailable = true;
    const created = await book();
    t.provider.unavailable = false;

    const res = await verifyDeposit(created.booking.id);
    expect(res.status).toBe(200);
    expect(bookingResponseSchema.parse(res.body).booking.status).toBe('PENDING_PAYMENT');
    expect(await deposits(created.booking.id)).toHaveLength(1);
    expect(t.provider.initialized((await deposits(created.booking.id))[0]!.tx_ref!)).toBe(false);
  });

  it('answers 503 while the provider cannot be asked about an initialized deposit', async () => {
    const created = await book();
    t.provider.unavailable = true;

    const res = await verifyDeposit(created.booking.id);
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe('PROVIDER_UNAVAILABLE');
  });

  it('just reports a booking that is past paying', async () => {
    const created = await book();
    await verifyDeposit(created.booking.id);

    const body = bookingResponseSchema.parse((await verifyDeposit(created.booking.id)).body);
    expect(body.booking.status).toBe('RESERVED');
  });
});
