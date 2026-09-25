import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../dashboard/src/api/client.js';
import { listen } from '../src/listen.js';
import { clearRateLimits, createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, createUser } from './helpers/fixtures.js';

/**
 * THE DASHBOARD'S OWN CLIENT, against this API, over real HTTP.
 *
 * The same idea as mobile-contract.test.ts: the device pass found the app and
 * the API disagreeing while each passed its own tests, so each client is
 * driven against the real API. Starts with sign-in: the dashboard could only
 * sign in with dev-login, which production never has.
 */

let t: TestContext;
let server: Server;
let baseUrl: string;

async function serve(context: TestContext): Promise<{ server: Server; baseUrl: string }> {
  const s = createServer(context.app);
  const { port } = await listen(s, 0);
  return { server: s, baseUrl: `http://127.0.0.1:${String(port)}/v1` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve) => {
    s.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
  ({ server, baseUrl } = await serve(t));
}, 60_000);

afterAll(async () => {
  await close(server);
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  await clearRateLimits(t.redis);
  t.sms.reset();
});

const ATTENDANT = '+251911000201';
const UNKNOWN = '+251911000202';

function smsCode(phone: string): string {
  const code = /\b(\d{6})\b/u.exec(t.sms.lastMessageTo(phone) ?? '')?.[1];
  if (!code) throw new Error(`no code was sent to ${phone}`);
  return code;
}

describe("the dashboard's sign-in", () => {
  it('signs an attendant in by SMS code, and the session works on staff routes', async () => {
    const userId = await createUser(t.db.db, 'attendant', ATTENDANT);
    const lot = await createLot(t.db.db, { name: 'Staffed', slots: 2 });
    await t.db.db.insertInto('lot_staff').values({ lot_id: lot.lotId, user_id: userId }).execute();
    const client = new ApiClient({ baseUrl });

    const requested = await client.requestOtp(ATTENDANT);
    expect(requested.ok).toBe(true);

    const verified = await client.verifyOtp(ATTENDANT, smsCode(ATTENDANT));
    if (!verified.ok) throw new Error(verified.error.message);
    expect(verified.data.user.role).toBe('attendant');

    // The session the dashboard now holds is good for what it is for.
    client.setSession(verified.data);
    const lots = await client.staffedLots();
    if (!lots.ok) throw new Error(lots.error.message);
    expect(lots.data.lots.map((l) => l.id)).toEqual([lot.lotId]);
  });

  it('gives an unknown number the same "on its way" and no way in', async () => {
    const client = new ApiClient({ baseUrl });

    expect((await client.requestOtp(UNKNOWN)).ok).toBe(true);
    expect(t.sms.lastMessageTo(UNKNOWN)).toBeUndefined();

    const verified = await client.verifyOtp(UNKNOWN, '123456');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe('OTP_INVALID');
  });

  it('offers dev sign-in only where the API has it', async () => {
    expect(await new ApiClient({ baseUrl }).devLoginAvailable()).toBe(false);

    const enabled = await createTestContext({ config: { DEV_AUTH: 'true' } });
    const served = await serve(enabled);
    try {
      expect(await new ApiClient({ baseUrl: served.baseUrl }).devLoginAvailable()).toBe(true);
    } finally {
      await close(served.server);
      await enabled.close();
    }
  });
});
