import { type Booking, type BookingStatus, isLegalTransition, isLiveStatus } from '@laqum/shared';

/**
 * What the booking screen shows, decided per status in ONE table.
 *
 * The device test found the screen improvising from scattered conditions:
 * an expired hold still showed its countdown card ("Checking with the
 * server…") under the parked state's label "Time remaining", the status line
 * was the raw enum ("expired"), and a finished booking still offered
 * Navigate. Every status now has its own sentence, its own timer or none, and
 * its own actions. STATUS_TEXT is a Record over BookingStatus, so a status
 * added to the state machine does not compile until it has driver text, and
 * view.test.ts walks BOOKING_STATUSES at runtime as well.
 */

/** The timer each status runs, if any. */
interface TimerSpec {
  label: string;
  field: 'holdExpiresAt' | 'plannedEndAt';
  /** 'up' counts time PAST the deadline: overstay. */
  counts: 'down' | 'up';
}

interface StatusText {
  /** A plain sentence for the driver. Never the enum value. */
  sentence: string;
  timer: TimerSpec | null;
}

export const STATUS_TEXT: Record<BookingStatus, StatusText> = {
  PENDING_PAYMENT: {
    sentence: 'Pay the deposit to hold your slot.',
    timer: { label: 'Time left to pay', field: 'holdExpiresAt', counts: 'down' },
  },
  RESERVED: {
    sentence: 'Your slot is held. Drive to the lot.',
    timer: { label: 'Slot held for', field: 'holdExpiresAt', counts: 'down' },
  },
  CHECKED_IN: {
    sentence: 'You are parked.',
    timer: { label: 'Time remaining', field: 'plannedEndAt', counts: 'down' },
  },
  OVERSTAY: {
    sentence: 'Your booked time is up.',
    timer: { label: 'Over by', field: 'plannedEndAt', counts: 'up' },
  },
  CHECKED_OUT: {
    sentence: 'You have left the lot. Pay to finish.',
    timer: null,
  },
  PAID: {
    sentence: 'Paid. Thank you for parking.',
    timer: null,
  },
  EXPIRED: {
    sentence: 'This hold expired and the slot was released.',
    timer: null,
  },
  CANCELLED: {
    sentence: 'You cancelled this booking and the slot was released.',
    timer: null,
  },
};

/**
 * Over for the driver: nothing left to do here, so the screen offers "Find
 * another slot" instead of directions. CHECKED_OUT is NOT among them — its
 * slot is released, but the bill is still to pay.
 */
const FINISHED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'PAID',
  'EXPIRED',
  'CANCELLED',
]);

export interface BookingView {
  sentence: string;
  timer: { label: string; deadline: string; counts: 'down' | 'up' } | null;
  actions: {
    /** Directions to the lot: only while there is a reason to go there. */
    navigate: boolean;
    findAnotherSlot: boolean;
    /** The entry QR and short code: only where the gate can check it in. */
    showQr: boolean;
    extend: boolean;
    pay: boolean;
    /** Pay, or retry, the deposit that holds the slot. */
    payDeposit: boolean;
    cancel: boolean;
  };
}

export function bookingView(
  booking: Pick<Booking, 'status' | 'holdExpiresAt' | 'plannedEndAt' | 'qrToken'>,
): BookingView {
  const text = STATUS_TEXT[booking.status];
  const deadline = text.timer ? booking[text.timer.field] : null;
  const parked = booking.status === 'CHECKED_IN' || booking.status === 'OVERSTAY';

  return {
    sentence: text.sentence,
    // A timer the status runs AND a deadline to run it against. A live
    // status missing its deadline shows no card rather than a wrong one.
    timer:
      text.timer && deadline
        ? { label: text.timer.label, deadline, counts: text.timer.counts }
        : null,
    actions: {
      navigate: isLiveStatus(booking.status),
      findAnotherSlot: FINISHED.has(booking.status),
      /*
       * From the SHARED state machine, never a local list. Both were once
       * offered while PENDING_PAYMENT, where the machine permits neither: the
       * gate refuses an unpaid booking's QR, and cancelling fails. Deposits
       * made that state reachable.
       */
      showQr: isLegalTransition(booking.status, 'CHECKED_IN') && booking.qrToken !== null,
      extend: parked,
      pay: booking.status === 'CHECKED_OUT',
      payDeposit: booking.status === 'PENDING_PAYMENT',
      cancel: isLegalTransition(booking.status, 'CANCELLED'),
    },
  };
}
