import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearRateLimits, createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/fixtures.js';

/**
 * The dashboard's sign-in: the OTP endpoints with `audience: 'staff'`.
 *
 * The dashboard could only sign in through dev-login, which production never
 * has, so attendants could not sign in at all. The product owner's rule for
 * the real flow: for a number that is unknown or not staff, no SMS, no
 * account, and NO DIFFERENCE IN RESPONSE — the sign-in must not tell anyone
 * which numbers are staff.
 */

let t: TestContext;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  await clearRateLimits(t.redis);
  t.sms.reset();
  t.clock.set('2026-03-01T08:00:00.000Z');
});

const ATTENDANT = '+251911000101';
const ADMIN = '+251911000102';
const DRIVER = '+251911000103';
const UNKNOWN = '+251911000104';

function requestCode(phone: string, audience?: 'staff' | 'driver') {
  return request(t.app)
    .post('/v1/auth/otp/request')
    .send({ phone, ...(audience ? { audience } : {}) });
}

function verify(phone: string, code: string, audience?: 'staff' | 'driver') {
  return request(t.app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code, ...(audience ? { audience } : {}) });
}

function sentCode(phone: string): string | undefined {
  return /\b(\d{6})\b/u.exec(t.sms.lastMessageTo(phone) ?? '')?.[1];
}

async function codeRows(phone: string): Promise<number> {
  const rows = await t.db.db
    .selectFrom('otp_codes')
    .select('id')
    .where('phone', '=', phone)
    .execute();
  return rows.length;
}

async function userCount(): Promise<number> {
  return (await t.db.db.selectFrom('users').select('id').execute()).length;
}

describe('staff sign-in', () => {
  it('signs an attendant in with a code sent by SMS', async () => {
    await createUser(t.db.db, 'attendant', ATTENDANT);

    expect((await requestCode(ATTENDANT, 'staff')).status).toBe(202);
    const code = sentCode(ATTENDANT);
    expect(code).toBeDefined();

    const res = await verify(ATTENDANT, code ?? '', 'staff');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { phone: ATTENDANT, role: 'attendant' } });
  });

  it('signs an operator admin in too', async () => {
    await createUser(t.db.db, 'operator_admin', ADMIN);

    await requestCode(ADMIN, 'staff');
    const res = await verify(ADMIN, sentCode(ADMIN) ?? '', 'staff');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { role: 'operator_admin' } });
  });
});

describe('a number that is not staff', () => {
  it('gets the same answer to a code request as a staff number, and no SMS or code', async () => {
    await createUser(t.db.db, 'attendant', ATTENDANT);
    await createUser(t.db.db, 'driver', DRIVER);

    const staff = await requestCode(ATTENDANT, 'staff');
    const driver = await requestCode(DRIVER, 'staff');
    const unknown = await requestCode(UNKNOWN, 'staff');

    for (const res of [driver, unknown]) {
      expect(res.status).toBe(staff.status);
      expect(res.body).toEqual(staff.body);
    }
    expect(t.sms.lastMessageTo(DRIVER)).toBeUndefined();
    expect(t.sms.lastMessageTo(UNKNOWN)).toBeUndefined();
    expect(await codeRows(DRIVER)).toBe(0);
    expect(await codeRows(UNKNOWN)).toBe(0);
  });

  it('never gets an account', async () => {
    const before = await userCount();

    await requestCode(UNKNOWN, 'staff');
    await verify(UNKNOWN, '123456', 'staff');

    expect(await userCount()).toBe(before);
  });

  it('cannot sign in to the dashboard even with its own valid app code, which stays usable', async () => {
    await createUser(t.db.db, 'driver', DRIVER);
    await requestCode(DRIVER); // the app's request: a real code, by SMS
    const code = sentCode(DRIVER) ?? '';

    const dashboard = await verify(DRIVER, code, 'staff');
    expect(dashboard.status).not.toBe(200);

    // Not consumed, no attempt burned: the driver can still sign in to the app.
    const app = await verify(DRIVER, code);
    expect(app.status).toBe(200);
    expect(app.body).toMatchObject({ user: { role: 'driver' } });
  });
});

describe('every staff-mode failure is the same answer', () => {
  it('for unknown, driver, and staff numbers, whatever went wrong', async () => {
    await createUser(t.db.db, 'attendant', ATTENDANT);
    await createUser(t.db.db, 'driver', DRIVER);

    const failures = [];

    // Unknown and driver numbers, after asking for a code.
    await requestCode(UNKNOWN, 'staff');
    failures.push(await verify(UNKNOWN, '123456', 'staff'));
    await requestCode(DRIVER, 'staff');
    failures.push(await verify(DRIVER, '123456', 'staff'));

    // A staff number that asked for no code at all.
    failures.push(await verify(ATTENDANT, '123456', 'staff'));

    // A staff number with a wrong code (a real code was sent).
    await requestCode(ATTENDANT, 'staff');
    const real = sentCode(ATTENDANT) ?? '';
    const wrong = real === '000000' ? '000001' : '000000';
    failures.push(await verify(ATTENDANT, wrong, 'staff'));

    // The same staff number once that code has expired.
    t.clock.advanceMinutes(10);
    failures.push(await verify(ATTENDANT, real, 'staff'));

    const [first, ...rest] = failures;
    expect(first?.status).toBeGreaterThanOrEqual(400);
    for (const res of rest) {
      expect(res.status).toBe(first?.status);
      expect(res.body).toEqual(first?.body);
    }
    // No hint either way: no attempts count, no "expired", no "not requested".
    expect(first?.body).toEqual({
      error: {
        code: 'OTP_INVALID',
        message: 'That code is not correct or has expired. Request a new one.',
      },
    });
  });

  it('while the app audience keeps its detailed answers', async () => {
    // Drivers are told what went wrong; only the dashboard hides it.
    await requestCode(DRIVER);
    const res = await verify(DRIVER, '000000' === sentCode(DRIVER) ? '000001' : '000000');

    expect(res.body).toMatchObject({
      error: { code: 'OTP_INVALID', details: { attemptsRemaining: expect.any(Number) as number } },
    });
  });
});

describe('rate limits', () => {
  it('apply to staff-mode requests for any number alike', async () => {
    await createUser(t.db.db, 'attendant', ATTENDANT);
    const statuses = async (phone: string): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < 4; i += 1) out.push((await requestCode(phone, 'staff')).status);
      return out;
    };

    const staff = await statuses(ATTENDANT);
    await clearRateLimits(t.redis);
    const unknown = await statuses(UNKNOWN);

    expect(unknown).toEqual(staff);
    expect(staff.at(-1)).toBe(429);
  });
});
