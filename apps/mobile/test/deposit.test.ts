import { BOOKING_STATUSES, type Booking, type CreateBookingResponse } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_UNAVAILABLE,
  afterBooking,
  depositAttempt,
  verifiesDeposit,
} from '../src/booking/deposit.js';

const BOOKING = { id: '6f1c7a52-2d0e-4f59-9b8a-2d4c1e9f0a11' } as Booking;

function created(fields: Partial<CreateBookingResponse>): CreateBookingResponse {
  return {
    booking: BOOKING,
    paymentRequired: false,
    depositAmountSantim: 0,
    checkoutUrl: null,
    ...fields,
  };
}

describe('after booking', () => {
  it('opens the checkout when the deposit started', () => {
    expect(
      afterBooking(
        created({
          paymentRequired: true,
          depositAmountSantim: 2000,
          checkoutUrl: 'https://checkout.test/pay/x',
        }),
      ),
    ).toEqual({ checkoutUrl: 'https://checkout.test/pay/x', params: { id: BOOKING.id } });
  });

  it('says so on the booking screen when the deposit could not start', () => {
    expect(afterBooking(created({ paymentRequired: true, depositAmountSantim: 2000 }))).toEqual({
      checkoutUrl: null,
      params: { id: BOOKING.id, deposit: 'unavailable' },
    });
  });

  it('goes straight to the booking when no deposit is owed', () => {
    expect(afterBooking(created({}))).toEqual({
      checkoutUrl: null,
      params: { id: BOOKING.id },
    });
  });
});

describe('a tap on Pay deposit', () => {
  it('opens the checkout the API returned', () => {
    expect(
      depositAttempt({
        ok: true,
        data: {
          checkoutUrl: 'https://checkout.test/pay/y',
          txRef: 'laqum-dep-y',
          amountSantim: 2000,
        },
      }),
    ).toEqual({ kind: 'open', checkoutUrl: 'https://checkout.test/pay/y' });
  });

  it('refetches, without an error, when the booking has moved on', () => {
    for (const code of ['ALREADY_PAID', 'STATE_CONFLICT']) {
      expect(depositAttempt({ ok: false, error: { code, message: 'x' } }), code).toEqual({
        kind: 'refresh',
      });
    }
  });

  it('explains an unreachable payment service in driver terms', () => {
    expect(
      depositAttempt({
        ok: false,
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Could not reach the payment provider' },
      }),
    ).toEqual({ kind: 'error', message: DEPOSIT_UNAVAILABLE });
  });

  it('words anything else by its error code, never the client or API message', () => {
    expect(
      depositAttempt({ ok: false, error: { code: 'NETWORK', message: 'No connection' } }),
    ).toEqual({ kind: 'error', message: { key: 'errors.NETWORK' } });
  });
});

describe('checking the deposit on return', () => {
  it('happens only while payment is pending', () => {
    expect(BOOKING_STATUSES.filter(verifiesDeposit)).toEqual(['PENDING_PAYMENT']);
  });
});
