import type { ErrorCode } from '@laqum/shared';
import { type MessageKey, type Phrase, phrase } from '../i18n/core.js';
import type { ApiError } from './client.js';

/**
 * What the DRIVER reads when a request fails, in their language.
 *
 * The API's `message` is developer English and is never shown (shared
 * errors.ts says so; the device test showed "Request validation failed" on
 * the Book screen). The CODE decides the text. A Record over every
 * ErrorCode, so a code added to the API does not compile here until it has
 * driver text in both languages.
 */

const API_ERRORS: Record<ErrorCode, MessageKey> = {
  VALIDATION_ERROR: 'errors.VALIDATION_ERROR',
  OTP_INVALID: 'errors.OTP_INVALID',
  OTP_EXPIRED: 'errors.OTP_EXPIRED',
  UNAUTHENTICATED: 'errors.UNAUTHENTICATED',
  FORBIDDEN: 'errors.FORBIDDEN',
  NOT_FOUND: 'errors.NOT_FOUND',
  SLOT_TAKEN: 'errors.SLOT_TAKEN',
  LOT_FULL: 'errors.LOT_FULL',
  STATE_CONFLICT: 'errors.STATE_CONFLICT',
  OUTSTANDING_BALANCE: 'errors.OUTSTANDING_BALANCE',
  SLOT_IN_USE: 'errors.SLOT_IN_USE',
  ILLEGAL_TRANSITION: 'errors.ILLEGAL_TRANSITION',
  ALREADY_HAS_ACTIVE_BOOKING: 'errors.ALREADY_HAS_ACTIVE_BOOKING',
  ALREADY_PAID: 'errors.ALREADY_PAID',
  PAYMENT_AMOUNT_MISMATCH: 'errors.PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_NOT_CONFIRMED: 'errors.PAYMENT_NOT_CONFIRMED',
  PAYMENT_PENDING: 'errors.PAYMENT_PENDING',
  TOO_FAR: 'errors.TOO_FAR',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  OTP_TOO_MANY_ATTEMPTS: 'errors.OTP_TOO_MANY_ATTEMPTS',
  INTERNAL: 'errors.INTERNAL',
  PROVIDER_UNAVAILABLE: 'errors.PROVIDER_UNAVAILABLE',
};

/** Failures that never reached the server, or came back unreadable (client.ts). */
const CLIENT_ERRORS: Readonly<Record<string, MessageKey>> = {
  NETWORK: 'errors.NETWORK',
  BAD_RESPONSE: 'errors.BAD_RESPONSE',
};

/** Fields a driver types, and what to tell them when one is rejected. */
const FIELD_ERRORS: Readonly<Record<string, MessageKey>> = {
  vehiclePlate: 'errors.field.vehiclePlate',
  phone: 'errors.field.phone',
  code: 'errors.field.code',
};

function issuePaths(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('issues' in details)) return [];
  const { issues } = details;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) =>
    typeof issue === 'object' && issue !== null && 'path' in issue && typeof issue.path === 'string'
      ? [issue.path]
      : [],
  );
}

function isApiErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(API_ERRORS, code);
}

export function errorPhrase(error: ApiError): Phrase {
  if (error.code === 'VALIDATION_ERROR') {
    // The first rejected field the driver can do something about. Anything
    // else was built by the app, so there is nothing for them to correct.
    const field = issuePaths(error.details)
      .map((path) => FIELD_ERRORS[path])
      .find((key) => key !== undefined);
    return phrase(field ?? 'errors.VALIDATION_ERROR');
  }
  if (isApiErrorCode(error.code)) return phrase(API_ERRORS[error.code]);
  return phrase(CLIENT_ERRORS[error.code] ?? 'errors.UNKNOWN');
}
