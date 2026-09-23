/**
 * Counting down to a deadline the SERVER owns.
 *
 * Three things can make a naive `deadline - Date.now()` wrong on a phone:
 *
 *   1. THE CLOCK IS WRONG. A phone with automatic time off, or a fresh device
 *      before it syncs, can be minutes or hours out. The hold would appear to
 *      have expired, or to have ages left, neither true.
 *   2. THE CLOCK MOVES. NTP corrects it mid-countdown, or the driver crosses
 *      into another timezone, and the remaining time jumps.
 *   3. THE APP WAS ASLEEP. Timers do not fire reliably in the background, so
 *      on resume the displayed value can be arbitrarily stale.
 *
 * The fix for (1) and (2) is to learn the OFFSET between the server's clock
 * and the device's, and to tick on ELAPSED time rather than absolute time. The
 * offset comes from the `Date` header every HTTP response already carries — no
 * new endpoint, and every single request re-syncs it for free.
 *
 * The fix for (3) is not arithmetic: on returning to the foreground the app
 * REFETCHES the booking, because the server may have expired it while the app
 * slept. This module deliberately exposes `isExpired` as a display hint only;
 * the server decides, and the UI says "expired" when the API says so.
 */

export interface ServerTimeSample {
  /** Server time in epoch millis, from the response `Date` header. */
  serverMs: number;
  /** Device time when that response was received. */
  deviceMs: number;
  /**
   * A monotonic reading at the same moment, if available.
   *
   * `performance.now()` does not jump when the wall clock is corrected, which
   * is exactly the property a countdown needs.
   */
  monotonicMs: number;
}

export class ServerClock {
  /** serverMs - deviceMs at the last sample. */
  #offsetMs = 0;
  #monotonicAtSample = 0;
  #serverAtSample = 0;
  #synced = false;

  /** True once a real response has been seen. */
  get synced(): boolean {
    return this.#synced;
  }

  get offsetMs(): number {
    return this.#offsetMs;
  }

  /**
   * Record a sample. Called for EVERY response, so the offset stays fresh.
   *
   * No smoothing or averaging: a later sample is strictly better information
   * than an earlier one, and averaging would drag a corrected clock back
   * toward the wrong value it just left.
   */
  sample(sample: ServerTimeSample): void {
    this.#offsetMs = sample.serverMs - sample.deviceMs;
    this.#monotonicAtSample = sample.monotonicMs;
    this.#serverAtSample = sample.serverMs;
    this.#synced = true;
  }

  /**
   * Server time now, estimated from the last sample plus monotonic elapsed.
   *
   * Monotonic, NOT `Date.now() + offset`: if the wall clock is corrected
   * between the sample and now, the offset is stale by exactly the correction,
   * and the two errors would add rather than cancel.
   */
  now(monotonicMs: number, deviceMs: number): number {
    if (!this.#synced) {
      // Never synced: fall back to the device clock and say so via `synced`,
      // so the UI can mark the countdown approximate rather than silently
      // presenting a guess as fact.
      return deviceMs;
    }
    return this.#serverAtSample + (monotonicMs - this.#monotonicAtSample);
  }

  /** Milliseconds until `deadlineMs` (server time). Never negative. */
  remainingMs(deadlineIso: string, monotonicMs: number, deviceMs: number): number {
    const deadline = Date.parse(deadlineIso);
    if (Number.isNaN(deadline)) return 0;
    return Math.max(0, deadline - this.now(monotonicMs, deviceMs));
  }
}

/** Parse an HTTP `Date` header into epoch millis, or null if absent/unparseable. */
export function parseDateHeader(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** mm:ss for a countdown. Hours are folded into minutes — a hold is never that long. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
