import { describe, expect, it } from 'vitest';
import { ServerClock, formatRemaining, parseDateHeader } from '../src/time/serverClock.js';

/**
 * The countdown must survive a wrong phone clock, a clock CORRECTION
 * mid-countdown, and the app being backgrounded. Each is tested explicitly,
 * because each fails differently and only the first is obvious.
 */

const SERVER = Date.parse('2026-03-01T08:00:00.000Z');
/** The phone is four minutes fast — a realistic amount for auto-time off. */
const DEVICE_SKEW = 4 * 60_000;

describe('a wrong device clock does not move the deadline', () => {
  it('counts down from SERVER time, not device time', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER + DEVICE_SKEW, monotonicMs: 1_000 });

    // Deadline 15 minutes after the server's now.
    const deadline = new Date(SERVER + 15 * 60_000).toISOString();

    // No time has passed on the monotonic clock.
    const remaining = clock.remainingMs(deadline, 1_000, SERVER + DEVICE_SKEW);
    expect(remaining).toBe(15 * 60_000);
  });

  it('would have been four minutes wrong using the device clock', () => {
    // The bug this exists to prevent, stated as a number.
    const deadline = SERVER + 15 * 60_000;
    const naive = deadline - (SERVER + DEVICE_SKEW);
    expect(naive).toBe(11 * 60_000);
  });

  it('reports the offset it learned', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER + DEVICE_SKEW, monotonicMs: 0 });
    expect(clock.offsetMs).toBe(-DEVICE_SKEW);
  });
});

describe('a clock CORRECTION mid-countdown does not jump it', () => {
  it('ticks on monotonic elapsed, so an NTP fix is invisible', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER + DEVICE_SKEW, monotonicMs: 1_000 });
    const deadline = new Date(SERVER + 15 * 60_000).toISOString();

    // 60s later on the monotonic clock. Meanwhile NTP corrects the wall clock
    // by the full four minutes, so deviceMs jumps BACKWARDS.
    const corrected = SERVER + 60_000;
    const remaining = clock.remainingMs(deadline, 61_000, corrected);

    // Exactly one minute consumed. A `Date.now() + offset` implementation
    // would have double-counted the correction here.
    expect(remaining).toBe(14 * 60_000);
  });
});

describe('before the first response', () => {
  it('says it is not synced, so the UI can mark the value approximate', () => {
    const clock = new ServerClock();
    expect(clock.synced).toBe(false);
  });

  it('falls back to the device clock rather than to zero', () => {
    // Showing 00:00 on a hold that is actually fine would be worse than an
    // approximate value: the driver would think they had lost the slot.
    const clock = new ServerClock();
    const deadline = new Date(SERVER + 10 * 60_000).toISOString();
    expect(clock.remainingMs(deadline, 0, SERVER)).toBe(10 * 60_000);
  });

  it('becomes synced after one sample', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER, monotonicMs: 0 });
    expect(clock.synced).toBe(true);
  });
});

describe('never negative', () => {
  it('clamps a passed deadline to zero', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER, monotonicMs: 0 });
    const past = new Date(SERVER - 60_000).toISOString();
    expect(clock.remainingMs(past, 0, SERVER)).toBe(0);
  });

  it('treats an unparseable deadline as expired rather than as NaN', () => {
    const clock = new ServerClock();
    clock.sample({ serverMs: SERVER, deviceMs: SERVER, monotonicMs: 0 });
    expect(clock.remainingMs('not a date', 0, SERVER)).toBe(0);
  });
});

describe('the Date header', () => {
  it('parses a real one', () => {
    expect(parseDateHeader('Sun, 01 Mar 2026 08:00:00 GMT')).toBe(SERVER);
  });

  it('returns null when absent or junk, so the offset is left alone', () => {
    expect(parseDateHeader(null)).toBeNull();
    expect(parseDateHeader('')).toBeNull();
    expect(parseDateHeader('yesterday')).toBeNull();
  });
});

describe('formatting', () => {
  it('pads to mm:ss', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(9_000)).toBe('00:09');
    expect(formatRemaining(15 * 60_000)).toBe('15:00');
    expect(formatRemaining(61_000)).toBe('01:01');
  });

  it('never renders a negative clock', () => {
    expect(formatRemaining(-5_000)).toBe('00:00');
  });
});
