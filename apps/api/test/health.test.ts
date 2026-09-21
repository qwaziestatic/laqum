import { createPool, createUntypedDb } from '@laqum/db';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRedis } from '../src/redis.js';
import { loadConfig } from '../src/config.js';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379';

// Ports nothing listens on, so "down" is a real connection failure rather
// than a mock. The brief forbids mocking the database; the same reasoning
// applies to proving a probe reports a failure.
const DEAD_DATABASE_URL = 'postgres://laqum:laqum@localhost:55431/laqum_test';
const DEAD_REDIS_URL = 'redis://localhost:56378';

function config(overrides: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL,
    REDIS_URL,
    ...overrides,
  });
}

describe('GET /health (liveness)', () => {
  let db: Kysely<unknown>;
  let redis: Redis;
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: DEAD_DATABASE_URL });
    db = createUntypedDb(pool);
    redis = createRedis(config({ REDIS_URL: DEAD_REDIS_URL }));
  });

  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  it('is 200 even when every dependency is unreachable', async () => {
    // Liveness must not depend on Postgres or Redis, or an orchestrator will
    // restart a process that is working fine.
    const res = await request(createApp({ db, redis })).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /ready (readiness)', () => {
  let db: Kysely<unknown>;
  let redis: Redis;

  beforeAll(async () => {
    db = createUntypedDb(createPool({ connectionString: DATABASE_URL }));
    redis = createRedis(config());
    await redis.connect();
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  it('is 200 with both dependencies up', async () => {
    const res = await request(createApp({ db, redis })).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.postgres.status).toBe('up');
    expect(res.body.checks.redis.status).toBe('up');
    expect(res.body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /ready with a dependency down', () => {
  it('is 503 and names Postgres when Postgres is unreachable', async () => {
    const db = createUntypedDb(createPool({ connectionString: DEAD_DATABASE_URL }));
    const redis = createRedis(config());
    await redis.connect();

    try {
      const res = await request(createApp({ db, redis })).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.postgres.status).toBe('down');
      expect(res.body.checks.postgres.error).toBeTruthy();
      // Redis is fine, so the report must not blame it.
      expect(res.body.checks.redis.status).toBe('up');
    } finally {
      await db.destroy();
      redis.disconnect();
    }
  }, 30_000);

  it('is 503 and names Redis when Redis is unreachable', async () => {
    const db = createUntypedDb(createPool({ connectionString: DATABASE_URL }));
    const redis = createRedis(config({ REDIS_URL: DEAD_REDIS_URL }));
    redis.connect().catch(() => {
      // Expected: nothing is listening. /ready is what reports it.
    });

    try {
      const res = await request(createApp({ db, redis })).get('/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.redis.status).toBe('down');
      expect(res.body.checks.postgres.status).toBe('up');
    } finally {
      await db.destroy();
      redis.disconnect();
    }
  }, 30_000);
});
