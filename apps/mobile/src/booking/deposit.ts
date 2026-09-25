import type { BookingStatus, CreateBookingResponse, PayDepositResponse } from '@laqum/shared';
import type { ApiResult } from '../api/client.js';
import { errorPhrase } from '../api/messages.js';
import { type Phrase, phrase } from '../i18n/core.js';

/**
 * What the screens do with a deposit, decided here so it can be tested
 * without rendering them.
 *
 * The deposit starts with the booking. When the payment service cannot be
 * reached the booking still stands in PENDING_PAYMENT with no checkout, and
 * the driver retries with "Pay deposit" before the payment window lapses.
 */

/**
 * THE deposit notice: one slot on the booking screen, never two.
 *
 * Session 2 on the phone showed two red boxes saying nearly the same thing
 * after a failed retry: "not started" from arrival, and the retry's failure
 * under it. A retry's outcome now REPLACES the notice (depositNoticeAfter).
 * The tone says whether the slot is still held: a WARNING when it is (the
 * deposit has not started, or the payment service is still down), an ERROR
 * for anything else.
 */
export interface DepositNotice {
  message: Phrase;
  tone: 'warn' | 'error';
}

/** Booked, but the deposit did not start. Shown on arrival: the slot is still held. */
export const DEPOSIT_NOT_STARTED: DepositNotice = {
  message: phrase('deposit.notStarted'),
  tone: 'warn',
};

/** "Pay deposit" failed to reach the payment service. The slot is still held. */
export const DEPOSIT_UNAVAILABLE: DepositNotice = {
  message: phrase('deposit.unavailable'),
  tone: 'warn',
};

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
  /** It failed: this notice replaces whatever was showing. */
  | { kind: 'notice'; notice: DepositNotice };

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
      return { kind: 'notice', notice: DEPOSIT_UNAVAILABLE };
    default:
      return { kind: 'notice', notice: { message: errorPhrase(result.error), tone: 'error' } };
  }
}

/**
 * The deposit notice after a tap on "Pay deposit": the attempt's REPLACES the
 * one showing, and a checkout that opens, or a booking that moved on, clears
 * it. Never both.
 */
export function depositNoticeAfter(
  _current: DepositNotice | null,
  attempt: DepositAttempt,
): DepositNotice | null {
  return attempt.kind === 'notice' ? attempt.notice : null;
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
