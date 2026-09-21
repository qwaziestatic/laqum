import type { Clock } from '@laqum/shared';
import type { Redis } from 'ioredis';

/**
 * Fixed-window rate limiting in Redis.
 *
 * The window index is derived from the INJECTED clock and baked into the key,
 * rather than relying on a Redis TTL to expire the counter. Redis TTLs run on
 * real time, which a FakeClock cannot move, so a TTL-based limiter would be
 * untestable without sleeping. The TTL is still set, purely so abandoned keys
 * are reclaimed.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current window, including this one. */
  count: number;
  limit: number;
  /** When the current window ends and the counter resets. */
  resetAt: Date;
}

export interface RateLimiterOptions {
  redis: Redis;
  clock: Clock;
}

export class RateLimiter {
  readonly #redis: Redis;
  readonly #clock: Clock;

  constructor(options: RateLimiterOptions) {
    this.#redis = options.redis;
    this.#clock = options.clock;
  }

  async hit(scope: string, limit: number, windowMinutes: number): Promise<RateLimitResult> {
    const windowMs = windowMinutes * 60_000;
    const nowMs = this.#clock.now().getTime();
    const windowIndex = Math.floor(nowMs / windowMs);
    const key = `rl:${scope}:${String(windowIndex)}`;

    const count = await this.#redis.incr(key);
    if (count === 1) {
      // Generous: the window has already moved on by then, so this only
      // reclaims memory.
      await this.#redis.pexpire(key, windowMs * 2);
    }

    return {
      allowed: count <= limit,
      count,
      limit,
      resetAt: new Date((windowIndex + 1) * windowMs),
    };
  }

  /** Used after a successful verification, so a login does not count against the limit. */
  async reset(scope: string, windowMinutes: number): Promise<void> {
    const windowMs = windowMinutes * 60_000;
    const windowIndex = Math.floor(this.#clock.now().getTime() / windowMs);
    await this.#redis.del(`rl:${scope}:${String(windowIndex)}`);
  }
}
