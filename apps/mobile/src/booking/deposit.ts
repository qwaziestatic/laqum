import type { BookingStatus, CreateBookingResponse, PayDepositResponse } from '@laqum/shared';
import type { ApiResult } from '../api/client.js';

/**
 * What the screens do with a deposit, decided here so it can be tested
 * without rendering them.
 *
 * The deposit starts with the booking. When the payment service cannot be
 * reached the booking still stands in PENDING_PAYMENT with no checkout, and
 * the driver retries with "Pay deposit" before the payment window lapses.
 */

/** Booked, but the deposit did not start. Shown on arrival at the booking screen. */
export const DEPOSIT_NOT_STARTED =
  'Your slot is held while you pay, but the payment service could not be reached. Tap Pay deposit before the timer runs out.';

/** "Pay deposit" failed to reach the payment service. */
export const DEPOSIT_UNAVAILABLE =
  'The payment service could not be reached. Your slot is held until the timer runs out. Try again in a moment.';

/** The query flag the Book screen sets when the deposit did not start. */
export const DEPOSIT_NOT_STARTED_PARAM = 'unavailable' as const;

/**
 * The booking screen's route params: /booking/[id]. A type, not an interface:
 * expo-router's params need the implicit index signature only a type alias has.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type BookingRouteParams = {
  id: string;
  deposit?: typeof DEPOSIT_NOT_STARTED_PARAM;
};

/**
 * Where the Book screen goes once the booking exists, and whether it first
 * opens a checkout.
 */
export function afterBooking(created: CreateBookingResponse): {
  checkoutUrl: string | null;
  params: BookingRouteParams;
} {
  const id = created.booking.id;
  if (!created.paymentRequired) return { checkoutUrl: null, params: { id } };
  if (created.checkoutUrl !== null) return { checkoutUrl: created.checkoutUrl, params: { id } };
  return { checkoutUrl: null, params: { id, deposit: DEPOSIT_NOT_STARTED_PARAM } };
}

export type DepositAttempt =
  | { kind: 'open'; checkoutUrl: string }
  /** The booking moved on (paid meanwhile, or expired): refetch, no error. */
  | { kind: 'refresh' }
  | { kind: 'error'; message: string };

/** What a tap on "Pay deposit" leads to. */
export function depositAttempt(result: ApiResult<PayDepositResponse>): DepositAttempt {
  if (result.ok) return { kind: 'open', checkoutUrl: result.data.checkoutUrl };

  switch (result.error.code) {
    // Paid already (a lost webhook, now settled) or no longer payable: the
    // booking itself says what happened.
    case 'ALREADY_PAID':
    case 'STATE_CONFLICT':
      return { kind: 'refresh' };
    case 'PROVIDER_UNAVAILABLE':
      return { kind: 'error', message: DEPOSIT_UNAVAILABLE };
    default:
      return { kind: 'error', message: result.error.message };
  }
}

/**
 * Ask the payment service directly on (re)entering the screen, rather than
 * wait for the webhook, which usually lands seconds after the driver returns
 * from the checkout. Only while payment is pending: nothing else has a
 * deposit to check.
 */
export function verifiesDeposit(status: BookingStatus): boolean {
  return status === 'PENDING_PAYMENT';
}
