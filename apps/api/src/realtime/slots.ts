import type { Database } from '@laqum/db';
import {
  type PublicSlotEvent,
  type PublicSnapshot,
  type StaffSlotEvent,
  type StaffSnapshot,
  slotDisplayStatusSchema,
} from '@laqum/shared';
import type { Kysely, Selectable } from 'kysely';
import { currentLotVersion } from '../bookings/transition.js';

/**
 * slot_status rows -> realtime payloads.
 *
 * ONE mapper for both the snapshot and the event. If the snapshot and the
 * events had separate conversions, the client would be merging two subtly
 * different shapes and any divergence would show up as a slot that never
 * updates — so they share this code rather than agreeing by convention.
 */

export type SlotStatusRow = Selectable<Database['slot_status']>;

/** Exactly the columns a driver may be shown. */
export type PublicSlotRow = Pick<
  SlotStatusRow,
  | 'slot_id'
  | 'label'
  | 'zone'
  | 'grid_row'
  | 'grid_col'
  | 'app_bookable'
  | 'in_service'
  | 'display_status'
>;

/**
 * Every column of the view is nullable because it LEFT JOINs. In practice a
 * row always has a slot (the join starts there), so a missing slot_id means
 * something is wrong rather than something is free, and the row is dropped.
 */
function baseFields(row: PublicSlotRow, lotId: string, lotVersion: number) {
  if (row.slot_id === null) return null;
  return {
    lotId,
    lotVersion,
    slotId: row.slot_id,
    label: row.label ?? '',
    zone: row.zone ?? '',
    gridRow: row.grid_row ?? 0,
    gridCol: row.grid_col ?? 0,
    appBookable: row.app_bookable ?? false,
    inService: row.in_service ?? false,
    displayStatus: slotDisplayStatusSchema.parse(row.display_status ?? 'free'),
  };
}

/** What a DRIVER may see. No plate, no booking id, no deadlines. */
export function toPublicSlot(
  row: PublicSlotRow,
  lotId: string,
  lotVersion: number,
): PublicSlotEvent | null {
  return baseFields(row, lotId, lotVersion);
}

/** What an ATTENDANT sees. */
export function toStaffSlot(
  row: SlotStatusRow,
  lotId: string,
  lotVersion: number,
): StaffSlotEvent | null {
  const base = baseFields(row, lotId, lotVersion);
  if (!base) return null;
  return {
    ...base,
    bookingId: row.booking_id,
    source: row.source,
    vehiclePlate: row.vehicle_plate,
    holdExpiresAt: row.hold_expires_at?.toISOString() ?? null,
    plannedEndAt: row.planned_end_at?.toISOString() ?? null,
  };
}

/**
 * The grid order: zone, then row, then column. Shared so the snapshot and the
 * dashboard's own sort cannot disagree about what "first" means.
 */
function orderedSlots(db: Kysely<Database>, lotId: string) {
  return db
    .selectFrom('slot_status')
    .where('lot_id', '=', lotId)
    .orderBy('zone')
    .orderBy('grid_row')
    .orderBy('grid_col');
}

/**
 * READ THE VERSION FIRST, THEN THE ROWS.
 *
 * This ordering is the whole correctness argument, and it is worth being
 * explicit about which way it fails.
 *
 * Version first: a change committing between the two reads is INCLUDED in the
 * rows but NOT reflected in the version. The client therefore believes its
 * snapshot is older than it is, and re-applies the event for that change when
 * it arrives. Applying an event whose effect is already present is idempotent
 * — the slot is set to the state it is already in.
 *
 * Rows first would fail the other way: the change would be MISSING from the
 * rows but covered by the version, so the client would discard the only event
 * that would have told it — and the slot would stay wrong until the next
 * change to that slot, which may be hours.
 *
 * So the read order is chosen for the direction of its failure, not for
 * neatness.
 */
export async function staffSnapshot(db: Kysely<Database>, lotId: string): Promise<StaffSnapshot> {
  const lotVersion = await currentLotVersion(db, lotId);
  const rows = await orderedSlots(db, lotId).selectAll().execute();
  return {
    lotId,
    lotVersion,
    slots: rows.flatMap((row) => {
      const slot = toStaffSlot(row, lotId, lotVersion);
      return slot ? [slot] : [];
    }),
  };
}

export async function publicSnapshot(db: Kysely<Database>, lotId: string): Promise<PublicSnapshot> {
  const lotVersion = await currentLotVersion(db, lotId);
  /*
   * Only the public columns are SELECTed. The privacy of this payload is a
   * property of the query, not of a mapper that has to remember to drop
   * fields: vehicle_plate never leaves the database on this path at all.
   */
  const rows = await orderedSlots(db, lotId)
    .select([
      'slot_id',
      'label',
      'zone',
      'grid_row',
      'grid_col',
      'app_bookable',
      'in_service',
      'display_status',
    ])
    .execute();
  return {
    lotId,
    lotVersion,
    slots: rows.flatMap((row) => {
      const slot = toPublicSlot(row, lotId, lotVersion);
      return slot ? [slot] : [];
    }),
  };
}
