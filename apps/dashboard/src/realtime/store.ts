import { type LotCounts, type StaffSlotEvent, type StaffSnapshot, countSlots } from '@laqum/shared';

/**
 * The client side of the ordering rule.
 *
 * A socket connects and starts delivering events immediately, while the
 * snapshot is still being fetched over HTTP. Those two streams are racing, so
 * something has to decide which events the snapshot already accounts for.
 *
 * THE RULE: apply an event only when `event.lotVersion > snapshot.lotVersion`.
 *
 * WHY NOT TIMESTAMPS — the case this class exists to get right:
 *
 *   Slot A-1 is occupied. The attendant checks the car out, so A-1 becomes
 *   free at lot version 41. The dashboard reconnects and fetches a snapshot at
 *   version 41 showing A-1 FREE. A buffered "A-1 occupied" event from version
 *   38 is still sitting in the queue.
 *
 *   With updated_at there is nothing to compare: the FREE snapshot row has no
 *   live booking, so its updated_at is NULL, while the stale event carries a
 *   real timestamp. Any "newer wins" rule applies the stale event and the
 *   dashboard shows a car that has driven away. An attendant then refuses to
 *   park someone on an empty space.
 *
 *   With lots.version, 38 > 41 is false and the event is dropped. The version
 *   belongs to the LOT, so it exists whether or not the slot has a booking.
 *
 * The store is a plain class with no React and no socket in it, so this rule
 * is testable without either.
 */

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface RealtimeState {
  lotId: string | null;
  lotVersion: number;
  slots: StaffSlotEvent[];
  counts: Omit<LotCounts, 'lotId' | 'lotVersion'>;
  connection: ConnectionState;
  /** True until the first snapshot lands: the grid must not render guesses. */
  loading: boolean;
}

const EMPTY_COUNTS = { free: 0, reserved: 0, occupied: 0, overstay: 0, outOfService: 0 };

/** Grid order: zone, then row, then column. Matches the server's ORDER BY. */
function compareSlots(a: StaffSlotEvent, b: StaffSlotEvent): number {
  return a.zone.localeCompare(b.zone) || a.gridRow - b.gridRow || a.gridCol - b.gridCol;
}

export class RealtimeStore {
  private state: RealtimeState = {
    lotId: null,
    lotVersion: -1,
    slots: [],
    counts: { ...EMPTY_COUNTS },
    connection: 'connecting',
    loading: true,
  };

  /**
   * Events that arrived before the snapshot.
   *
   * Held rather than dropped: an event that arrives during the fetch may well
   * be NEWER than the snapshot, and dropping it would leave that slot stale
   * until its next change. Once the snapshot lands, the version comparison
   * sorts the newer ones from the stale ones.
   */
  private pending: StaffSlotEvent[] = [];

  private listeners = new Set<(state: RealtimeState) => void>();

  getState(): RealtimeState {
    return this.state;
  }

  subscribe(listener: (state: RealtimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(next: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  setConnection(connection: ConnectionState): void {
    this.emit({ connection });
  }

  /**
   * A reconnect invalidates everything: events may have been missed while the
   * socket was down, so the grid goes back to loading and waits for a fresh
   * snapshot rather than showing a view that quietly stopped updating.
   *
   * The version goes back to -1, not 0. Zero is a real version — a lot that
   * has never had a booking — and treating it as "no snapshot" would make a
   * brand-new lot's first event (version 1) look comparable against a
   * snapshot that does not exist.
   */
  reset(): void {
    this.pending = [];
    this.emit({
      lotVersion: -1,
      slots: [],
      counts: { ...EMPTY_COUNTS },
      loading: true,
      connection: 'reconnecting',
    });
  }

  applySnapshot(snapshot: StaffSnapshot): void {
    const slots = [...snapshot.slots].sort(compareSlots);
    this.state = {
      ...this.state,
      lotId: snapshot.lotId,
      lotVersion: snapshot.lotVersion,
      slots,
      counts: countSlots(slots),
      loading: false,
    };

    // Drain in arrival order. Each one is re-checked against the snapshot
    // version, so the stale ones fall away here.
    const buffered = this.pending;
    this.pending = [];
    for (const event of buffered) this.mergeSlot(event);

    this.emit({});
  }

  /**
   * Returns whether the event was applied — the store's own tests assert on
   * this rather than inferring it from the rendered grid.
   */
  applySlotEvent(event: StaffSlotEvent): boolean {
    if (this.state.loading) {
      this.pending.push(event);
      return false;
    }
    const applied = this.mergeSlot(event);
    if (applied) this.emit({});
    return applied;
  }

  private mergeSlot(event: StaffSlotEvent): boolean {
    // THE RULE. Strictly greater: an event at the snapshot's own version is
    // already reflected in it.
    if (event.lotVersion <= this.state.lotVersion) return false;

    // An event for another lot is not ours to apply; the socket may still be
    // in the old room for a moment after switching lots.
    if (this.state.lotId !== null && event.lotId !== this.state.lotId) return false;

    const index = this.state.slots.findIndex((slot) => slot.slotId === event.slotId);
    if (index === -1) {
      // A slot the snapshot did not contain — added since. Insert it in grid
      // order rather than appending, so the layout does not jump.
      const slots = [...this.state.slots, event].sort(compareSlots);
      this.state = {
        ...this.state,
        slots,
        counts: countSlots(slots),
        lotVersion: event.lotVersion,
      };
      return true;
    }

    const slots = [...this.state.slots];
    slots[index] = event;
    this.state = {
      ...this.state,
      slots,
      counts: countSlots(slots),
      /*
       * The lot version advances to the applied event's.
       *
       * This is what makes the rule hold for a BURST: versions 42, 43, 44 all
       * arriving after a snapshot at 41 are each applied and each move the
       * watermark forward, while a straggler at 39 is still rejected against
       * 41. It also makes re-delivery of an already-applied event a no-op.
       */
      lotVersion: event.lotVersion,
    };
    return true;
  }
}
