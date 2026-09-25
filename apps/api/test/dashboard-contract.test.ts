import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../dashboard/src/api/client.js';
import { clearRateLimits, createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { listenForFetch } from './helpers/listen.js';
import { createLot, createUser, seedBooking } from './helpers/fixtures.js';

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
  const port = await listenForFetch(s);
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

describe("the dashboard's staff actions, through its own client", () => {
  interface Raw {
    path: string;
    status: number;
    body: unknown;
  }

  /** The dashboard's client, with a log of what came back raw. */
  function recordingClient(): { client: ApiClient; raw: Raw[] } {
    const raw: Raw[] = [];
    const client = new ApiClient({
      baseUrl,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        raw.push({
          path: url.slice(baseUrl.length),
          status: response.status,
          body: await response
            .clone()
            .json()
            .catch(() => undefined),
        });
        return response;
      },
    });
    return { client, raw };
  }

  /** Succeeded, and the shared schema kept every field the API sent. */
  function fullyParsed<T>(
    result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
    raw: Raw[],
  ): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.data, 'a field the shared schema does not describe').toEqual(raw.at(-1)?.body);
    return result.data;
  }

  it('signs in, reads the lot, parks, checks out, takes cash, and toggles a slot', async () => {
    const userId = await createUser(t.db.db, 'attendant', ATTENDANT);
    const lot = await createLot(t.db.db, { name: 'Staffed', slots: 3, blockMinutes: 30 });
    await t.db.db.insertInto('lot_staff').values({ lot_id: lot.lotId, user_id: userId }).execute();
    const { client, raw } = recordingClient();

    fullyParsed(await client.requestOtp(ATTENDANT), raw);
    client.setSession(fullyParsed(await client.verifyOtp(ATTENDANT, smsCode(ATTENDANT)), raw));

    const lots = fullyParsed(await client.staffedLots(), raw);
    expect(lots.lots.map((l) => l.id)).toEqual([lot.lotId]);
    const snapshot = fullyParsed(await client.lotSlots(lot.lotId), raw);
    const [first, second] = snapshot.slots;
    if (!first || !second) throw new Error('the lot has slots');

    // A walk-in with the plate left out, as the drawer sends it when blank.
    const parked = fullyParsed(await client.parkWalkIn(lot.lotId, { slotId: first.slotId }), raw);
    expect(raw.at(-1)?.status).toBe(201);
    expect(parked.booking.status).toBe('CHECKED_IN');

    t.clock.advanceMinutes(45);
    const out = fullyParsed(await client.checkOut(parked.booking.id), raw);
    // The bill as computeBill makes it: the fields the dashboard once
    // guessed (blocks, overstayBlocks) were never sent.
    expect(out.bill.lines.length).toBeGreaterThan(0);
    expect(out.settled).toBe(false);

    const paid = fullyParsed(
      await client.recordCash(parked.booking.id, out.bill.amountDueSantim),
      raw,
    );
    expect(paid.booking.status).toBe('PAID');

    expect(fullyParsed(await client.setSlotService(second.slotId, false), raw)).toEqual({
      slotId: second.slotId,
      inService: false,
    });
    fullyParsed(await client.setSlotService(second.slotId, true), raw);
  });

  it('checks in an app booking by its short code', async () => {
    const attendantId = await createUser(t.db.db, 'attendant', ATTENDANT);
    const driverId = await createUser(t.db.db, 'driver', '+251911000203');
    const lot = await createLot(t.db.db, { name: 'Gate', slots: 1, depositSantim: 0 });
    await t.db.db
      .insertInto('lot_staff')
      .values({ lot_id: lot.lotId, user_id: attendantId })
      .execute();
    const booking = await seedBooking(t.db.db, {
      lotId: lot.lotId,
      slotId: lot.slotIds[0]!,
      userId: driverId,
      status: 'RESERVED',
      holdExpiresAt: new Date(t.clock.now().getTime() + 15 * 60_000),
    });
    const { shortCode } = await t.db.db
      .selectFrom('bookings')
      .select('short_code as shortCode')
      .where('id', '=', booking)
      .executeTakeFirstOrThrow();
    const { client, raw } = recordingClient();
    await client.requestOtp(ATTENDANT);
    client.setSession(fullyParsed(await client.verifyOtp(ATTENDANT, smsCode(ATTENDANT)), raw));

    const checkedIn = fullyParsed(await client.checkIn(shortCode ?? ''), raw);
    expect(checkedIn.booking.status).toBe('CHECKED_IN');
    // The attendant's view carries no entry credential.
    expect(checkedIn.booking).not.toHaveProperty('qrToken');
  });
});
