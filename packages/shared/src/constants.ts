/** Everything is stored as timestamptz in UTC and displayed in this zone. */
export const DISPLAY_TIMEZONE = 'Africa/Addis_Ababa';

/** Money is integer santim everywhere: in the DB, on the wire, and in code. */
export const SANTIM_PER_BIRR = 100;

/** The two locales shipped from day one. `am` is the default for drivers. */
export const LOCALES = ['am', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'am';

/**
 * Short codes are the manual fallback when a QR scan fails. The alphabet
 * excludes 0/O and 1/I because attendants read these aloud across a lot.
 * Must stay identical to the CHECK constraint on bookings.short_code:
 *   short_code ~ '^[A-HJ-NP-Z2-9]{6}$'
 */
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHORT_CODE_LENGTH = 6;
export const SHORT_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * The booking radius: how far from a lot a driver may book a slot.
 *
 * APPROVED DEVIATION from the brief's 10 km (CLAUDE.md, "Booking radius").
 * Sized to what is reachable within the 15-minute hold: at 15-20 km/h in
 * Addis traffic that is about 5 km, while 10 km means 30-40 minutes and
 * holds that expire before arrival.
 */
export const DEFAULT_BOOKING_RADIUS_M = 5_000;

/**
 * The smallest radius an operator may set: five times the worst position
 * accuracy the device pass saw (±197 m), so the "need a better fix" band of
 * the location gate cannot cover the whole lot. An admin-API rule, not a
 * database constraint: the development seed's TEST LOT is deliberately
 * smaller, so walking a block flips the gate.
 */
export const MIN_BOOKING_RADIUS_M = 1_000;
