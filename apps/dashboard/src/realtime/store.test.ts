import type { StaffSlotEvent, StaffSnapshot } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { RealtimeStore } from './store.js';

const LOT = '11111111-1111-1111-1111-111111111111';

function slot(overrides: Partial<StaffSlotEvent> & { slotId: string }): StaffSlotEvent {
  return {
    lotId: LOT,
    lotVersion: 0,
    label: 'A-1',
    zone: 'A',
    gridRow: 0,
    gridCol: 0,
    appBookable: true,
    inService: true,
    displayStatus: 'free',
    bookingId: null,
    source: null,
    vehiclePlate: null,
    holdExpiresAt: null,
    plannedEndAt: null,
    ...overrides,
  };
}

function snapshot(lotVersion: number, slots: StaffSlotEvent[]): StaffSnapshot {
  return { lotId: LOT, lotVersion, slots };
}

const A1 = '22222222-2222-2222-2222-222222222222';
const A2 = '33333333-3333-3333-3333-333333333333';

function statusOf(store: RealtimeStore, slotId: string): string | undefined {
  return store.getState().slots.find((s) => s.slotId === slotId)?.displayStatus;
}

describe('RealtimeStore ordering', () => {
  /**
   * THE case the version exists for.
   *
   * A free slot has no live booking, so under the old updated_at scheme the
   * snapshot row carried NULL and a stale "occupied" event — which does carry
   * a timestamp — would have won. With a per-lot version there is always
   * something to compare, and the stale event loses.
   */
  it('drops a stale "occupied" event for a slot the snapshot says is FREE', () => {
    const store = new RealtimeStore();

    // The car left at version 41; the snapshot shows the slot free.
    store.applySnapshot(snapshot(41, [slot({ slotId: A1, displayStatus: 'free' })]));
    expect(statusOf(store, A1)).toBe('free');

    // A buffered event from BEFORE the checkout arrives late.
    const applied = store.applySlotEvent(
      slot({
        slotId: A1,
        lotVersion: 38,
        displayStatus: 'occupied',
        bookingId: '44444444-4444-4444-4444-444444444444',
        vehiclePlate: 'AA-12345',
      }),
    );

    expect(applied, 'a version older than the snapshot must not be applied').toBe(false);
    expect(statusOf(store, A1)).toBe('free');
    expect(store.getState().counts.free).toBe(1);
    expect(store.getState().counts.occupied).toBe(0);
    // And no plate from the stale event leaked into the rendered slot.
    expect(store.getState().slots[0]?.vehiclePlate).toBeNull();
  });

  it('applies an event NEWER than the snapshot', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(41, [slot({ slotId: A1, displayStatus: 'free' })]));

    const applied = store.applySlotEvent(
      slot({ slotId: A1, lotVersion: 42, displayStatus: 'occupied' }),
    );

    expect(applied).toBe(true);
    expect(statusOf(store, A1)).toBe('occupied');
    expect(store.getState().lotVersion).toBe(42);
  });

  it('rejects an event AT the snapshot version as already reflected', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(41, [slot({ slotId: A1, displayStatus: 'free' })]));

    expect(
      store.applySlotEvent(slot({ slotId: A1, lotVersion: 41, displayStatus: 'occupied' })),
    ).toBe(false);
    expect(statusOf(store, A1)).toBe('free');
  });

  it('buffers events that arrive before the snapshot, then sorts them by version', () => {
    const store = new RealtimeStore();

    // The socket is live while the snapshot fetch is still in flight.
    store.applySlotEvent(slot({ slotId: A1, lotVersion: 38, displayStatus: 'occupied' }));
    store.applySlotEvent(slot({ slotId: A2, lotVersion: 43, displayStatus: 'occupied' }));
    expect(store.getState().loading).toBe(true);
    expect(store.getState().slots).toHaveLength(0);

    store.applySnapshot(
      snapshot(41, [
        slot({ slotId: A1, label: 'A-1', gridCol: 0, displayStatus: 'free' }),
        slot({ slotId: A2, label: 'A-2', gridCol: 1, displayStatus: 'free' }),
      ]),
    );

    // 38 predates the snapshot and is discarded; 43 postdates it and is kept.
    expect(statusOf(store, A1)).toBe('free');
    expect(statusOf(store, A2)).toBe('occupied');
    expect(store.getState().lotVersion).toBe(43);
    expect(store.getState().loading).toBe(false);
  });

  it('advances the watermark across a burst, still rejecting a straggler', () => {
    const store = new RealtimeStore();
    store.applySnapshot(
      snapshot(41, [slot({ slotId: A1, gridCol: 0 }), slot({ slotId: A2, gridCol: 1 })]),
    );

    expect(
      store.applySlotEvent(slot({ slotId: A1, lotVersion: 42, displayStatus: 'reserved' })),
    ).toBe(true);
    expect(
      store.applySlotEvent(slot({ slotId: A2, lotVersion: 43, displayStatus: 'occupied' })),
    ).toBe(true);
    expect(store.getState().lotVersion).toBe(43);

    // Arrives out of order, older than everything applied.
    expect(store.applySlotEvent(slot({ slotId: A1, lotVersion: 39, displayStatus: 'free' }))).toBe(
      false,
    );
    expect(statusOf(store, A1)).toBe('reserved');
  });

  it('treats a re-delivered event as a no-op', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(41, [slot({ slotId: A1 })]));

    const event = slot({ slotId: A1, lotVersion: 42, displayStatus: 'occupied' });
    expect(store.applySlotEvent(event)).toBe(true);
    // Socket.io can redeliver on reconnect; applying twice must not differ.
    expect(store.applySlotEvent(event)).toBe(false);
    expect(statusOf(store, A1)).toBe('occupied');
    expect(store.getState().counts.occupied).toBe(1);
  });

  it('ignores an event for a different lot', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(41, [slot({ slotId: A1 })]));

    const applied = store.applySlotEvent(
      slot({
        slotId: A1,
        lotId: '99999999-9999-9999-9999-999999999999',
        lotVersion: 99,
        displayStatus: 'occupied',
      }),
    );

    expect(applied).toBe(false);
    expect(statusOf(store, A1)).toBe('free');
  });

  it('keeps counts derived from the slots, never tallied separately', () => {
    const store = new RealtimeStore();
    store.applySnapshot(
      snapshot(10, [
        slot({ slotId: A1, gridCol: 0, displayStatus: 'free' }),
        slot({ slotId: A2, gridCol: 1, displayStatus: 'overstay' }),
      ]),
    );

    expect(store.getState().counts).toEqual({
      free: 1,
      reserved: 0,
      occupied: 0,
      overstay: 1,
      outOfService: 0,
    });

    store.applySlotEvent(
      slot({ slotId: A1, gridCol: 0, lotVersion: 11, displayStatus: 'reserved' }),
    );
    expect(store.getState().counts).toEqual({
      free: 0,
      reserved: 1,
      occupied: 0,
      overstay: 1,
      outOfService: 0,
    });
  });
});

describe('RealtimeStore reconnect', () => {
  it('discards the grid on reset and waits for a fresh snapshot', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(41, [slot({ slotId: A1, displayStatus: 'occupied' })]));

    store.reset();
    expect(store.getState().loading).toBe(true);
    expect(store.getState().slots).toHaveLength(0);
    expect(store.getState().connection).toBe('reconnecting');

    // Events during the gap are buffered, not applied to a stale grid.
    store.applySlotEvent(slot({ slotId: A1, lotVersion: 44, displayStatus: 'free' }));
    expect(store.getState().slots).toHaveLength(0);

    store.applySnapshot(snapshot(43, [slot({ slotId: A1, displayStatus: 'occupied' })]));
    expect(statusOf(store, A1)).toBe('free');
    expect(store.getState().lotVersion).toBe(44);
  });

  /**
   * Version 0 is a REAL version: a lot that has never had a booking. The
   * "no snapshot yet" sentinel has to sit below it, or the first event on a
   * brand-new lot would be compared against a snapshot that never arrived.
   */
  it('accepts version 1 on a lot whose snapshot was version 0', () => {
    const store = new RealtimeStore();
    store.applySnapshot(snapshot(0, [slot({ slotId: A1 })]));
    expect(store.getState().lotVersion).toBe(0);

    expect(
      store.applySlotEvent(slot({ slotId: A1, lotVersion: 1, displayStatus: 'reserved' })),
    ).toBe(true);
    expect(statusOf(store, A1)).toBe('reserved');
  });

  it('notifies subscribers on snapshot and on each applied event only', () => {
    const store = new RealtimeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });

    store.applySnapshot(snapshot(41, [slot({ slotId: A1 })]));
    expect(notifications).toBe(1);

    store.applySlotEvent(slot({ slotId: A1, lotVersion: 42, displayStatus: 'occupied' }));
    expect(notifications).toBe(2);

    // Rejected: nothing changed, so nothing re-renders.
    store.applySlotEvent(slot({ slotId: A1, lotVersion: 20, displayStatus: 'free' }));
    expect(notifications).toBe(2);
  });
});
