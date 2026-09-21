import { describe, expect, it } from 'vitest';
import {
  BOOKING_STATUSES,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  isLiveStatus,
  type BookingStatus,
} from './enums.js';

describe('LIVE_STATUSES', () => {
  it('is exactly the four statuses that hold a slot', () => {
    expect([...LIVE_STATUSES]).toEqual(['PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY']);
  });

  it('partitions the booking statuses with no overlap and no gap', () => {
    const live = new Set<BookingStatus>(LIVE_STATUSES);
    const terminal = new Set<BookingStatus>(TERMINAL_STATUSES);

    for (const status of BOOKING_STATUSES) {
      expect(live.has(status) !== terminal.has(status)).toBe(true);
    }
    expect(live.size + terminal.size).toBe(BOOKING_STATUSES.length);
  });

  it('classifies every status', () => {
    expect(isLiveStatus('CHECKED_IN')).toBe(true);
    expect(isLiveStatus('OVERSTAY')).toBe(true);
    expect(isLiveStatus('CHECKED_OUT')).toBe(false);
    expect(isLiveStatus('PAID')).toBe(false);
    expect(isLiveStatus('EXPIRED')).toBe(false);
    expect(isLiveStatus('CANCELLED')).toBe(false);
  });
});
