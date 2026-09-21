/**
 * The error model.
 *
 * Every failure crossing the API boundary carries a stable machine-readable
 * code. Clients switch on the code and render their own translated string —
 * `message` here is developer-facing English and is never shown to a user, so
 * the "no hard-coded user-facing strings" rule still holds.
 *
 * ErrorCode is a closed union so the dashboard and mobile app can map it
 * exhaustively and fail to compile when a new code appears.
 */

export const ERROR_STATUS = {
  /** Request failed zod validation. `details` carries the field errors. */
  VALIDATION_ERROR: 400,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,

  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,

  /** The slot's partial unique index rejected the insert: someone won the race. */
  SLOT_TAKEN: 409,
  /** No assignable slot after exhausting the retry budget. */
  LOT_FULL: 409,
  /** transition()'s compare-and-set matched zero rows. */
  STATE_CONFLICT: 409,
  /** Driver has an unpaid CHECKED_OUT booking. */
  OUTSTANDING_BALANCE: 409,
  /** Cannot take a slot out of service while it holds a live booking. */
  SLOT_IN_USE: 409,
  /** The (from, to) pair is not in the state machine. A programming error. */
  ILLEGAL_TRANSITION: 409,
  /** one_live_booking_per_user rejected the insert. */
  ALREADY_HAS_ACTIVE_BOOKING: 409,

  /** Beyond the lot's max_booking_distance_m. */
  TOO_FAR: 422,

  RATE_LIMITED: 429,
  OTP_TOO_MANY_ATTEMPTS: 429,

  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
