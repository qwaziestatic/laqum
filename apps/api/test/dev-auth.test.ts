import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestContext, testConfig, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createUser } from './helpers/fixtures.js';

/**
 * THE SEEDED DEV TOKEN MUST FAIL CLOSED.
 *
 * Dev login mints a session for any seeded phone number with no credential at
 * all. It is enormously convenient and would be a catastrophe if it ever
 * shipped enabled, so the interesting tests here are the NEGATIVE ones: what
 * happens when the flag is absent, misspelled, or set in production.
 */

const BASE = {
  DATABASE_URL:
    process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test',
  REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379',
};

describe('DEV_AUTH_ENABLED is the only gate, and it is a conjunction', () => {
  it('is DISABLED when the variable is unset', () => {
    // The case that matters most: a deployment that has never heard of
    // DEV_AUTH must not get dev login.
    const config = loadConfig({ ...BASE, NODE_ENV: 'development' });
    expect(config.DEV_AUTH).toBe(false);
    expect(config.DEV_AUTH_ENABLED).toBe(false);
  });

  it('is DISABLED in production even when DEV_AUTH=true', () => {
    const config = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      DEV_AUTH: 'true',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    });

    // The raw variable is honestly reported as set...
    expect(config.DEV_AUTH).toBe(true);
    // ...and the derived gate still refuses.
    expect(config.DEV_AUTH_ENABLED).toBe(false);
  });

  it('is ENABLED only with an explicit true outside production', () => {
    expect(
      loadConfig({ ...BASE, NODE_ENV: 'development', DEV_AUTH: 'true' }).DEV_AUTH_ENABLED,
    ).toBe(true);
    expect(loadConfig({ ...BASE, NODE_ENV: 'test', DEV_AUTH: 'true' }).DEV_AUTH_ENABLED).toBe(true);
  });

  it('REFUSES TO START on a value that is not exactly true or false', () => {
    // '1', 'yes' and 'TRUE' are the plausible typos. None of them may be read
    // as "off" by accident — nor, worse, as "on".
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', '']) {
      expect(
        () => loadConfig({ ...BASE, NODE_ENV: 'development', DEV_AUTH: value }),
        value,
      ).toThrow(/DEV_AUTH/u);
    }
  });
});

describe('POST /v1/auth/dev-login', () => {
  let disabled: TestContext;
  let enabled: TestContext;

  beforeAll(async () => {
    await migrateFresh();
    disabled = await createTestContext();
    enabled = await createTestContext({ config: { DEV_AUTH: 'true' } });
  }, 60_000);

  afterAll(async () => {
    await disabled.close();
    await enabled.close();
  });

  beforeEach(async () => {
    await truncateAll(disabled.db.db);
  });

  it('does not EXIST when dev auth is off', async () => {
    await createUser(disabled.db.db, 'attendant', '+251911000001');

    const res = await request(disabled.app)
      .post('/v1/auth/dev-login')
      .send({ phone: '+251911000001' });

    // 404, not 403: the route is never registered, so there is no handler
    // whose guard clause could be got wrong. It is indistinguishable from any
    // other unknown path.
    expect(res.status).toBe(404);
  });

  it('answers the dashboard probe only when dev auth is on', async () => {
    // The dashboard offers dev sign-in only when GET answers 204. Off, the
    // probe 404s exactly like a path that was never there.
    const off = await request(disabled.app).get('/v1/auth/dev-login');
    expect(off.status).toBe(404);
    // The generic unknown-route answer, not a "disabled" reply.
    expect(off.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'No route for GET /v1/auth/dev-login' },
    });

    expect((await request(enabled.app).get('/v1/auth/dev-login')).status).toBe(204);
  });

  it('signs in a seeded user when dev auth is on', async () => {
    const userId = await createUser(enabled.db.db, 'attendant', '+251911000001');

    const res = await request(enabled.app)
      .post('/v1/auth/dev-login')
      .send({ phone: '+251911000001' });

    expect(res.status).toBe(200);
    const body = res.body as { accessToken: string; user: { id: string; role: string } };
    expect(body.user).toMatchObject({ id: userId, role: 'attendant' });
    expect(body.accessToken).toBeTruthy();
  });

  it('REFUSES an unknown number instead of creating an account', async () => {
    // The real OTP flow creates a driver on first sign-in. This one must not,
    // or it would be an open account-creation endpoint with no credential.
    const res = await request(enabled.app)
      .post('/v1/auth/dev-login')
      .send({ phone: '+251911999999' });

    expect(res.status).toBe(404);
    const created = await enabled.db.db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', '+251911999999')
      .executeTakeFirst();
    expect(created, 'dev login must never create a user').toBeUndefined();
  });

  it('takes the role from the DATABASE, not from the request', async () => {
    await createUser(enabled.db.db, 'driver', '+251911000002');

    const res = await request(enabled.app)
      .post('/v1/auth/dev-login')
      .send({ phone: '+251911000002', role: 'operator_admin' });

    expect(res.status).toBe(200);
    expect((res.body as { user: { role: string } }).user.role).toBe('driver');
  });

  it('still validates the phone number', async () => {
    const res = await request(enabled.app).post('/v1/auth/dev-login').send({ phone: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('the test suite itself runs with dev auth off', () => {
  it('confirms the default used by every other suite', () => {
    expect(testConfig().DEV_AUTH_ENABLED).toBe(false);
  });
});
