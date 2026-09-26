import type { FakeClock } from '@laqum/shared';
import { Redis } from 'ioredis';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { RateLimiter } from '../../src/auth/rateLimit.js';
import { RecordingSmsProvider } from '../../src/auth/sms.js';
import { FakePaymentProvider, type FakePaymentOptions } from '../../src/payments/fake.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { RecordingEmitter } from '../../src/realtime/emitter.js';
import { RecordingScheduler, connect, testClock, testLogger, type TestDb } from './db.js';

export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379';

export interface TestContext {
  ctx: AppContext;
  app: Express;
  db: TestDb;
  clock: FakeClock;
  sms: RecordingSmsProvider;
  scheduler: RecordingScheduler;
  provider: FakePaymentProvider;
  emitter: RecordingEmitter;
  redis: Redis;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL:
      process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test',
    REDIS_URL: TEST_REDIS_URL,
    ...overrides,
  });
}

/**
 * A full application wired to the real test Postgres and Redis, with time and
 * outbound side effects under the test's control.
 */
export async function createTestContext(
  options: {
    poolSize?: number;
    config?: Record<string, string>;
    fakeProvider?: Omit<FakePaymentOptions, 'clock'>;
  } = {},
): Promise<TestContext> {
  const db = connect(options.poolSize ?? 10);
  const clock = testClock();
  const logger = testLogger();
  const config = testConfig(options.config ?? {});
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();

  const sms = new RecordingSmsProvider();
  const scheduler = new RecordingScheduler();
  const provider = new FakePaymentProvider({ clock, ...options.fakeProvider });
  const emitter = new RecordingEmitter();

  const ctx: AppContext = {
    db: db.db,
    redis,
    clock,
    config,
    logger,
    scheduler,
    sms,
    rateLimiter: new RateLimiter({ redis, clock }),
    provider,
    emitter,
  };

  return {
    ctx,
    app: createApp(ctx),
    db,
    clock,
    sms,
    scheduler,
    provider,
    emitter,
    redis,
    close: async () => {
      await db.close();
      redis.disconnect();
    },
  };
}

/**
 * A context around an existing db/redis pair, for tests that supply their own
 * connections (the health probes point at ports nothing listens on).
 */
export function contextFor(db: TestDb['db'], redis: Redis, clock = testClock()): AppContext {
  return {
    db,
    redis,
    clock,
    config: testConfig(),
    logger: testLogger(),
    scheduler: new RecordingScheduler(),
    sms: new RecordingSmsProvider(),
    rateLimiter: new RateLimiter({ redis, clock }),
    provider: new FakePaymentProvider({ clock }),
    emitter: new RecordingEmitter(),
  };
}

/** Redis is shared between test files; clear the rate-limit keyspace. */
export async function clearRateLimits(redis: Redis): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}
