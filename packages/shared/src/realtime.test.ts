import { describe, expect, it } from 'vitest';
import { socketRetryDelayMs } from './realtime.js';

describe('when to retry a handshake refused for rate', () => {
  it("waits the server's retryAfterMs, plus up to as much again at random", () => {
    expect(socketRetryDelayMs({ retryAfterMs: 20_000 }, () => 0)).toBe(20_000);
    expect(socketRetryDelayMs({ retryAfterMs: 20_000 }, () => 0.999)).toBe(39_980);
  });

  it('spreads a crowd refused together across the next window', () => {
    // 1,000 clients refused at the same moment, as after a deploy.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const delays = Array.from({ length: 1000 }, () =>
      socketRetryDelayMs({ retryAfterMs: 30_000 }, random),
    );
    const perSecond = new Map<number, number>();
    for (const d of delays)
      perSecond.set(Math.floor(d / 1000), (perSecond.get(Math.floor(d / 1000)) ?? 0) + 1);
    // Thirty seconds of spread, and no second takes more than a tenth of them.
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(30_000);
    expect(Math.max(...delays)).toBeLessThan(60_000);
    expect(Math.max(...perSecond.values())).toBeLessThan(100);
  });

  it('is bounded: never sooner than 1 s, never later than 2 min', () => {
    expect(socketRetryDelayMs({ retryAfterMs: 0 }, () => 0)).toBe(1_000);
    expect(socketRetryDelayMs({ retryAfterMs: -5 }, () => 0)).toBe(1_000);
    expect(socketRetryDelayMs({ retryAfterMs: 10 * 60_000 }, () => 0.999)).toBeLessThanOrEqual(
      120_000,
    );
  });

  it('has a sane default when the server said nothing usable', () => {
    for (const data of [undefined, null, {}, { retryAfterMs: 'soon' }, 'x']) {
      const delay = socketRetryDelayMs(data, () => 0);
      expect(delay, JSON.stringify(data)).toBe(5_000);
    }
  });
});
