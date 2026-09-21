/**
 * Time is injected, never read from the ambient environment.
 *
 * Every deadline in this system — payment windows, arrival holds, planned
 * ends, overstay, OTP expiry, token TTLs — is computed from a Clock. Tests
 * advance a FakeClock instead of sleeping, so a suite that covers a 15-minute
 * hold runs in milliseconds and is deterministic.
 *
 * THE COMPANION LAW: business SQL must never call now().
 *
 * Postgres has its own clock, and no amount of FakeClock advancing moves it. A
 * single `now()` in a WHERE clause or an INSERT silently ignores the injected
 * time and quietly defeats every time-dependent test. So:
 *
 *   - expiry and sweeper queries take the instant as a bound PARAMETER;
 *   - time-sensitive rows are written with explicit clock values, overriding
 *     the column default;
 *   - now() survives only as a DDL column default.
 *
 * apps/api/test/guards.test.ts greps for violations.
 */
export interface Clock {
  now(): Date;
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when a test moves it. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Date | string | number = '2026-01-01T06:00:00.000Z') {
    const ms = start instanceof Date ? start.getTime() : new Date(start).getTime();
    if (Number.isNaN(ms)) {
      throw new RangeError(`FakeClock received an invalid start time: ${String(start)}`);
    }
    this.#ms = ms;
  }

  now(): Date {
    return new Date(this.#ms);
  }

  /** Milliseconds since the epoch, for arithmetic that would otherwise allocate. */
  nowMs(): number {
    return this.#ms;
  }

  advanceMs(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`Time only moves forward; received ${String(ms)}ms`);
    }
    this.#ms += ms;
    return this;
  }

  advanceSeconds(seconds: number): this {
    return this.advanceMs(seconds * SECOND_MS);
  }

  advanceMinutes(minutes: number): this {
    return this.advanceMs(minutes * MINUTE_MS);
  }

  /** Jump to an instant. Unlike advance*, this permits moving backwards. */
  set(when: Date | string | number): this {
    const ms = when instanceof Date ? when.getTime() : new Date(when).getTime();
    if (Number.isNaN(ms)) {
      throw new RangeError(`FakeClock received an invalid time: ${String(when)}`);
    }
    this.#ms = ms;
    return this;
  }
}

/** `at` shifted by whole minutes. Used for every deadline in the system. */
export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

/**
 * Whole minutes between two instants, rounding any part-minute UP, and never
 * negative. Parking is billed by the block, and a car that is one second over
 * has been there for a minute as far as the meter is concerned.
 */
export function elapsedMinutes(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / MINUTE_MS);
}
