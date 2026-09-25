import type { Booking, BookingUpdated } from '@laqum/shared';

/**
 * One booking, kept current from REST snapshots plus realtime events.
 *
 * The dashboard's rule, for a single booking (CLAUDE.md, "Realtime
 * ordering"): every snapshot carries the lot version it was read at, every
 * event the lot version its change produced, and an event applies only when
 * its version is HIGHER than what is held. The watermark advances with each
 * applied event, so a burst lands and a straggler is dropped.
 *
 * - Before the first snapshot, and after the socket (re)connects until the
 *   next one, events are BUFFERED, then drained against that snapshot. The
 *   socket joins the driver's room before the snapshot is read, so a change
 *   in between arrives twice (harmless) rather than not at all.
 * - A snapshot OLDER than the watermark is ignored: it is a response to a
 *   request sent before an event already applied, and would move the booking
 *   backwards.
 * - The watermark starts at -1, not 0: version 0 is real.
 */

/** The booking fields an event carries. Everything else never changes after creation, or is not shown. */
function merged(booking: Booking, event: BookingUpdated): Booking {
  return {
    ...booking,
    status: event.status,
    slotId: event.slotId,
    holdExpiresAt: event.holdExpiresAt,
    plannedEndAt: event.plannedEndAt,
    amountDueSantim: event.amountDueSantim,
  };
}

export class BookingFeed {
  readonly #bookingId: string;
  #booking: Booking | null = null;
  #lotVersion = -1;
  /** Held until a snapshot arrives; null when events apply directly. */
  #buffer: BookingUpdated[] | null = [];

  constructor(bookingId: string) {
    this.#bookingId = bookingId;
  }

  get booking(): Booking | null {
    return this.#booking;
  }

  get lotVersion(): number {
    return this.#lotVersion;
  }

  /** The socket (re)connected: anything may have been missed. Hold events until the next snapshot. */
  beginResync(): void {
    this.#buffer ??= [];
  }

  /** Returns true when the held booking changed. */
  applySnapshot(booking: Booking, lotVersion: number): boolean {
    if (booking.id !== this.#bookingId) return false;

    const buffered = this.#buffer ?? [];
    this.#buffer = null;

    let changed = false;
    if (lotVersion >= this.#lotVersion) {
      this.#booking = booking;
      this.#lotVersion = lotVersion;
      changed = true;
    }
    // Drained against whatever is now held: an event the snapshot already
    // includes is at or below its version and is dropped.
    for (const event of [...buffered].sort((a, b) => a.lotVersion - b.lotVersion)) {
      if (this.#apply(event)) changed = true;
    }
    return changed;
  }

  /** Returns true when the held booking changed. */
  applyEvent(event: BookingUpdated): boolean {
    if (event.bookingId !== this.#bookingId) return false;
    if (this.#buffer) {
      this.#buffer.push(event);
      return false;
    }
    return this.#apply(event);
  }

  #apply(event: BookingUpdated): boolean {
    if (!this.#booking || event.lotVersion <= this.#lotVersion) return false;
    this.#booking = merged(this.#booking, event);
    this.#lotVersion = event.lotVersion;
    return true;
  }
}
