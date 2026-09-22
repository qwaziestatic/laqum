import type { Database } from '@laqum/db';
import {
  type BookingUpdated,
  type PublicSlotEvent,
  type StaffSlotEvent,
  publicRoom,
  staffRoom,
  userRoom,
} from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Server } from 'socket.io';
import { toPublicSlot, toStaffSlot } from './slots.js';

/**
 * Turning a committed change into realtime events.
 *
 * AUDIENCE IS THE ROOM. A staff payload is emitted to the staff room and a
 * public payload to the public room; nothing is filtered per socket. Two
 * consequences worth being explicit about:
 *
 *   - the two payloads are built SEPARATELY from the same row, so the public
 *     one never holds a plate that some later code has to remember to strip;
 *   - authorisation reduces to room membership, which is checked in one place
 *     (realtime/server.ts) on every subscribe.
 *
 * INVARIANT 5. Every emit here runs after commit, registered on the existing
 * SideEffects collector. Emitting inside the transaction would announce a
 * state a rollback then erased.
 */

export const SLOT_UPDATED = 'slot.updated';
export const BOOKING_UPDATED = 'booking.updated';

export interface RealtimeEmitter {
  slotChanged(lotId: string, staff: StaffSlotEvent, pub: PublicSlotEvent): void;
  bookingChanged(userId: string, payload: unknown): void;
}

/** The real one. */
export class SocketEmitter implements RealtimeEmitter {
  readonly #io: Server;

  constructor(io: Server) {
    this.#io = io;
  }

  slotChanged(lotId: string, staff: StaffSlotEvent, pub: PublicSlotEvent): void {
    this.#io.to(staffRoom(lotId)).emit(SLOT_UPDATED, staff);
    this.#io.to(publicRoom(lotId)).emit(SLOT_UPDATED, pub);
  }

  bookingChanged(userId: string, payload: unknown): void {
    this.#io.to(userRoom(userId)).emit(BOOKING_UPDATED, payload);
  }
}

/** Records instead of emitting, so tests can assert on rooms and payloads. */
export class RecordingEmitter implements RealtimeEmitter {
  readonly slotEvents: { lotId: string; staff: StaffSlotEvent; pub: PublicSlotEvent }[] = [];
  readonly bookingEvents: { userId: string; payload: unknown }[] = [];

  slotChanged(lotId: string, staff: StaffSlotEvent, pub: PublicSlotEvent): void {
    this.slotEvents.push({ lotId, staff, pub });
  }

  bookingChanged(userId: string, payload: unknown): void {
    this.bookingEvents.push({ userId, payload });
  }

  reset(): void {
    this.slotEvents.length = 0;
    this.bookingEvents.length = 0;
  }
}

/** Emits nothing. The default, so a context without realtime still works. */
export const nullEmitter: RealtimeEmitter = {
  slotChanged: () => undefined,
  bookingChanged: () => undefined,
};

/**
 * Read the slot back and emit it, carrying the version that produced it.
 *
 * The row is re-read AFTER commit rather than assembled from the booking in
 * hand, because slot_status is a derived view: the display status depends on
 * the live booking, the slot's in_service flag and the clock, and rebuilding
 * that logic here would be a second implementation of the view that could
 * disagree with it.
 *
 * `lotVersion` comes from the transition, NOT from a re-read of lots.version.
 * A re-read would pick up a LATER change's version and label this event as
 * newer than it is, which would make a client discard the event that actually
 * carried that later state.
 */
export async function emitSlotChange(
  db: Kysely<Database>,
  emitter: RealtimeEmitter,
  args: {
    lotId: string;
    slotId: string;
    lotVersion: number;
    bookingId?: string | null;
    userId?: string | null;
  },
): Promise<void> {
  const row = await db
    .selectFrom('slot_status')
    .selectAll()
    .where('slot_id', '=', args.slotId)
    .executeTakeFirst();
  if (!row) return;

  const staff = toStaffSlot(row, args.lotId, args.lotVersion);
  const pub = toPublicSlot(row, args.lotId, args.lotVersion);
  if (!staff || !pub) return;

  emitter.slotChanged(args.lotId, staff, pub);

  /*
   * The driver's own booking, in their own room.
   *
   * Read from bookings rather than from slot_status: once a booking leaves the
   * live statuses the view no longer shows it, so a CHECKED_OUT or PAID
   * booking — exactly the ones a driver most wants to hear about — would have
   * no row to report. A walk-in has no user and so has no one to notify.
   */
  if (args.bookingId && args.userId) {
    const booking = await db
      .selectFrom('bookings')
      .select([
        'id',
        'lot_id',
        'slot_id',
        'status',
        'hold_expires_at',
        'planned_end_at',
        'amount_due_santim',
      ])
      .where('id', '=', args.bookingId)
      .executeTakeFirst();
    if (!booking) return;

    const payload: BookingUpdated = {
      bookingId: booking.id,
      lotId: booking.lot_id,
      lotVersion: args.lotVersion,
      status: booking.status,
      slotId: booking.slot_id,
      holdExpiresAt: booking.hold_expires_at?.toISOString() ?? null,
      plannedEndAt: booking.planned_end_at?.toISOString() ?? null,
      amountDueSantim: booking.amount_due_santim,
    };
    emitter.bookingChanged(args.userId, payload);
  }
}
