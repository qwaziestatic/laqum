import type { NearbyLotsResponse } from '@laqum/shared';
import type { ApiError, ApiResult } from '../api/client.js';
import type { LocationResult, PermissionPrompt } from '../location/fix.js';
import { latestOnly } from '../latest.js';

/**
 * Home's lot loading, out of the component so it can be tested without a
 * renderer.
 *
 * One load: resolve a position (a quick last-known report, then the fresh
 * one) and fetch lots for EACH report. Only the newest report's lots are
 * applied, however the responses interleave. `load` resolves once the lots it
 * fetched have LANDED, not merely once the position is known — which is what
 * lets Home show "Refreshing…" for exactly as long as a refresh takes. The
 * device test found Refresh gave no feedback at all.
 */

export interface LotsLoaderDeps {
  /** getFixQuickThenFresh: reports up to twice, quick then fresh. */
  locate: (prompt: PermissionPrompt, report: (result: LocationResult) => void) => Promise<void>;
  /** The lots around a position, or around the city centre without one. */
  fetchLots: (result: LocationResult) => Promise<ApiResult<NearbyLotsResponse>>;
  onLocation: (result: LocationResult) => void;
  onLots: (lots: NearbyLotsResponse['lots']) => void;
  /** The failure itself: the screen words it in the driver's language. */
  onError: (error: ApiError) => void;
}

export interface LotsLoader {
  load: (prompt: PermissionPrompt) => Promise<void>;
}

export function createLotsLoader(deps: LotsLoaderDeps): LotsLoader {
  const latest = latestOnly();
  return {
    async load(prompt) {
      const fetches: Promise<void>[] = [];
      await deps.locate(prompt, (result) => {
        const ticket = latest.take();
        deps.onLocation(result);
        fetches.push(
          deps.fetchLots(result).then((response) => {
            // A newer report (or a newer load) has started: its answer wins.
            if (!latest.isCurrent(ticket)) return;
            if (response.ok) deps.onLots(response.data.lots);
            else deps.onError(response.error);
          }),
        );
      });
      await Promise.all(fetches);
    },
  };
}
