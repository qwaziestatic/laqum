import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestContext, testConfig, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';

/**
 * WHOSE ADDRESS IS req.ip?
 *
 * The API used `trust proxy: true`, which believes the whole X-Forwarded-For
 * header. Any client could send its own and pick its own address, so the
 * per-IP OTP limit was one header away from not existing. It now trusts
 * exactly TRUST_PROXY_HOPS proxies: the entries they appended, and nothing a
 * client wrote before them.
 *
 * Driven through the per-IP OTP limit, the thing a forged address attacks:
 * every request uses a fresh phone number, so only the IP limit can bite.
 */

const PER_IP = 3;

let t: TestContext;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext({ config: { OTP_RATE_LIMIT_PER_IP: String(PER_IP) } });
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  await t.redis.flushdb();
});

let phones = 0;
const freshPhone = (): string => `+2519${String(10_000_000 + (phones += 1))}`;

/** One OTP request, from whatever address the header claims. */
function ask(app: Parameters<typeof request>[0], forwardedFor?: string) {
  const req = request(app).post('/v1/auth/otp/request').send({ phone: freshPhone() });
  return forwardedFor === undefined ? req : req.set('X-Forwarded-For', forwardedFor);
}

function behind(hops: number) {
  return createApp({ ...t.ctx, config: { ...t.ctx.config, TRUST_PROXY_HOPS: hops } });
}

describe('with no proxy in front (development, the device test)', () => {
  it('ignores X-Forwarded-For: a client cannot pick a new address per request', async () => {
    const app = behind(0);
    for (let i = 0; i < PER_IP; i++) {
      expect((await ask(app, `198.51.100.${String(i)}`)).status).toBe(202);
    }
    // A new forged address every time, and still the same client.
    const res = await ask(app, '198.51.100.99');
    expect(res.status).toBe(429);
    expect((res.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('is the default outside production', () => {
    expect(testConfig().TRUST_PROXY_HOPS).toBe(0);
  });
});

describe('behind one proxy (Caddy)', () => {
  it('reads the address the proxy appended, and nothing the client wrote before it', async () => {
    const app = behind(1);
    for (let i = 0; i < PER_IP; i++) {
      // The client forges the first entry; Caddy appends the real one.
      expect((await ask(app, `6.6.6.${String(i)}, 203.0.113.9`)).status).toBe(202);
    }
    expect((await ask(app, '6.6.6.250, 203.0.113.9')).status).toBe(429);
  });

  it('still tells two real clients apart', async () => {
    const app = behind(1);
    for (let i = 0; i < PER_IP; i++) expect((await ask(app, '203.0.113.9')).status).toBe(202);
    expect((await ask(app, '203.0.113.9')).status).toBe(429);
    // A different client, through the same proxy, has its own allowance.
    expect((await ask(app, '203.0.113.10')).status).toBe(202);
  });
});

describe('the setting', () => {
  const production = {
    DATABASE_URL: 'postgres://x@localhost/x',
    REDIS_URL: 'redis://localhost',
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };

  it('is required in production: the operator must say what stands in front', () => {
    expect(() => loadConfig(production)).toThrow(/TRUST_PROXY_HOPS: is required/u);
    expect(loadConfig({ ...production, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
  });

  it('accepts a single digit and nothing else: never a quiet default', () => {
    for (const value of ['true', 'false', '', ' 1', '1.5', '-1', '10', 'yes']) {
      expect(() => testConfig({ TRUST_PROXY_HOPS: value }), JSON.stringify(value)).toThrow(
        /TRUST_PROXY_HOPS/u,
      );
    }
  });

  it('is what the app hands Express: a count, never `true`', () => {
    expect(t.app.get('trust proxy')).toBe(0);
    expect(behind(1).get('trust proxy')).toBe(1);
  });
});
