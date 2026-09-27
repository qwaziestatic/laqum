import { z } from 'zod';
import { bookingSourceSchema, bookingStatusSchema, slotDisplayStatusSchema } from './enums.js';

/**
 * The realtime contract.
 *
 * ORDERING. Every event carries `lotVersion`, the value of lots.version
 * produced by the change that emitted it, and every snapshot carries the lot
 * version it was read at. A client applies an event only when
 * `event.lotVersion > snapshot.lotVersion`.
 *
 * It is deliberately NOT `updated_at`:
 *   - a FREE slot has no live booking, so slot_status.updated_at is NULL and
 *     there is nothing on the snapshot side to compare a stale event against;
 *   - across two API instances, updated_at comes from two wall clocks, which
 *     are not mutually ordered.
 * lots.version is incremented inside the same transaction as the change, so
 * the row lock puts it in COMMIT order. See db/migrations/003_lot_version.ts.
 *
 * AUDIENCE. The payload shape is bound to the ROOM, not filtered per socket.
 * PublicSlotEvent has no plate and no booking id to leak: a staff payload
 * cannot be assigned where a public one is expected, so the separation is a
 * compile error rather than a code review.
 */

export const REALTIME_EVENTS = ['slot.updated', 'lot.counts', 'booking.updated'] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

/** Client -> server. The only message a client may send. */
export const SUBSCRIBE_EVENT = 'subscribe';
export const SUBSCRIBED_EVENT = 'subscribed';

// ─── Rooms ────────────────────────────────────────────────────────────────

/**
 * Room names are built here and NEVER from client-supplied text, so a client
 * cannot name its way into an audience it is not entitled to.
 */
export function staffRoom(lotId: string): string {
  return `lot:${lotId}:staff`;
}

export function publicRoom(lotId: string): string {
  return `lot:${lotId}:public`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export const AUDIENCES = ['staff', 'public'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const subscribeSchema = z.object({
  lotId: z.uuid(),
  /** 'staff' requires lot_staff membership, re-checked on every subscribe. */
  audience: z.enum(AUDIENCES),
});
export type SubscribeRequest = z.infer<typeof subscribeSchema>;

export const subscribedSchema = z.object({
  lotId: z.uuid(),
  audience: z.enum(AUDIENCES),
  /** The lot version at the moment of joining, for reference. */
  lotVersion: z.int().nonnegative(),
});
export type SubscribedAck = z.infer<typeof subscribedSchema>;

// ─── Slot events ──────────────────────────────────────────────────────────

const slotBase = {
  lotId: z.uuid(),
  lotVersion: z.int().nonnegative(),
  slotId: z.uuid(),
  label: z.string(),
  zone: z.string(),
  gridRow: z.int().nonnegative(),
  gridCol: z.int().nonnegative(),
  appBookable: z.boolean(),
  inService: z.boolean(),
  displayStatus: slotDisplayStatusSchema,
};

/** What a DRIVER may see: occupancy, never who or until when. */
export const publicSlotEventSchema = z.object(slotBase);
export type PublicSlotEvent = z.infer<typeof publicSlotEventSchema>;

/** What an ATTENDANT sees: the operational detail needed at the gate. */
export const staffSlotEventSchema = z.object({
  ...slotBase,
  bookingId: z.uuid().nullable(),
  source: bookingSourceSchema.nullable(),
  vehiclePlate: z.string().nullable(),
  holdExpiresAt: z.iso.datetime().nullable(),
  plannedEndAt: z.iso.datetime().nullable(),
});
export type StaffSlotEvent = z.infer<typeof staffSlotEventSchema>;

/** Fields a public payload must never contain, asserted by tests. */
export const STAFF_ONLY_FIELDS = [
  'bookingId',
  'source',
  'vehiclePlate',
  'holdExpiresAt',
  'plannedEndAt',
] as const;

// ─── Counts ───────────────────────────────────────────────────────────────

export const lotCountsSchema = z.object({
  lotId: z.uuid(),
  lotVersion: z.int().nonnegative(),
  free: z.int().nonnegative(),
  reserved: z.int().nonnegative(),
  occupied: z.int().nonnegative(),
  overstay: z.int().nonnegative(),
  outOfService: z.int().nonnegative(),
});
export type LotCounts = z.infer<typeof lotCountsSchema>;

// ─── Booking events (user room) ───────────────────────────────────────────

/** Sent only to user:{id}: the driver's own booking, so detail is theirs. */
export const bookingUpdatedSchema = z.object({
  bookingId: z.uuid(),
  lotId: z.uuid(),
  lotVersion: z.int().nonnegative(),
  status: bookingStatusSchema,
  slotId: z.uuid(),
  holdExpiresAt: z.iso.datetime().nullable(),
  plannedEndAt: z.iso.datetime().nullable(),
  amountDueSantim: z.int().nullable(),
});
export type BookingUpdated = z.infer<typeof bookingUpdatedSchema>;

// ─── Snapshots ────────────────────────────────────────────────────────────

/**
 * A snapshot always carries the version it was read at, so the client has
 * something to compare buffered events against even when every slot is free.
 */
export const staffSnapshotSchema = z.object({
  lotId: z.uuid(),
  lotVersion: z.int().nonnegative(),
  slots: z.array(staffSlotEventSchema),
});
export type StaffSnapshot = z.infer<typeof staffSnapshotSchema>;

export const publicSnapshotSchema = z.object({
  lotId: z.uuid(),
  lotVersion: z.int().nonnegative(),
  slots: z.array(publicSlotEventSchema),
});
export type PublicSnapshot = z.infer<typeof publicSnapshotSchema>;

/** Counts derived from slot rows, so the header cannot disagree with the grid. */
export function countSlots(
  slots: { displayStatus: string }[],
): Omit<LotCounts, 'lotId' | 'lotVersion'> {
  const counts = { free: 0, reserved: 0, occupied: 0, overstay: 0, outOfService: 0 };
  for (const slot of slots) {
    if (slot.displayStatus === 'free') counts.free++;
    else if (slot.displayStatus === 'reserved') counts.reserved++;
    else if (slot.displayStatus === 'occupied') counts.occupied++;
    else if (slot.displayStatus === 'overstay') counts.overstay++;
    else if (slot.displayStatus === 'out_of_service') counts.outOfService++;
  }
  return counts;
}

// ─── A handshake refused for rate ──────────────────────────────────────────

/**
 * The server's reason when it refuses a socket handshake for rate. It is
 * TERMINAL for socket.io-client (a middleware refusal destroys the socket
 * and is never retried by itself, verified in 4.8.3), so both clients handle
 * it themselves: they wait, and try again.
 */
export const SOCKET_RATE_LIMITED = 'RATE_LIMITED';

/** What the refusal carries: how long until the window that refused it ends. */
export interface SocketRefusalData {
  retryAfterMs: number;
}

const MIN_SOCKET_RETRY_MS = 1_000;
const MAX_SOCKET_RETRY_MS = 60_000;

/**
 * When to try a refused handshake again: after the server's `retryAfterMs`,
 * plus a random share of it again. The jitter is the point: clients refused
 * together (a reconnect storm after a deploy, many phones behind one carrier
 * address) must not all come back at the same instant and be refused
 * together again. Bounded, so a missing or absurd value cannot stall a client
 * or hammer the server.
 */
export function socketRetryDelayMs(data: unknown, random: () => number = Math.random): number {
  const offered =
    typeof data === 'object' && data !== null && 'retryAfterMs' in data
      ? Number(data.retryAfterMs)
      : Number.NaN;
  const base = Number.isFinite(offered)
    ? Math.min(MAX_SOCKET_RETRY_MS, Math.max(MIN_SOCKET_RETRY_MS, offered))
    : 5_000;
  return Math.round(base + random() * base);
}
