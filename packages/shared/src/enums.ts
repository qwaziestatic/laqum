import { z } from 'zod';

/**
 * These mirror the PostgreSQL enum types created in db/migrations/001_initial.ts.
 * The DDL is the source of truth; apps/api/test/schema.test.ts asserts that the
 * labels below and the labels in `pg_enum` are identical, so a drift in either
 * direction fails CI rather than surfacing at runtime.
 */

export const USER_ROLES = ['driver', 'attendant', 'operator_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

/**
 * The roles that may use the attendant dashboard. One definition: the staff
 * routes require these, and the OTP "staff" audience admits only these, so
 * the two cannot disagree about who is staff.
 */
export const STAFF_ROLES = ['attendant', 'operator_admin'] as const satisfies readonly UserRole[];
export type StaffRole = (typeof STAFF_ROLES)[number];

const STAFF_ROLE_SET: ReadonlySet<UserRole> = new Set<UserRole>(STAFF_ROLES);

export function isStaffRole(role: UserRole): role is StaffRole {
  return STAFF_ROLE_SET.has(role);
}

export const BOOKING_SOURCES = ['app', 'walk_in'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];
export const bookingSourceSchema = z.enum(BOOKING_SOURCES);

export const BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'RESERVED',
  'CHECKED_IN',
  'OVERSTAY',
  'CHECKED_OUT',
  'PAID',
  'EXPIRED',
  'CANCELLED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

export const PAYMENT_KINDS = ['deposit', 'final', 'refund'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const paymentKindSchema = z.enum(PAYMENT_KINDS);

export const PAYMENT_PROVIDERS = ['chapa', 'telebirr', 'cash'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

/**
 * 'superseded' (migration 002) means the provider collected the money but our
 * ledger could not apply it to the booking, because one_paid_final_per_booking
 * permits only one successful final payment. It is NOT 'failed': the driver
 * was charged, and the amount is owed back. Order matters — ALTER TYPE ADD
 * VALUE appends, so 'superseded' is last.
 */
export const PAYMENT_STATUSES = ['pending', 'success', 'failed', 'superseded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * THE live-status list. This is the one place it is written down.
 *
 * It must stay identical to the `status IN (...)` lists in the partial indexes
 * (one_live_booking_per_slot, one_live_booking_per_user,
 * one_live_booking_per_short_code, bookings_live_by_lot) and in the
 * slot_status view. apps/api/test/schema.test.ts asserts exactly that by
 * parsing the index predicates out of pg_indexes.
 *
 * Derive from this; never re-type the list.
 */
export const LIVE_STATUSES = [
  'PENDING_PAYMENT',
  'RESERVED',
  'CHECKED_IN',
  'OVERSTAY',
] as const satisfies readonly BookingStatus[];

export type LiveBookingStatus = (typeof LIVE_STATUSES)[number];

const LIVE_STATUS_SET: ReadonlySet<BookingStatus> = new Set<BookingStatus>(LIVE_STATUSES);

/** A booking that currently holds its slot. */
export function isLiveStatus(status: BookingStatus): status is LiveBookingStatus {
  return LIVE_STATUS_SET.has(status);
}

/** Every status that is not live: the booking has released its slot. */
export const TERMINAL_STATUSES = BOOKING_STATUSES.filter(
  (s): s is Exclude<BookingStatus, LiveBookingStatus> => !isLiveStatus(s),
);

/**
 * The `display_status` values produced by the slot_status view. Derived from
 * the view's CASE expression, which the schema test pins.
 */
export const SLOT_DISPLAY_STATUSES = [
  'free',
  'reserved',
  'occupied',
  'overstay',
  'out_of_service',
] as const;
export type SlotDisplayStatus = (typeof SLOT_DISPLAY_STATUSES)[number];
export const slotDisplayStatusSchema = z.enum(SLOT_DISPLAY_STATUSES);
