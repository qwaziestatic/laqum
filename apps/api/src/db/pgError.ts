/**
 * Postgres error introspection.
 *
 * The partial unique indexes ARE the double-booking guard, so the only way to
 * learn that a race was lost is to attempt the insert and read the violation
 * back. Which index fired decides which typed error the caller gets, so the
 * constraint name matters, not just the SQLSTATE.
 */

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

export interface PgErrorInfo {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/** The constraint names this application reacts to by name. */
export const CONSTRAINTS = {
  liveBookingPerSlot: 'one_live_booking_per_slot',
  liveBookingPerUser: 'one_live_booking_per_user',
  liveBookingPerShortCode: 'one_live_booking_per_short_code',
  qrToken: 'bookings_qr_token_key',
  paidFinalPerBooking: 'one_paid_final_per_booking',
  paidDepositPerBooking: 'one_paid_deposit_per_booking',
} as const;

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Null when the error did not come from Postgres. */
export function pgErrorInfo(err: unknown): PgErrorInfo | null {
  if (typeof err !== 'object' || err === null) return null;
  const source = err as Record<string, unknown>;
  const code = readString(source, 'code');
  if (code === undefined) return null;

  const info: PgErrorInfo = { code };
  const constraint = readString(source, 'constraint');
  const detail = readString(source, 'detail');
  const table = readString(source, 'table');
  if (constraint !== undefined) info.constraint = constraint;
  if (detail !== undefined) info.detail = detail;
  if (table !== undefined) info.table = table;
  return info;
}

/** True when `err` is a unique violation, optionally of one named constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(err);
  if (info?.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || info.constraint === constraint;
}
