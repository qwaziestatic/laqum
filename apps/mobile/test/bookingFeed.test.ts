import type { Booking, BookingUpdated } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { BookingFeed } from '../src/realtime/bookingFeed.js';

/**
 * The ordering rule for the driver's own booking: the same rule the
 * dashboard's RealtimeStore applies to slots, by lot version.
 */

const ID = '3b9f2a70-1c4d-4e8a-9f0b-6a2d5c7e8f10';
const LOT = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const SLOT = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

const RESERVED: Booking = {
  id: ID,
  lotId: LOT,
  slotId: SLOT,
  status: 'RESERVED',
  source: 'app',
  vehiclePlate: null,
  plannedMinutes: 60,
  qrToken: 'qr',
  shortCode: 'ABC234',
  holdExpiresAt: '2026-09-25T09:15:00.000Z',
  checkedInAt: null,
  plannedEndAt: null,
  checkedOutAt: null,
  amountDueSantim: null,
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
};

function event(lotVersion: number, fields: Partial<BookingUpdated> = {}): BookingUpdated {
  return {
    bookingId: ID,
    lotId: LOT,
    lotVersion,
    status: 'CHECKED_IN',
    slotId: SLOT,
    holdExpiresAt: '2026-09-25T09:15:00.000Z',
    plannedEndAt: '2026-09-25T10:05:00.000Z',
    amountDueSantim: null,
    ...fields,
  };
}

function fed(lotVersion = 5): BookingFeed {
  const feed = new BookingFeed(ID);
  feed.applySnapshot(RESERVED, lotVersion);
  return feed;
}

describe('events after the snapshot', () => {
  it('applies a newer event, carrying its fields onto the booking', () => {
    const feed = fed(5);
    expect(feed.applyEvent(event(6))).toBe(true);
    expect(feed.booking).toMatchObject({
      status: 'CHECKED_IN',
      plannedEndAt: '2026-09-25T10:05:00.000Z',
      // Fields events do not carry are kept.
      qrToken: 'qr',
      shortCode: 'ABC234',
    });
    expect(feed.lotVersion).toBe(6);
  });

  it('drops an event the snapshot already includes, or an older one', () => {
    const feed = fed(5);
    expect(feed.applyEvent(event(5))).toBe(false);
    expect(feed.applyEvent(event(3))).toBe(false);
    expect(feed.booking?.status).toBe('RESERVED');
  });

  it('lands a burst, then drops the straggler', () => {
    const feed = fed(5);
    feed.applyEvent(event(6, { status: 'CHECKED_IN' }));
    feed.applyEvent(event(8, { status: 'CHECKED_OUT', amountDueSantim: 4000 }));
    // Version 7 was another slot's change arriving late: nothing to apply.
    expect(feed.applyEvent(event(7, { status: 'CHECKED_IN' }))).toBe(false);
    expect(feed.booking).toMatchObject({ status: 'CHECKED_OUT', amountDueSantim: 4000 });
  });

  it('ignores another booking', () => {
    const feed = fed(5);
    expect(feed.applyEvent({ ...event(9), bookingId: 'another' })).toBe(false);
    expect(feed.booking?.status).toBe('RESERVED');
  });
});

describe('before a snapshot', () => {
  it('buffers events until the first snapshot, then applies only the newer ones', () => {
    const feed = new BookingFeed(ID);
    expect(feed.applyEvent(event(4, { status: 'RESERVED' }))).toBe(false);
    expect(feed.applyEvent(event(6))).toBe(false);
    expect(feed.booking).toBeNull();

    // The snapshot was read at 5: it includes the change at 4, not the one at 6.
    expect(feed.applySnapshot(RESERVED, 5)).toBe(true);
    expect(feed.booking?.status).toBe('CHECKED_IN');
    expect(feed.lotVersion).toBe(6);
  });

  it('drops a buffered event the snapshot already includes, so it cannot roll the booking back', () => {
    // The deposit was confirmed at 4, and the snapshot (read at 5) already
    // shows RESERVED. Replaying the older event would put PENDING_PAYMENT back.
    const feed = new BookingFeed(ID);
    feed.applyEvent(
      event(4, { status: 'PENDING_PAYMENT', holdExpiresAt: '2026-09-25T09:03:00.000Z' }),
    );
    feed.applySnapshot(RESERVED, 5);
    expect(feed.booking).toEqual(RESERVED);
    expect(feed.lotVersion).toBe(5);
  });

  it('treats version 0 as real: the watermark starts below it', () => {
    const feed = new BookingFeed(ID);
    feed.applySnapshot(RESERVED, 0);
    expect(feed.lotVersion).toBe(0);
    expect(feed.applyEvent(event(1))).toBe(true);
  });
});

describe('resync on reconnect', () => {
  it('buffers from the reconnect until the next snapshot', () => {
    const feed = fed(5);
    feed.beginResync();
    expect(feed.applyEvent(event(7))).toBe(false);
    expect(feed.booking?.status).toBe('RESERVED');

    // Read at 6, before the change at 7: the buffered event still applies.
    feed.applySnapshot(RESERVED, 6);
    expect(feed.booking?.status).toBe('CHECKED_IN');
    expect(feed.lotVersion).toBe(7);
  });

  it('ignores a snapshot older than what is already held', () => {
    // A poll sent before the check-in, answered after its event arrived.
    const feed = fed(5);
    feed.applyEvent(event(6));
    expect(feed.applySnapshot(RESERVED, 5)).toBe(false);
    expect(feed.booking?.status).toBe('CHECKED_IN');
    expect(feed.lotVersion).toBe(6);
  });

  it('accepts a newer snapshot over applied events: the server is the source of truth', () => {
    const feed = fed(5);
    feed.applyEvent(event(6));
    const paid: Booking = { ...RESERVED, status: 'PAID', amountDueSantim: 4000 };
    expect(feed.applySnapshot(paid, 9)).toBe(true);
    expect(feed.booking).toEqual(paid);
  });

  it('ignores a snapshot of another booking', () => {
    const feed = fed(5);
    expect(feed.applySnapshot({ ...RESERVED, id: 'another' }, 9)).toBe(false);
    expect(feed.lotVersion).toBe(5);
  });
});
