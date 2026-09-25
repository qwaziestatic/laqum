import { type Booking, isLiveStatus } from '@laqum/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../api/client.js';
import { verifiesDeposit } from '../booking/deposit.js';
import { useApp } from '../state/app.js';
import { BookingFeed } from './bookingFeed.js';

/** How often a live booking is refetched while pushed changes cannot be relied on. */
export const FALLBACK_POLL_MS = 20_000;

export interface LiveBooking {
  booking: Booking | null;
  /** Why the last refetch failed; cleared by the next one that succeeds. */
  error: ApiError | null;
  /** Refetch now. `verify` also asks the payment service about a pending deposit. */
  reload: (options?: { verify?: boolean }) => Promise<void>;
}

/**
 * One booking, kept current: a REST snapshot, then the driver's pushed
 * changes, ordered by lot version (bookingFeed.ts).
 *
 * - On mount and on every return to the foreground: refetch, and verify a
 *   pending deposit on the way, since the driver is most likely back from
 *   the checkout.
 * - On every socket (re)connect: hold events, refetch (connection.ts).
 * - POLLING IS THE FALLBACK, not the mechanism: only while the socket is not
 *   live, or while a resync's snapshot has not arrived (its events are held
 *   until one does, so a failed refetch must be retried).
 */
export function useLiveBooking(id: string | undefined): LiveBooking {
  const { api, realtime, realtimeState, foregroundEpoch } = useApp();
  const feed = useMemo(() => (id ? new BookingFeed(id) : null), [id]);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [awaitingSnapshot, setAwaitingSnapshot] = useState(false);

  const reload = useCallback(
    async (options: { verify?: boolean } = {}) => {
      if (!id || !feed) return;
      let result = await api.booking(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (options.verify && verifiesDeposit(result.data.booking.status)) {
        // A failure here changes nothing: the booking just read still stands.
        const verified = await api.verifyDeposit(id);
        if (verified.ok) result = verified;
      }
      feed.applySnapshot(result.data.booking, result.data.lotVersion);
      setBooking(feed.booking);
      setError(null);
      setAwaitingSnapshot(false);
    },
    [api, id, feed],
  );

  useEffect(() => {
    void reload({ verify: true });
  }, [reload]);

  // Foreground refetches, it does not extrapolate: the server may have
  // expired the hold, or confirmed the deposit, while the app slept.
  useEffect(() => {
    if (foregroundEpoch > 0) void reload({ verify: true });
  }, [foregroundEpoch, reload]);

  useEffect(() => {
    if (!feed) return;
    return realtime.onBooking((event) => {
      if (feed.applyEvent(event)) setBooking(feed.booking);
    });
  }, [realtime, feed]);

  useEffect(() => {
    if (!feed) return;
    return realtime.onResync(() => {
      feed.beginResync();
      setAwaitingSnapshot(true);
      void reload();
    });
  }, [realtime, feed, reload]);

  const live = booking !== null && isLiveStatus(booking.status);
  const pushedChangesReliable = realtimeState === 'live' && !awaitingSnapshot;
  useEffect(() => {
    if (!live || pushedChangesReliable) return;
    const timer = setInterval(() => void reload(), FALLBACK_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [live, pushedChangesReliable, reload]);

  return { booking, error, reload };
}
