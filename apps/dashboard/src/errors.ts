import type { ErrorCode } from '@laqum/shared';
import type { TFunction } from 'i18next';
import type { ApiError } from './api/client.js';

/**
 * What an attendant reads when a request fails, in their language.
 *
 * The API's `message` is developer English and is NEVER shown (shared
 * errors.ts): the dashboard used to fall back to it for any code without a
 * translation, which put server English on an Amharic screen. Every code
 * now has its own text: a Record over ErrorCode, so a code added to the API
 * does not compile here until it has a key, and i18n.test.ts checks every
 * key has text in both bundles.
 */

type ErrorKey = `error.${ErrorCode | ClientErrorCode}`;

/** Failures that never reached the server, or came back unreadable (api/client.ts). */
export const CLIENT_ERROR_CODES = ['NETWORK', 'BAD_RESPONSE', 'UNKNOWN'] as const;
type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export const ERROR_KEYS: Record<ErrorCode | ClientErrorCode, ErrorKey> = {
  VALIDATION_ERROR: 'error.VALIDATION_ERROR',
  OTP_INVALID: 'error.OTP_INVALID',
  OTP_EXPIRED: 'error.OTP_EXPIRED',
  UNAUTHENTICATED: 'error.UNAUTHENTICATED',
  FORBIDDEN: 'error.FORBIDDEN',
  NOT_FOUND: 'error.NOT_FOUND',
  SLOT_TAKEN: 'error.SLOT_TAKEN',
  LOT_FULL: 'error.LOT_FULL',
  STATE_CONFLICT: 'error.STATE_CONFLICT',
  OUTSTANDING_BALANCE: 'error.OUTSTANDING_BALANCE',
  SLOT_IN_USE: 'error.SLOT_IN_USE',
  ILLEGAL_TRANSITION: 'error.ILLEGAL_TRANSITION',
  ALREADY_HAS_ACTIVE_BOOKING: 'error.ALREADY_HAS_ACTIVE_BOOKING',
  ALREADY_PAID: 'error.ALREADY_PAID',
  PAYMENT_AMOUNT_MISMATCH: 'error.PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_NOT_CONFIRMED: 'error.PAYMENT_NOT_CONFIRMED',
  PAYMENT_PENDING: 'error.PAYMENT_PENDING',
  TOO_FAR: 'error.TOO_FAR',
  RATE_LIMITED: 'error.RATE_LIMITED',
  OTP_TOO_MANY_ATTEMPTS: 'error.OTP_TOO_MANY_ATTEMPTS',
  INTERNAL: 'error.INTERNAL',
  PROVIDER_UNAVAILABLE: 'error.PROVIDER_UNAVAILABLE',
  NETWORK: 'error.NETWORK',
  BAD_RESPONSE: 'error.BAD_RESPONSE',
  UNKNOWN: 'error.UNKNOWN',
};

function isKnownCode(code: string): code is keyof typeof ERROR_KEYS {
  return Object.hasOwn(ERROR_KEYS, code);
}

/** The translation key for a failure; an unrecognised code is a generic apology. */
export function errorKey(error: Pick<ApiError, 'code'>): ErrorKey {
  return isKnownCode(error.code) ? ERROR_KEYS[error.code] : ERROR_KEYS.UNKNOWN;
}

export function errorText(t: TFunction, error: Pick<ApiError, 'code'>): string {
  return t(errorKey(error));
}
