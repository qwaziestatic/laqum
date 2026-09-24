import type { Booking } from '@laqum/shared';
import type { BookingRow } from './transition.js';

/**
 * Wire representations.
 *
 * The database stays snake_case (it is the source of truth) while the API
 * speaks camelCase, so the mapping lives in exactly one place. Timestamps go
 * out as ISO-8601 UTC strings; clients render them in Africa/Addis_Ababa.
 */

/** The owner's view, as the SHARED bookingSchema describes it; the app parses with it. */
export type BookingDto = Booking;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * The owner's view: includes the QR token and short code, which are
 * credentials and must never appear in anyone else's response.
 */
export function toBookingDto(row: BookingRow): BookingDto {
  return {
    id: row.id,
    lotId: row.lot_id,
    slotId: row.slot_id,
    status: row.status,
    source: row.source,
    vehiclePlate: row.vehicle_plate,
    plannedMinutes: row.planned_minutes,
    qrToken: row.qr_token,
    shortCode: row.short_code,
    holdExpiresAt: iso(row.hold_expires_at),
    checkedInAt: iso(row.checked_in_at),
    plannedEndAt: iso(row.planned_end_at),
    checkedOutAt: iso(row.checked_out_at),
    amountDueSantim: row.amount_due_santim,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The attendant's view: operational fields, without the entry credentials. */
export function toStaffBookingDto(row: BookingRow): Omit<BookingDto, 'qrToken'> {
  const dto = toBookingDto(row);
  const { qrToken: _qrToken, ...rest } = dto;
  return rest;
}
