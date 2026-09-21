import { describe, expect, it } from 'vitest';
import { FakeClock, addMinutes, elapsedMinutes, systemClock } from './clock.js';

describe('FakeClock', () => {
  it('stays put until it is moved', () => {
    const clock = new FakeClock('2026-03-01T08:00:00.000Z');
    const first = clock.now();
    const second = clock.now();
    expect(first.toISOString()).toBe('2026-03-01T08:00:00.000Z');
    expect(second.getTime()).toBe(first.getTime());
  });

  it('hands out a fresh Date each call, so callers cannot mutate it', () => {
    const clock = new FakeClock('2026-03-01T08:00:00.000Z');
    const handed = clock.now();
    handed.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-03-01T08:00:00.000Z');
  });

  it('advances by milliseconds, seconds and minutes', () => {
    const clock = new FakeClock('2026-03-01T08:00:00.000Z');
    clock.advanceMs(1).advanceSeconds(59).advanceMinutes(1);
    expect(clock.now().toISOString()).toBe('2026-03-01T08:01:59.001Z');
  });

  it('refuses to advance backwards, which would be a test bug', () => {
    const clock = new FakeClock();
    expect(() => clock.advanceMs(-1)).toThrow(RangeError);
    expect(() => clock.advanceMinutes(Number.NaN)).toThrow(RangeError);
  });

  it('allows an explicit jump in either direction via set()', () => {
    const clock = new FakeClock('2026-03-01T08:00:00.000Z');
    clock.set('2026-02-01T08:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });

  it('rejects an invalid start or target', () => {
    expect(() => new FakeClock('not a date')).toThrow(RangeError);
    expect(() => new FakeClock().set('also not a date')).toThrow(RangeError);
  });
});

describe('systemClock', () => {
  it('reports the real time and moves on its own', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('addMinutes', () => {
  it('shifts forward and backward without mutating the input', () => {
    const base = new Date('2026-03-01T08:00:00.000Z');
    expect(addMinutes(base, 15).toISOString()).toBe('2026-03-01T08:15:00.000Z');
    expect(addMinutes(base, -15).toISOString()).toBe('2026-03-01T07:45:00.000Z');
    expect(base.toISOString()).toBe('2026-03-01T08:00:00.000Z');
  });

  it('crosses a day boundary correctly', () => {
    const base = new Date('2026-03-01T23:50:00.000Z');
    expect(addMinutes(base, 20).toISOString()).toBe('2026-03-02T00:10:00.000Z');
  });
});

describe('elapsedMinutes', () => {
  const base = new Date('2026-03-01T08:00:00.000Z');
  const plus = (ms: number): Date => new Date(base.getTime() + ms);

  it('is zero at the same instant', () => {
    expect(elapsedMinutes(base, base)).toBe(0);
  });

  it('rounds any part-minute up to a whole minute', () => {
    expect(elapsedMinutes(base, plus(1))).toBe(1);
    expect(elapsedMinutes(base, plus(59_999))).toBe(1);
    expect(elapsedMinutes(base, plus(60_000))).toBe(1);
    expect(elapsedMinutes(base, plus(60_001))).toBe(2);
  });

  it('never goes negative when the clock runs backwards', () => {
    expect(elapsedMinutes(base, plus(-60_000))).toBe(0);
  });
});
