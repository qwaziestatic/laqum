import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConsoleSmsProvider } from '../src/auth/sms.js';
import { runJob } from '../src/jobs/bullmq.js';
import { withLogContext } from '../src/logContext.js';
import { createLogger, maskPhone } from '../src/logger.js';
import { createTestContext, testConfig, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';

/**
 * STRUCTURED LOGS (Phase 5): one id per request, on the response and on
 * every line written while handling it, and on the jobs it scheduled; an
 * access line with no header, body or query string in it; credentials
 * redacted and phone numbers masked wherever a log call puts them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEEDED = '+251911000777';

let t: TestContext;
let lines: Record<string, unknown>[];

/** A logger whose JSON lines land in `lines`. */
function capturingLogger() {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const text of chunk.toString('utf8').split('\n')) {
        if (text.trim()) lines.push(JSON.parse(text) as Record<string, unknown>);
      }
      done();
    },
  });
  return createLogger(testConfig({ LOG_LEVEL: 'debug' }), sink);
}

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext({ config: { DEV_AUTH: 'true' } });
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  lines = [];
  app = createApp({ ...t.ctx, logger: capturingLogger() });
  await t.db.db
    .insertInto('users')
    .values({ phone: SEEDED, role: 'driver', full_name: 'Test', created_at: t.clock.now() })
    .execute();
});

/** pino-http's line per request: 'request completed', or 'request errored' for a 5xx. */
const accessLines = () =>
  lines.filter((line) => line['msg'] === 'request completed' || line['msg'] === 'request errored');

describe('the request id', () => {
  it('is made up when the caller sends none, and echoed', async () => {
    const res = await request(app).get('/v1/lots/nearby');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it("is the caller's own when it is a short, safe token", async () => {
    const res = await request(app).get('/v1/lots/nearby').set('X-Request-Id', 'phone-7.a_b');
    expect(res.headers['x-request-id']).toBe('phone-7.a_b');
  });

  it('is replaced when the caller sends anything else', async () => {
    for (const unsafe of ['a b', '<script>', 'x'.repeat(65), 'semi;colon', '../etc']) {
      const res = await request(app).get('/v1/lots/nearby').set('X-Request-Id', unsafe);
      expect(res.headers['x-request-id'], unsafe).toMatch(UUID);
    }
  });

  it("is on the handler's own log lines, not only the access line", async () => {
    const res = await request(app).post('/v1/auth/dev-login').send({ phone: SEEDED });
    expect(res.status).toBe(200);
    const devLogin = lines.find((line) => line['msg'] === 'DEV LOGIN: signed in without an OTP');
    expect(devLogin?.['reqId']).toBe(res.headers['x-request-id']);
  });

  it('is on the webhook too, which runs before any other middleware', async () => {
    const res = await request(app)
      .post('/v1/webhooks/chapa')
      .set('content-type', 'application/json')
      .send('{}');
    const line = accessLines().find(
      (l) => (l['req'] as { path: string }).path === '/v1/webhooks/chapa',
    );
    expect(line?.['reqId']).toBe(res.headers['x-request-id']);
  });
});

describe('the access line', () => {
  it('holds method, path, address, status and time: no headers, no body, no query', async () => {
    const res = await request(app)
      .get('/v1/lots/nearby?lat=9.0&lng=38.7&radius_m=500')
      .set('Authorization', 'Bearer not-a-real-token');
    const [line] = accessLines();
    expect(line).toBeDefined();
    expect(line?.['reqId']).toBe(res.headers['x-request-id']);
    const req = line?.['req'] as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['ip', 'method', 'path']);
    expect(req['method']).toBe('GET');
    expect(req['path']).toBe('/v1/lots/nearby');
    expect(typeof req['ip']).toBe('string');
    expect(line?.['res']).toEqual({ status: res.status });
    expect(line?.['responseTime']).toEqual(expect.any(Number));
    const text = JSON.stringify(line);
    expect(text).not.toContain('radius_m');
    expect(text).not.toContain('not-a-real-token');
  });

  it('leaves the probes out: they would be most of the log', async () => {
    await request(app).get('/health');
    await request(app).get('/ready');
    expect(accessLines()).toEqual([]);
  });

  it('logs a server error at error level', async () => {
    const broken = createApp({
      ...t.ctx,
      logger: capturingLogger(),
      db: new Proxy(t.ctx.db, {
        get() {
          throw new Error('database gone');
        },
      }),
    });
    await request(broken).get('/v1/lots/nearby?lat=9&lng=38.7').set('Authorization', 'Bearer x');
    await request(broken).post('/v1/auth/dev-login').send({ phone: SEEDED });
    const errorLine = accessLines().find(
      (line) => (line['res'] as { status: number }).status === 500,
    );
    expect(errorLine?.['level']).toBe(50);
  });
});

describe('credentials and phone numbers', () => {
  it('redacts tokens, credential headers and signatures, however they are logged', () => {
    const logger = capturingLogger();
    logger.info(
      {
        accessToken: 'a',
        refreshToken: 'r',
        expoPushToken: 'ExponentPushToken[x]',
        token: 't',
        authorization: 'Bearer x',
        headers: {
          authorization: 'Bearer y',
          cookie: 'c',
          'x-chapa-signature': 's',
          'chapa-signature': 's2',
        },
        body: { refreshToken: 'r2', accessToken: 'a2' },
      },
      'careless',
    );
    const text = JSON.stringify(lines.at(-1));
    for (const secret of [
      '"a"',
      '"r"',
      'ExponentPushToken',
      '"t"',
      'Bearer',
      '"c"',
      '"s"',
      '"s2"',
      '"r2"',
      '"a2"',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
  });

  it('masks a phone number to its country code and last three digits', () => {
    expect(maskPhone('+251911234567')).toBe('+251******567');
    expect(maskPhone('not a phone')).toBe('not a phone');
    expect(maskPhone(42)).toBe(42);
    const logger = capturingLogger();
    logger.warn({ phone: '+251911234567' }, 'x');
    expect(lines.at(-1)?.['phone']).toBe('+251******567');
  });

  it("masks the console SMS provider's recipient but keeps its message, the only delivery there is", async () => {
    await new ConsoleSmsProvider(capturingLogger()).send('+251911234567', 'Your code is 123456');
    expect(lines.at(-1)).toMatchObject({ to: '+251******567', message: 'Your code is 123456' });
  });
});

describe('jobs', () => {
  it("carry the scheduling request's id and their own onto every line", async () => {
    const logger = capturingLogger();
    await runJob({ db: t.db.db, clock: t.clock, logger, payments: t.ctx }, 'expire-hold', {
      id: 'expire-hold.x',
      data: { bookingId: '00000000-0000-4000-8000-000000000000', reqId: 'req-abc' },
    });
    const finished = lines.find((line) => line['msg'] === 'job finished');
    expect(finished).toMatchObject({ reqId: 'req-abc', jobId: 'expire-hold.x' });
  });

  it('outside a request, a line has no request id at all', () => {
    const logger = capturingLogger();
    logger.info('startup');
    expect(lines.at(-1)?.['reqId']).toBeUndefined();
    withLogContext({ reqId: 'r1' }, () => {
      logger.info('inside');
    });
    expect(lines.at(-1)?.['reqId']).toBe('r1');
  });
});
