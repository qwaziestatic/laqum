import { type LotCounts, type StaffSlotEvent, type StaffSnapshot, countSlots } from './realtime.js';

/**
 * The client side of the ordering rule.
 *
 * A socket connects and starts delivering events immediately, while the
 * snapshot is still being fetched over HTTP. Those two streams are racing, so
 * something has to decide which events the snapshot already accounts for.
 *
 * THE RULE, per slot:
 *
 *   apply iff event.lotVersion > max(snapshotVersion, lastAppliedTo[slotId])
 *
 * WHY PER SLOT, NOT LOT-WIDE. lots.version is a total order over the LOT, but
 * delivery is not. With two API instances, instance A can publish v7 for slot
 * X and instance B publish v6 for slot Y, and the two can reach one client in
 * either order — the version is commit-ordered, the network is not.
 *
 * A single lot-wide high-water mark drops the loser: after applying v7 the
 * mark is 7, so v6 for a DIFFERENT slot is discarded, and slot Y keeps
 * whatever the snapshot said until its next change — possibly hours. The
 * watermark therefore belongs to the slot it concerns. The snapshot version
 * remains a floor under all of them, because the snapshot covered every slot.
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
  /** The version the SNAPSHOT was read at. A floor, never a running maximum. */
  snapshotVersion: number;
  /** The newest version applied to any slot, for display and debugging only. */
  highestApplied: number;
  slots: StaffSlotEvent[];
  counts: Omit<LotCounts, 'lotId' | 'lotVersion'>;
  connection: ConnectionState;
  /** True until the first snapshot lands: the grid must not render guesses. */
  loading: boolean;
}

const EMPTY_COUNTS = { free: 0, reserved: 0, occupied: 0, overstay: 0, outOfService: 0 };

/** No snapshot yet. Below zero, which is a REAL version (a lot with no bookings). */
const NO_SNAPSHOT = -1;

/** Grid order: zone, then row, then column. Matches the server's ORDER BY. */
function compareSlots(a: StaffSlotEvent, b: StaffSlotEvent): number {
  return a.zone.localeCompare(b.zone) || a.gridRow - b.gridRow || a.gridCol - b.gridCol;
}

export class RealtimeStore {
  private state: RealtimeState = {
    lotId: null,
    snapshotVersion: NO_SNAPSHOT,
    highestApplied: NO_SNAPSHOT,
    slots: [],
    counts: { ...EMPTY_COUNTS },
    connection: 'connecting',
    loading: true,
  };

  /**
   * The last version applied to each slot.
   *
   * Not part of RealtimeState: it is bookkeeping, not something rendered, and
   * putting it in state would invite a component to read it and re-derive
   * something the slots already say.
   */
  private appliedTo = new Map<string, number>();

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

  /** The version bar a slot's next event must clear. Exposed for tests. */
  floorFor(slotId: string): number {
    return Math.max(this.state.snapshotVersion, this.appliedTo.get(slotId) ?? NO_SNAPSHOT);
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
   * The per-slot watermarks are cleared too. They are only meaningful relative
   * to a snapshot, and keeping them would let a stale watermark reject a valid
   * event after the new snapshot arrives.
   */
  reset(): void {
    this.pending = [];
    this.appliedTo.clear();
    this.emit({
      snapshotVersion: NO_SNAPSHOT,
      highestApplied: NO_SNAPSHOT,
      slots: [],
      counts: { ...EMPTY_COUNTS },
      loading: true,
      connection: 'reconnecting',
    });
  }

  applySnapshot(snapshot: StaffSnapshot): void {
    const slots = [...snapshot.slots].sort(compareSlots);
    // The snapshot is authoritative for every slot at its version, so it
    // replaces the per-slot watermarks rather than merging with them.
    this.appliedTo.clear();
    this.state = {
      ...this.state,
      lotId: snapshot.lotId,
      snapshotVersion: snapshot.lotVersion,
      highestApplied: snapshot.lotVersion,
      slots,
      counts: countSlots(slots),
      loading: false,
    };

    // Drain in arrival order. Each one is re-checked against its own slot's
    // floor, so the stale ones fall away here.
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
    // An event for another lot is not ours to apply; the socket may still be
    // in the old room for a moment after switching lots.
    if (this.state.lotId !== null && event.lotId !== this.state.lotId) return false;

    /*
     * THE RULE. Strictly greater than THIS SLOT's floor.
     *
     * Strictly, because an event at the snapshot's own version is already
     * reflected in it. Per slot, because out-of-order delivery across
     * instances is normal and a v6 for another slot must not be collateral
     * damage from a v7 applied here.
     */
    if (event.lotVersion <= this.floorFor(event.slotId)) return false;

    const index = this.state.slots.findIndex((slot) => slot.slotId === event.slotId);
    const slots =
      index === -1
        ? // A slot the snapshot did not contain — added since. Inserted in grid
          // order rather than appended, so the layout does not jump.
          [...this.state.slots, event].sort(compareSlots)
        : this.state.slots.with(index, event);

    this.appliedTo.set(event.slotId, event.lotVersion);
    this.state = {
      ...this.state,
      slots,
      // Counts are DERIVED from the slots on every change, never kept as
      // running totals. A separate tally can drift from the grid it labels,
      // and a header that disagrees with the grid is worse than no header.
      counts: countSlots(slots),
      highestApplied: Math.max(this.state.highestApplied, event.lotVersion),
    };
    return true;
  }
}
