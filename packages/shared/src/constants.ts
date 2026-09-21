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
