import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateOtp, hashOtp, verifyOtp } from '../src/auth/otp.js';
import { hashRefreshToken } from '../src/auth/tokens.js';
import { clearRateLimits, createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';

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

const PHONE = '+251911234567';

/** The code is only ever visible through the SMS provider. */
function sentCode(phone = PHONE): string {
  const message = t.sms.lastMessageTo(phone);
  const match = /\b(\d{6})\b/u.exec(message ?? '');
  if (!match?.[1]) throw new Error(`no code found in: ${message ?? '(nothing sent)'}`);
  return match[1];
}

async function requestCode(phone = PHONE): Promise<void> {
  const res = await request(t.app).post('/v1/auth/otp/request').send({ phone });
  expect(res.status).toBe(202);
}

interface ErrorBody {
  error: { code: string; message: string };
}

/** supertest types res.body as any; read it through a shape instead. */
function errorCode(res: { body: unknown }): string {
  return (res.body as ErrorBody).error.code;
}

interface SessionBody {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  user: { id: string; phone: string; role: string };
}

async function signIn(phone = PHONE): Promise<SessionBody> {
  await requestCode(phone);
  const res = await request(t.app)
    .post('/v1/auth/otp/verify')
    .send({ phone, code: sentCode(phone) });
  expect(res.status).toBe(200);
  return res.body as SessionBody;
}

describe('OTP hashing', () => {
  it('produces a six-digit code', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/u);
    }
  });

  it('verifies the right code and rejects a wrong one', async () => {
    const hash = await hashOtp('123456');
    expect(hash).not.toContain('123456');
    expect(await verifyOtp('123456', hash)).toBe(true);
    expect(await verifyOtp('123457', hash)).toBe(false);
  });

  it('salts, so the same code hashes differently every time', async () => {
    expect(await hashOtp('000000')).not.toBe(await hashOtp('000000'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyOtp('123456', 'not-a-hash')).toBe(false);
    expect(await verifyOtp('123456', 'aabb:ccdd')).toBe(false);
  });
});

describe('POST /v1/auth/otp/request', () => {
  it('sends a code and stores only its hash', async () => {
    await requestCode();

    const rows = await t.db.db.selectFrom('otp_codes').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_hash).not.toContain(sentCode());
    expect(rows[0]?.expires_at.toISOString()).toBe('2026-03-01T08:05:00.000Z');
    expect(rows[0]?.created_at.toISOString()).toBe('2026-03-01T08:00:00.000Z');
  });

  it('rejects a phone number that is not E.164', async () => {
    for (const phone of ['0911234567', '251911234567', '+0911234567', 'nonsense']) {
      const res = await request(t.app).post('/v1/auth/otp/request').send({ phone });
      expect(res.status, phone).toBe(400);
      expect(errorCode(res)).toBe('VALIDATION_ERROR');
    }
  });

  it('rate limits per phone', async () => {
    for (let i = 0; i < 3; i++) await requestCode();

    const res = await request(t.app).post('/v1/auth/otp/request').send({ phone: PHONE });
    expect(res.status).toBe(429);
    expect(errorCode(res)).toBe('RATE_LIMITED');
  });

  it('lets the same phone through again once the window rolls over', async () => {
    for (let i = 0; i < 3; i++) await requestCode();
    expect((await request(t.app).post('/v1/auth/otp/request').send({ phone: PHONE })).status).toBe(
      429,
    );

    // No sleeping: the window index comes from the injected clock.
    t.clock.advanceMinutes(16);
    await requestCode();
  });

  it('rate limits per IP across different phones', async () => {
    // Ten per IP, three per phone, so use four distinct numbers.
    const phones = ['+251911000001', '+251911000002', '+251911000003', '+251911000004'];
    let allowed = 0;
    let limited = 0;

    for (const phone of phones) {
      for (let i = 0; i < 3; i++) {
        const res = await request(t.app).post('/v1/auth/otp/request').send({ phone });
        if (res.status === 202) allowed++;
        else if (res.status === 429) limited++;
      }
    }

    expect(allowed).toBe(10);
    expect(limited).toBe(2);
  });
});

describe('POST /v1/auth/otp/verify', () => {
  it('signs in, creating the account on first use', async () => {
    const session = await signIn();

    expect(session.user.phone).toBe(PHONE);
    expect(session.user.role).toBe('driver');
    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(session.accessExpiresAt).toBe('2026-03-01T08:15:00.000Z');

    const users = await t.db.db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(1);
  });

  it('reuses the existing account on later sign-ins', async () => {
    await signIn();
    t.clock.advanceMinutes(30);
    await signIn();

    expect(await t.db.db.selectFrom('users').selectAll().execute()).toHaveLength(1);
  });

  it('consumes the code, so it cannot be replayed', async () => {
    await requestCode();
    const code = sentCode();

    expect(
      (await request(t.app).post('/v1/auth/otp/verify').send({ phone: PHONE, code })).status,
    ).toBe(200);

    const replay = await request(t.app).post('/v1/auth/otp/verify').send({ phone: PHONE, code });
    expect(replay.status).toBe(400);
    expect(errorCode(replay)).toBe('OTP_INVALID');
  });

  it('expires the code after five minutes', async () => {
    await requestCode();
    const code = sentCode();

    t.clock.advanceMinutes(4);
    t.clock.advanceSeconds(59);
    // Still inside the window.
    const stored = await t.db.db.selectFrom('otp_codes').selectAll().executeTakeFirstOrThrow();
    expect(stored.expires_at.getTime()).toBeGreaterThan(t.clock.now().getTime());

    t.clock.advanceSeconds(2);
    const res = await request(t.app).post('/v1/auth/otp/verify').send({ phone: PHONE, code });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('OTP_EXPIRED');
  });

  it('locks out after five wrong attempts', async () => {
    await requestCode();
    const wrong = sentCode() === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const res = await request(t.app)
        .post('/v1/auth/otp/verify')
        .send({ phone: PHONE, code: wrong });
      expect(res.status, `attempt ${String(i + 1)}`).toBe(400);
      expect(errorCode(res)).toBe('OTP_INVALID');
    }

    // The sixth attempt is refused even with the CORRECT code.
    const res = await request(t.app)
      .post('/v1/auth/otp/verify')
      .send({ phone: PHONE, code: sentCode() });
    expect(res.status).toBe(429);
    expect(errorCode(res)).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('invalidates an older code when a newer one is requested', async () => {
    await requestCode();
    const first = sentCode();
    t.clock.advanceSeconds(30);
    await requestCode();
    const second = sentCode();
    expect(second).not.toBe(first);

    const stale = await request(t.app)
      .post('/v1/auth/otp/verify')
      .send({ phone: PHONE, code: first });
    expect(stale.status).toBe(400);

    const fresh = await request(t.app)
      .post('/v1/auth/otp/verify')
      .send({ phone: PHONE, code: second });
    expect(fresh.status).toBe(200);
  });

  it('refuses when no code was ever requested', async () => {
    const res = await request(t.app)
      .post('/v1/auth/otp/verify')
      .send({ phone: '+251911999999', code: '123456' });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('OTP_INVALID');
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates the token and revokes the old one', async () => {
    const first = await signIn();

    t.clock.advanceMinutes(10);
    const res = await request(t.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });

    expect(res.status).toBe(200);
    const second = res.body as SessionBody;
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // The old one is now unusable.
    const reuse = await request(t.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);

    // And the new one works.
    const again = await request(t.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: second.refreshToken });
    expect(again.status).toBe(200);
  });

  it('stores only a digest of the refresh token', async () => {
    const session = await signIn();
    const rows = await t.db.db.selectFrom('refresh_tokens').selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(session.refreshToken);
    expect(rows[0]?.token_hash).toBe(hashRefreshToken(t.ctx.config, session.refreshToken));
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses an expired refresh token', async () => {
    const session = await signIn();
    t.clock.advanceMinutes(31 * 24 * 60);

    const res = await request(t.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(401);
  });

  it('refuses a token that was never issued', async () => {
    const res = await request(t.app).post('/v1/auth/refresh').send({ refreshToken: 'made-up' });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the refresh token', async () => {
    const session = await signIn();

    expect(
      (await request(t.app).post('/v1/auth/logout').send({ refreshToken: session.refreshToken }))
        .status,
    ).toBe(204);

    const res = await request(t.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(401);
  });

  it('is a no-op for an unknown token, leaking nothing', async () => {
    const res = await request(t.app).post('/v1/auth/logout').send({ refreshToken: 'never-issued' });
    expect(res.status).toBe(204);
  });
});
