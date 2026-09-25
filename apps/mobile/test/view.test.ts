import {
  BOOKING_STATUSES,
  type BookingStatus,
  isLegalTransition,
  isLiveStatus,
} from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { STATUS_TEXT, bookingView } from '../src/booking/view.js';
import { type MessageKey, phrase, translator } from '../src/i18n/core.js';

const english = translator('en');
const amharic = translator('am');
const inEnglish = (key: MessageKey | undefined): string | undefined =>
  key === undefined ? undefined : english(phrase(key));

/**
 * The booking screen's per-status decisions. On the device test an expired
 * hold kept its countdown card ("Checking with the server…") under the parked
 * label "Time remaining", showed the raw enum "expired", and still offered
 * Navigate.
 */

const PAST = '2026-09-24T09:00:00.000Z';
const FUTURE = '2026-09-24T12:00:00.000Z';

function booking(status: BookingStatus) {
  // Both deadlines set, as the server leaves them: the view must not show a
  // timer just because a timestamp exists.
  return { status, holdExpiresAt: PAST, plannedEndAt: FUTURE, qrToken: 'qr-token' };
}

describe('driver text for every status', () => {
  it('covers every BookingStatus, in BOTH languages, so a new status cannot ship without one', () => {
    for (const status of BOOKING_STATUSES) {
      const key = STATUS_TEXT[status].sentence;
      const en = english(phrase(key));
      const am = amharic(phrase(key));
      expect(en, status).toMatch(/^[A-Z].*\.$/u);
      // Amharic: Ethiopic script, ending with the Ethiopic full stop.
      expect(am, status).toMatch(/^[\u1200-\u137F].*\u1362$/u);
      // Never the enum in disguise: "expired", "checked out", "CHECKED_IN".
      expect(en.toLowerCase(), status).not.toBe(status.toLowerCase().replace(/_/gu, ' '));
      for (const text of [en, am]) expect(text, status).not.toContain('_');
    }
    expect(Object.keys(STATUS_TEXT).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it('says something different for each status, in each language', () => {
    for (const translate of [english, amharic]) {
      const sentences = BOOKING_STATUSES.map((status) =>
        translate(phrase(STATUS_TEXT[status].sentence)),
      );
      expect(new Set(sentences).size).toBe(BOOKING_STATUSES.length);
    }
  });

  it('uses the sentences asked for', () => {
    expect(inEnglish(bookingView(booking('RESERVED')).sentence)).toBe(
      'Your slot is held. Drive to the lot.',
    );
    expect(inEnglish(bookingView(booking('EXPIRED')).sentence)).toBe(
      'This hold expired and the slot was released.',
    );
  });
});

describe('the timer card', () => {
  it('never shows for a status that is not live', () => {
    for (const status of BOOKING_STATUSES.filter((s) => !isLiveStatus(s))) {
      expect(bookingView(booking(status)).timer, status).toBeNull();
    }
  });

  it('is hidden for the expired hold from the device test', () => {
    const view = bookingView(booking('EXPIRED'));
    expect(view.timer).toBeNull();
  });

  it('has its own label for each live status', () => {
    const timers = Object.fromEntries(
      BOOKING_STATUSES.filter(isLiveStatus).map((status) => {
        const timer = bookingView(booking(status)).timer;
        return [status, timer && { ...timer, label: inEnglish(timer.label) }];
      }),
    );

    expect(timers).toEqual({
      PENDING_PAYMENT: { label: 'Time left to pay', deadline: PAST, counts: 'down' },
      RESERVED: { label: 'Slot held for', deadline: PAST, counts: 'down' },
      CHECKED_IN: { label: 'Time remaining', deadline: FUTURE, counts: 'down' },
      OVERSTAY: { label: 'Over by', deadline: FUTURE, counts: 'up' },
    });
  });

  it('keeps "Time remaining" to the parked state', () => {
    for (const status of BOOKING_STATUSES.filter((s) => s !== 'CHECKED_IN')) {
      expect(inEnglish(bookingView(booking(status)).timer?.label), status).not.toBe(
        'Time remaining',
      );
    }
  });

  it('shows no card for a live status whose deadline is missing', () => {
    expect(bookingView({ ...booking('RESERVED'), holdExpiresAt: null }).timer).toBeNull();
  });
});

describe('actions', () => {
  it('offers "Find another slot", not Navigate, once a booking is finished', () => {
    for (const status of ['EXPIRED', 'CANCELLED', 'PAID'] as const) {
      const { actions } = bookingView(booking(status));
      expect(actions, status).toEqual({
        navigate: false,
        findAnotherSlot: true,
        showQr: false,
        extend: false,
        pay: false,
        payDeposit: false,
        cancel: false,
      });
    }
  });

  it('sends a checked-out driver to pay, with nothing else to do', () => {
    expect(bookingView(booking('CHECKED_OUT')).actions).toEqual({
      navigate: false,
      findAnotherSlot: false,
      showQr: false,
      extend: false,
      pay: true,
      payDeposit: false,
      cancel: false,
    });
  });

  it('asks for the deposit, and only the deposit, while payment is pending', () => {
    // No QR: the gate cannot check in an unpaid booking. No cancel: the state
    // machine has no PENDING_PAYMENT -> CANCELLED; an unpaid hold just lapses.
    expect(bookingView(booking('PENDING_PAYMENT')).actions).toEqual({
      navigate: true,
      findAnotherSlot: false,
      showQr: false,
      extend: false,
      pay: false,
      payDeposit: true,
      cancel: false,
    });
  });

  it('shows the QR and cancel once the slot is held, and extend while parked', () => {
    expect(bookingView(booking('RESERVED')).actions).toEqual({
      navigate: true,
      findAnotherSlot: false,
      showQr: true,
      extend: false,
      pay: false,
      payDeposit: false,
      cancel: true,
    });
    for (const status of ['CHECKED_IN', 'OVERSTAY'] as const) {
      expect(bookingView(booking(status)).actions, status).toEqual({
        navigate: true,
        findAnotherSlot: false,
        showQr: false,
        extend: true,
        pay: false,
        payDeposit: false,
        cancel: false,
      });
    }
  });

  it('offers cancel and the gate QR exactly where the state machine allows them', () => {
    for (const status of BOOKING_STATUSES) {
      const { actions } = bookingView(booking(status));
      expect(actions.cancel, status).toBe(isLegalTransition(status, 'CANCELLED'));
      expect(actions.showQr, status).toBe(isLegalTransition(status, 'CHECKED_IN'));
    }
  });

  it('never offers Navigate and "Find another slot" together', () => {
    for (const status of BOOKING_STATUSES) {
      const { actions } = bookingView(booking(status));
      expect(actions.navigate && actions.findAnotherSlot, status).toBe(false);
    }
  });
});
