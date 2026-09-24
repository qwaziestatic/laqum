import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billableLotFromSummary, computeBill } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient, type TokenStore } from '../src/api/client.js';
import { Api } from '../src/api/endpoints.js';

/**
 * The client's lot parsing, and the Book screen's pricing, on a REAL response.
 *
 * On the device the Book screen crashed with "blockMinutes must be a positive
 * safe integer, received undefined": it cast the API's camelCase lot to
 * computeBill's snake_case BillableLot. The client now parses lot responses
 * with the shared schemas that type the API's own service, and
 * apps/api/test/lots.test.ts checks the API's live responses against them.
 */

/**
 * GET /v1/lots/:id for TEST LOT, as the running dev API returned it on the
 * device test (2026-09-24). Captured, not written: only the id is as-is.
 */
const REAL_LOT_RESPONSE = {
  id: 'c0911390-4d9f-446d-a29f-3cdd5f6caa5a',
  name: 'TEST LOT (device testing)',
  address: 'Created from SEED_TEST_LOT_LAT/LNG for device testing',
  latitude: 9.040093,
  longitude: 38.762541,
  contactPhone: '+251911000000',
  blockMinutes: 5,
  ratePerBlockSantim: 500,
  overstayRatePerBlockSantim: 1000,
  depositAmountSantim: 0,
  holdMinutes: 3,
  paymentWindowMinutes: 3,
  maxBookingDistanceM: 150,
  freeSlots: 6,
  totalAppBookableSlots: 6,
};

/** GET /v1/lots/nearby, same lot, same capture. */
const REAL_NEARBY_RESPONSE = {
  lots: [{ ...REAL_LOT_RESPONSE, distanceM: 0, withinBookingRange: true }],
};

const noTokens: TokenStore = {
  read: () => Promise.resolve(null),
  write: () => Promise.resolve(),
};

function apiReturning(body: unknown): Api {
  const client = new ApiClient({
    baseUrl: 'http://api.test/v1',
    tokens: noTokens,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    monotonic: () => 1_000,
    now: () => Date.parse('2026-09-24T10:00:00.000Z'),
    onSignedOut: () => undefined,
  });
  return new Api(client);
}

describe('lot parsing', () => {
  it('accepts the real GET /lots/:id response', async () => {
    const result = await apiReturning(REAL_LOT_RESPONSE).lot(REAL_LOT_RESPONSE.id);

    expect(result).toEqual({ ok: true, data: REAL_LOT_RESPONSE });
  });

  it('accepts the real GET /lots/nearby response', async () => {
    const result = await apiReturning(REAL_NEARBY_RESPONSE).nearbyLots(9.04, 38.76);

    expect(result).toEqual({ ok: true, data: REAL_NEARBY_RESPONSE });
  });

  it('turns a drifted response into an error result, not a crash in a render', async () => {
    // The DB's names instead of the API's: the shape the Book screen's cast
    // pretended the response had.
    const drifted = {
      ...REAL_LOT_RESPONSE,
      blockMinutes: undefined,
      block_minutes: 5,
    };

    const result = await apiReturning(drifted).lot(REAL_LOT_RESPONSE.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_RESPONSE');
  });

  it('drops a field the app does not know, so an older app survives an API addition', async () => {
    const result = await apiReturning({ ...REAL_LOT_RESPONSE, addedLater: 'x' }).lot('id');

    expect(result).toEqual({ ok: true, data: REAL_LOT_RESPONSE });
  });
});

describe("the Book screen's price preview", () => {
  it('prices the real response through billableLotFromSummary', async () => {
    const result = await apiReturning(REAL_LOT_RESPONSE).lot(REAL_LOT_RESPONSE.id);
    if (!result.ok) throw new Error(result.error.message);

    // The Book screen's computation, verbatim in shape: 2 blocks of 5 min.
    const minutes = 2 * result.data.blockMinutes;
    const bill = computeBill(
      {
        source: 'app',
        planned_minutes: minutes,
        checked_in_at: new Date(0),
        planned_end_at: new Date(minutes * 60_000),
        deposit_paid_santim: 0,
      },
      billableLotFromSummary(result.data),
      new Date(minutes * 60_000),
    );

    expect(bill.amountDueSantim).toBe(1000);
  });
});

describe('no double casts in the app', () => {
  it('finds no `as unknown as` in app/ or src/', async () => {
    // The cast that hid the crash from the type checker. A needed exception
    // should be a typed bridge like billableLotFromSummary, not a cast.
    const mobile = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.tsx?$/u.test(entry.name)) {
          if ((await readFile(full, 'utf8')).includes('as unknown as')) {
            offenders.push(relative(mobile, full).split('\\').join('/'));
          }
        }
      }
    };
    await walk(join(mobile, 'app'));
    await walk(join(mobile, 'src'));

    expect(offenders).toEqual([]);
  });
});
