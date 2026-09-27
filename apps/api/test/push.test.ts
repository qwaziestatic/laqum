import { addMinutes } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expireHold,
  JOB_HANDLERS,
  markOverstay,
  pushReceipts,
  type JobDeps,
} from '../src/jobs/handlers.js';
import {
  HOLD_WARNING_MINUTES,
  notificationJobs,
  RECEIPT_CHECK_MINUTES,
} from '../src/push/notify.js';
import { DEVICE_NOT_REGISTERED } from '../src/push/provider.js';
import { pushText } from '../src/push/texts.js';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, jobDeps, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, seedBooking, type LotFixture } from './helpers/fixtures.js';

/**
 * Push notifications: the token and its language, when each notification is
 * queued, and that a job sends only what is still true.
 */

let t: TestContext;
let driver: Actor;
let lot: LotFixture;
let deps: JobDeps;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
  deps = jobDeps(t);
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.clock.set('2026-03-01T11:00:00.000Z');
  t.scheduler.reset();
  t.emitter.reset();
  t.push.reset();
  driver = await makeActor(t, 'driver');
  lot = await createLot(t.db.db, { name: 'Bole Lot', slots: 2, holdMinutes: 15 });
});

const TOKEN = 'ExponentPushToken[abcdEFGH1234_-]';
const OTHER = 'ExponentPushToken[secondPhone]';

function register(actor: Actor, token: string, locale: string) {
  return request(t.app)
    .post('/v1/push/tokens')
    .set(actor.header)
    .send({ expoPushToken: token, locale });
}

async function tokens(): Promise<{ expo_push_token: string; user_id: string; locale: string }[]> {
  return t.db.db
    .selectFrom('push_tokens')
    .select(['expo_push_token', 'user_id', 'locale'])
    .orderBy('expo_push_token')
    .execute();
}

describe('POST /v1/push/tokens', () => {
  it('stores the token with the language it registered in', async () => {
    const res = await register(driver, TOKEN, 'en');
    expect(res.status).toBe(204);
    expect(await tokens()).toEqual([
      { expo_push_token: TOKEN, user_id: driver.userId, locale: 'en' },
    ]);
  });

  it('a registration in another language changes it (D3), leaving ONE row', async () => {
    // The app re-registers on sign-in and on every language switch.
    await register(driver, TOKEN, 'en');
    await register(driver, TOKEN, 'am');
    await register(driver, TOKEN, 'am');
    expect(await tokens()).toEqual([
      { expo_push_token: TOKEN, user_id: driver.userId, locale: 'am' },
    ]);
  });

  it('RE-POINTS a token that moves to another user', async () => {
    /*
     * A phone is shared, resold, or a driver signs into a second account. The
     * token is unique, so the naive insert would 409, and the PREVIOUS owner
     * would keep receiving this driver's booking notifications. That is a
     * privacy leak, so the row moves.
     */
    await register(driver, TOKEN, 'am');
    const second = await makeActor(t, 'driver');
    expect((await register(second, TOKEN, 'en')).status).toBe(204);

    const rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id, 'the token follows the phone, not the account').toBe(second.userId);
  });

  it('rejects a malformed token, and a language the texts do not exist in', async () => {
    for (const bad of ['', 'not-a-token', 'ExponentPushToken[]', '<script>']) {
      expect((await register(driver, bad, 'am')).status, bad).toBe(400);
    }
    for (const locale of ['fr', '', 'AM']) {
      expect((await register(driver, TOKEN, locale)).status, locale).toBe(400);
    }
    const missing = await request(t.app)
      .post('/v1/push/tokens')
      .set(driver.header)
      .send({ expoPushToken: TOKEN });
    expect(missing.status).toBe(400);
  });

  it('accepts both Expo token spellings', async () => {
    for (const token of ['ExponentPushToken[aaaa]', 'ExpoPushToken[bbbb]']) {
      expect((await register(driver, token, 'am')).status, token).toBe(204);
    }
  });

  it('requires authentication', async () => {
    const res = await request(t.app)
      .post('/v1/push/tokens')
      .send({ expoPushToken: TOKEN, locale: 'am' });
    expect(res.status).toBe(401);
  });
});

describe('which notifications a status change queues', () => {
  const at = new Date('2026-03-01T11:00:00.000Z');
  const base = { bookingId: 'b', userId: 'u', at, holdExpiresAt: null };

  it.each([
    ['RESERVED', 'EXPIRED', 'notify-hold-expired'],
    ['CHECKED_IN', 'OVERSTAY', 'notify-overstay'],
    ['CHECKED_IN', 'CHECKED_OUT', 'notify-amount-due'],
    ['OVERSTAY', 'CHECKED_OUT', 'notify-amount-due'],
  ] as const)('%s -> %s queues %s, at once', (from, to, queue) => {
    expect(notificationJobs({ ...base, from, to })).toEqual([{ queue, bookingId: 'b', runAt: at }]);
  });

  it.each([
    ['PENDING_PAYMENT', 'EXPIRED'],
    ['RESERVED', 'CHECKED_IN'],
    ['RESERVED', 'CANCELLED'],
    ['CHECKED_OUT', 'PAID'],
  ] as const)('%s -> %s queues nothing', (from, to) => {
    expect(notificationJobs({ ...base, from, to })).toEqual([]);
  });

  it('a hold is warned HOLD_WARNING_MINUTES before it ends, unless it is shorter', () => {
    const holdExpiresAt = addMinutes(at, 15);
    expect(notificationJobs({ ...base, from: null, to: 'RESERVED', holdExpiresAt })).toEqual([
      { queue: 'hold-reminder', bookingId: 'b', runAt: addMinutes(at, 15 - HOLD_WARNING_MINUTES) },
    ]);
    // "5 minutes left" the moment a 3-minute hold starts would be false.
    const short = addMinutes(at, 3);
    expect(notificationJobs({ ...base, from: null, to: 'RESERVED', holdExpiresAt: short })).toEqual(
      [],
    );
  });

  it('nothing for a walk-in (no app) or a slot taken out of service (no booking)', () => {
    expect(
      notificationJobs({ ...base, userId: null, from: 'CHECKED_IN', to: 'CHECKED_OUT' }),
    ).toEqual([]);
    expect(notificationJobs({ ...base, bookingId: null, from: null, to: null })).toEqual([]);
  });

  it('a booking from the app queues its warning AND reaches the dashboards', async () => {
    const res = await request(t.app).post('/v1/bookings').set(driver.header).send({
      lotId: lot.lotId,
      plannedMinutes: 60,
      lat: lot.latitude,
      lng: lot.longitude,
    });
    expect(res.status).toBe(201);
    const id = (res.body as { booking: { id: string } }).booking.id;

    expect(t.scheduler.forQueue('hold-reminder')).toMatchObject([
      { bookingId: id, runAt: addMinutes(t.clock.now(), 15 - HOLD_WARNING_MINUTES) },
    ]);
    // Regression: this route passed no emitter, so an app booking reached no
    // dashboard until its next resync.
    expect(t.emitter.slotEvents.map((e) => e.lotId)).toEqual([lot.lotId]);
  });

  it("the jobs' own transitions emit and queue their notices", async () => {
    // Regression: the workers ran without an emitter, so expiries and
    // overstays reached no dashboard.
    const held = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 15),
    });
    const parked = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: (await makeActor(t, 'driver')).userId,
      status: 'CHECKED_IN',
      plannedEndAt: addMinutes(t.clock.now(), 10),
    });
    t.clock.advanceMinutes(16);

    expect((await expireHold(deps, held)).applied).toBe(true);
    expect((await markOverstay(deps, parked)).applied).toBe(true);

    expect(t.emitter.slotEvents).toHaveLength(2);
    expect(t.scheduler.forQueue('notify-hold-expired').map((j) => j.bookingId)).toEqual([held]);
    expect(t.scheduler.forQueue('notify-overstay').map((j) => j.bookingId)).toEqual([parked]);
  });
});

describe('sending', () => {
  async function held(): Promise<string> {
    return seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'RESERVED',
      holdExpiresAt: addMinutes(t.clock.now(), 5),
    });
  }

  it("writes to each of the driver's devices in that device's language", async () => {
    await register(driver, TOKEN, 'am');
    await register(driver, OTHER, 'en');
    const id = await held();

    expect(await JOB_HANDLERS['hold-reminder'](deps, id)).toMatchObject({ applied: true });

    const holdEnds = addMinutes(t.clock.now(), 5);
    const values = { lot: 'Bole Lot', time: holdEnds, minutes: 5 };
    expect(t.push.sent).toEqual(
      expect.arrayContaining([
        {
          to: TOKEN,
          ...pushText('hold-reminder', 'am', values),
          data: { bookingId: id, kind: 'hold-reminder' },
        },
        {
          to: OTHER,
          ...pushText('hold-reminder', 'en', values),
          data: { bookingId: id, kind: 'hold-reminder' },
        },
      ]),
    );
    expect(t.push.sent).toHaveLength(2);
  });

  it('sends nothing that identifies the driver: no phone number, no plate', async () => {
    // The text crosses the border through Expo and Google (Proclamation
    // 1321/2024, Art. 20): a sentence, the lot, a time or amount, and an id.
    await register(driver, TOKEN, 'en');
    const id = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_OUT',
    });
    await t.db.db
      .updateTable('bookings')
      .set({ vehicle_plate: 'AA-3-B12345', amount_due_santim: 4500 })
      .where('id', '=', id)
      .execute();
    const user = await t.db.db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', driver.userId)
      .executeTakeFirstOrThrow();

    await JOB_HANDLERS['notify-amount-due'](deps, id);

    const [message] = t.push.sent;
    expect(message?.title).toContain('45.00');
    expect(Object.keys(message?.data ?? {}).sort()).toEqual(['bookingId', 'kind']);
    const wire = JSON.stringify(message);
    expect(wire).not.toContain('AA-3-B12345');
    expect(wire).not.toContain(user.phone);
    expect(wire).not.toContain(user.phone.slice(-9));
  });

  it('sends NOTHING once it is no longer true', async () => {
    await register(driver, TOKEN, 'am');

    // Checked in before the warning fired.
    const checkedIn = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driver.userId,
      status: 'CHECKED_IN',
      plannedEndAt: addMinutes(t.clock.now(), 60),
    });
    expect(await JOB_HANDLERS['hold-reminder'](deps, checkedIn)).toMatchObject({
      applied: false,
      reason: 'NO_LONGER_TRUE',
    });
    // Its planned end has passed: "ends in N minutes" would be false.
    t.clock.advanceMinutes(61);
    expect(await JOB_HANDLERS['time-reminder'](deps, checkedIn)).toMatchObject({
      reason: 'NO_LONGER_TRUE',
    });

    // Checked out with nothing to pay.
    const settled = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[1]!,
      userId: driver.userId,
      status: 'CHECKED_OUT',
    });
    await t.db.db
      .updateTable('bookings')
      .set({ amount_due_santim: 0 })
      .where('id', '=', settled)
      .execute();
    expect(await JOB_HANDLERS['notify-amount-due'](deps, settled)).toMatchObject({
      reason: 'NO_LONGER_TRUE',
    });

    expect(t.push.sent).toEqual([]);
  });

  it('a driver with no device registered is not an error', async () => {
    const id = await held();
    expect(await JOB_HANDLERS['hold-reminder'](deps, id)).toMatchObject({
      applied: false,
      reason: 'NO_DEVICE',
    });
  });

  it('forgets a device Expo reports gone at once, and keeps the others', async () => {
    await register(driver, TOKEN, 'am');
    await register(driver, OTHER, 'am');
    t.push.unregistered.add(TOKEN);

    await JOB_HANDLERS['hold-reminder'](deps, await held());

    expect((await tokens()).map((r) => r.expo_push_token)).toEqual([OTHER]);
  });

  it('checks receipts later, and forgets a device FCM has since refused', async () => {
    await register(driver, TOKEN, 'am');
    await register(driver, OTHER, 'am');
    const id = await held();

    await JOB_HANDLERS['hold-reminder'](deps, id);
    expect(t.scheduler.forQueue('push-receipts')).toMatchObject([
      { bookingId: id, runAt: addMinutes(t.clock.now(), RECEIPT_CHECK_MINUTES) },
    ]);

    // Tickets are issued in message order; the first went to TOKEN.
    const [first] = await t.redis.lrange(`push:receipts:${id}`, 0, 0);
    const ticket = JSON.parse(first ?? '{}') as { id: string; token: string };
    expect(ticket.token).toBe(t.push.sent[0]?.to);
    t.push.scriptedReceipts.set(ticket.id, {
      status: 'error',
      message: 'gone',
      error: DEVICE_NOT_REGISTERED,
    });

    await pushReceipts(deps, id);

    expect((await tokens()).map((r) => r.expo_push_token)).toEqual(
      [TOKEN, OTHER].filter((token) => token !== ticket.token),
    );
    expect(await t.redis.exists(`push:receipts:${id}`)).toBe(0);
  });
});
