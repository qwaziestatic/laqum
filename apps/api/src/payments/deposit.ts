import { AppError } from '@laqum/shared';
import type { BookingRow } from '../bookings/transition.js';
import { initiatePayment, type InitiatedPayment } from './initiate.js';
import { confirmPayment, type PaymentRow, type PaymentsContext } from './service.js';

/**
 * The deposit: started when a deposit booking is created, and reopened or
 * re-checked by the driver while the booking is PENDING_PAYMENT.
 *
 * Settlement is unchanged: confirmPayment() is still the only path that marks
 * a deposit paid and moves the booking to RESERVED.
 */

/**
 * ASCII on purpose. Chapa's public docs state no rule for the description's
 * characters, and an initialize Chapa rejects is a deposit nobody can pay.
 * Confirm against the sandbox (CLAUDE.md, Phase 2 open items).
 */
export const DEPOSIT_DESCRIPTION = 'Laqum parking deposit';

export function startDeposit(
  ctx: PaymentsContext,
  bookingId: string,
  amountSantim: number,
): Promise<InitiatedPayment> {
  return initiatePayment(ctx, {
    bookingId,
    kind: 'deposit',
    amountSantim,
    description: DEPOSIT_DESCRIPTION,
  });
}

export interface DepositCheck {
  /** A deposit the provider confirmed, now or earlier. */
  paid: PaymentRow | null;
  /** The newest deposit the provider still reports as pending: reopen it. */
  reusable: PaymentRow | null;
}

/**
 * Ask the provider about every INITIALIZED deposit still pending here.
 *
 * Initialized means it has a checkout_url (migration 004). A deposit whose
 * initialize failed never had one, so the driver cannot have paid it, and it
 * is never asked about. That is what lets a booking whose payment never
 * started expire exactly at its payment window, even while the provider is
 * down: with nothing initialized, this makes no provider call and cannot
 * throw.
 *
 * Every initialized deposit, not only the newest: a driver who reopened after
 * a failed attempt has two, and a lost webhook on either is still money paid.
 *
 * Throws AppError PROVIDER_UNAVAILABLE when the provider cannot be reached.
 */
export async function checkDeposits(
  ctx: PaymentsContext,
  bookingId: string,
): Promise<DepositCheck> {
  const initialized = await ctx.db
    .selectFrom('payments')
    .selectAll()
    .where('booking_id', '=', bookingId)
    .where('kind', '=', 'deposit')
    .where('status', '=', 'pending')
    .where('checkout_url', 'is not', null)
    .orderBy('created_at', 'desc')
    .execute();

  let reusable: PaymentRow | null = null;
  for (const payment of initialized) {
    if (payment.tx_ref === null) continue;

    const outcome = await confirmPayment(ctx, payment.tx_ref);
    if (outcome.kind === 'confirmed' || outcome.kind === 'already_settled') {
      return { paid: outcome.payment, reusable: null };
    }
    // Newest first, so the first still-pending one is the one to reopen. A
    // payment the provider reports failed is never reopened.
    if (reusable === null && outcome.kind === 'not_successful' && outcome.status === 'pending') {
      reusable = payment;
    }
  }

  return { paid: null, reusable };
}

export interface OpenedDeposit {
  checkoutUrl: string;
  txRef: string | null;
  amountSantim: number;
  /** False when a new payment was started. */
  reused: boolean;
}

/**
 * The driver's "Pay deposit": reopen the pending payment, or start one.
 *
 * Reopens rather than starting a second reference while the first is still
 * payable: two live references for one deposit is how a driver pays twice.
 * A new one is started only when there is none, or the provider reports the
 * last one failed. Checking first also settles a deposit whose webhook was
 * lost, which is reported as ALREADY_PAID.
 */
export async function openDeposit(
  ctx: PaymentsContext,
  booking: BookingRow,
): Promise<OpenedDeposit> {
  if (booking.status !== 'PENDING_PAYMENT') {
    throw new AppError('STATE_CONFLICT', 'This booking has no deposit to pay', {
      status: booking.status,
    });
  }

  const check = await checkDeposits(ctx, booking.id);
  if (check.paid) throw new AppError('ALREADY_PAID', 'The deposit is already paid');

  if (check.reusable?.checkout_url) {
    return {
      checkoutUrl: check.reusable.checkout_url,
      txRef: check.reusable.tx_ref,
      amountSantim: check.reusable.amount_santim,
      reused: true,
    };
  }

  const lot = await ctx.db
    .selectFrom('lots')
    .select('deposit_amount_santim')
    .where('id', '=', booking.lot_id)
    .executeTakeFirstOrThrow();

  const started = await startDeposit(ctx, booking.id, lot.deposit_amount_santim);
  return {
    checkoutUrl: started.checkoutUrl,
    txRef: started.payment.tx_ref,
    amountSantim: started.payment.amount_santim,
    reused: false,
  };
}
