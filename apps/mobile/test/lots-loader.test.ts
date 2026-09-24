import type { NearbyLot, NearbyLotsResponse } from '@laqum/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../src/api/client.js';
import { createLotsLoader, type LotsLoaderDeps } from '../src/home/lotsLoader.js';
import type { LocationResult } from '../src/location/fix.js';

/**
 * Home's loading. The device test asked whether Refresh really refetches:
 * nothing on screen changed when the counts had not, so it could not tell.
 */

function lot(id: string, freeSlots: number): NearbyLot {
  return {
    id,
    name: `Lot ${id}`,
    address: null,
    latitude: 9.04,
    longitude: 38.76,
    contactPhone: '+251911000000',
    blockMinutes: 5,
    ratePerBlockSantim: 500,
    overstayRatePerBlockSantim: 1000,
    depositAmountSantim: 0,
    holdMinutes: 3,
    paymentWindowMinutes: 3,
    maxBookingDistanceM: 1000,
    freeSlots,
    totalAppBookableSlots: 6,
    distanceM: 0,
    withinBookingRange: true,
  };
}

const QUICK: LocationResult = {
  kind: 'fix',
  fix: { latitude: 9.041, longitude: 38.761, accuracyM: 100, timestampMs: 1 },
};
const FRESH: LocationResult = {
  kind: 'fix',
  fix: { latitude: 9.04, longitude: 38.76, accuracyM: 20, timestampMs: 2 },
};

function ok(lots: NearbyLot[]): ApiResult<NearbyLotsResponse> {
  return { ok: true, data: { lots } };
}

/** A promise resolved from outside, to control the order responses land in. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<LotsLoaderDeps> = {}) {
  const shown: NearbyLot[][] = [];
  const errors: string[] = [];
  const deps: LotsLoaderDeps = {
    locate: (_prompt, report) => {
      report(FRESH);
      return Promise.resolve();
    },
    fetchLots: () => Promise.resolve(ok([])),
    onLocation: () => undefined,
    onLots: (lots) => shown.push(lots),
    onError: (message) => errors.push(message),
    ...overrides,
  };
  return { loader: createLotsLoader(deps), shown, errors };
}

describe('createLotsLoader', () => {
  it('fetches again on Refresh and shows what came back', async () => {
    // The API answers 6 free, then 5 free: a Refresh must reach it again.
    const fetchLots = vi
      .fn<LotsLoaderDeps['fetchLots']>()
      .mockResolvedValueOnce(ok([lot('a', 6)]))
      .mockResolvedValueOnce(ok([lot('a', 5)]));
    const { loader, shown } = harness({ fetchLots });

    await loader.load('first-time');
    await loader.load('on-tap'); // what Refresh does

    expect(fetchLots).toHaveBeenCalledTimes(2);
    expect(shown.map((lots) => lots[0]?.freeSlots)).toEqual([6, 5]);
  });

  it('fetches for each position report, quick then fresh', async () => {
    const fetchLots = vi.fn<LotsLoaderDeps['fetchLots']>((result) =>
      Promise.resolve(ok([lot(result === QUICK ? 'quick' : 'fresh', 1)])),
    );
    const { loader, shown } = harness({
      locate: (_prompt, report) => {
        report(QUICK);
        report(FRESH);
        return Promise.resolve();
      },
      fetchLots,
    });

    await loader.load('first-time');

    expect(fetchLots.mock.calls.map(([result]) => result)).toEqual([QUICK, FRESH]);
    expect(shown.at(-1)?.[0]?.id).toBe('fresh');
  });

  it("drops a late answer for an older report, so the fresh fix's list stays", async () => {
    const quickAnswer = deferred<ApiResult<NearbyLotsResponse>>();
    const { loader, shown } = harness({
      locate: (_prompt, report) => {
        report(QUICK);
        report(FRESH);
        return Promise.resolve();
      },
      fetchLots: (result) =>
        result === QUICK ? quickAnswer.promise : Promise.resolve(ok([lot('fresh', 1)])),
    });

    const loading = loader.load('first-time');
    await vi.waitFor(() => {
      expect(shown).toHaveLength(1);
    });
    quickAnswer.resolve(ok([lot('quick', 1)])); // lands last
    await loading;

    expect(shown.map((lots) => lots[0]?.id)).toEqual(['fresh']);
  });

  it('lets a newer load win over an older one still in flight', async () => {
    const firstAnswer = deferred<ApiResult<NearbyLotsResponse>>();
    let call = 0;
    const { loader, shown } = harness({
      fetchLots: () => {
        call += 1;
        return call === 1 ? firstAnswer.promise : Promise.resolve(ok([lot('second', 1)]));
      },
    });

    const first = loader.load('first-time');
    await loader.load('on-tap');
    firstAnswer.resolve(ok([lot('first', 1)]));
    await first;

    expect(shown.map((lots) => lots[0]?.id)).toEqual(['second']);
  });

  it('resolves only once its lots have landed, which bounds "Refreshing…"', async () => {
    const answer = deferred<ApiResult<NearbyLotsResponse>>();
    const { loader, shown } = harness({ fetchLots: () => answer.promise });

    let done = false;
    const loading = loader.load('on-tap').then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done, 'resolved before the lots arrived').toBe(false);

    answer.resolve(ok([lot('a', 3)]));
    await loading;
    expect(done).toBe(true);
    expect(shown).toHaveLength(1);
  });

  it('reports a failed fetch', async () => {
    const { loader, errors } = harness({
      fetchLots: () =>
        Promise.resolve({ ok: false, error: { code: 'NETWORK', message: 'Offline' } }),
    });

    await loader.load('on-tap');

    expect(errors).toEqual(['Offline']);
  });
});
