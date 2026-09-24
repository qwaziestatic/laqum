import { elapsedMinutes } from './clock.js';
import type { BookingSource } from './enums.js';
import { blocksFor } from './money.js';

/**
 * Billing is a pure function. It touches no database and no clock: the caller
 * supplies `checkoutAt`, which is what makes the boundary cases testable
 * exhaustively without moving any real time.
 *
 * Rounding, stated once and applied everywhere:
 *   - any part-minute counts as a whole minute (elapsedMinutes ceils);
 *   - any part-block counts as a whole block (blocksFor ceils).
 * So a car one second past its planned end owes a full overstay block. That is
 * how parking meters behave, and it is pinned by a test rather than implied.
 */

export interface BillableBooking {
  source: BookingSource;
  planned_minutes: number | null;
  checked_in_at: Date | null;
  planned_end_at: Date | null;
  /**
   * Sum of SUCCESSFUL deposit payments for this booking. The caller populates
   * it from `payments`; one_paid_deposit_per_booking caps it at one row.
   */
  deposit_paid_santim: number;
}

/** The DATABASE row's names: the API bills straight from `lots` rows. */
export interface BillableLot {
  block_minutes: number;
  rate_per_block_santim: number;
  overstay_rate_per_block_santim: number;
}

/**
 * A lot as the API SENDS it (camelCase, see lotSummarySchema) → the lot
 * computeBill takes. The one sanctioned bridge between the two namings.
 *
 * The device test crashed because the Book screen cast a LotSummary straight
 * to BillableLot: `block_minutes` read undefined and blocksFor threw during
 * render. Structural on purpose, so it needs no schema import here.
 */
export function billableLotFromSummary(lot: {
  blockMinutes: number;
  ratePerBlockSantim: number;
  overstayRatePerBlockSantim: number;
}): BillableLot {
  return {
    block_minutes: lot.blockMinutes,
    rate_per_block_santim: lot.ratePerBlockSantim,
    overstay_rate_per_block_santim: lot.overstayRatePerBlockSantim,
  };
}

export type BillLineKind = 'planned' | 'overstay' | 'walk_in' | 'deposit_credit';

export interface BillLine {
  kind: BillLineKind;
  minutes: number;
  blocks: number;
  /** Santim per block. Zero for the deposit credit, which is not per-block. */
  unitSantim: number;
  /** Signed: the deposit credit is negative. Lines sum to amountDueSantim. */
  amountSantim: number;
}

export interface BillBreakdown {
  lines: BillLine[];
  /** Charges before the deposit is applied. */
  subtotalSantim: number;
  /** Deposit actually applied: min(paid, subtotal). Never more than the bill. */
  depositCreditSantim: number;
  /**
   * Deposit paid but not used, because it exceeded the bill. NOT refunded —
   * refunds exist only as an operator-initiated correction.
   */
  depositUnusedSantim: number;
  /** What the driver owes. Floored at zero. */
  amountDueSantim: number;
}

export function computeBill(
  booking: BillableBooking,
  lot: BillableLot,
  checkoutAt: Date,
): BillBreakdown {
  const lines: BillLine[] =
    booking.source === 'walk_in'
      ? walkInLines(booking, lot, checkoutAt)
      : appLines(booking, lot, checkoutAt);

  const subtotalSantim = lines.reduce((sum, line) => sum + line.amountSantim, 0);

  const depositPaid = Math.max(0, booking.deposit_paid_santim);
  const depositCreditSantim = Math.min(depositPaid, subtotalSantim);
  const depositUnusedSantim = depositPaid - depositCreditSantim;

  if (depositCreditSantim > 0) {
    lines.push({
      kind: 'deposit_credit',
      minutes: 0,
      blocks: 0,
      unitSantim: 0,
      amountSantim: -depositCreditSantim,
    });
  }

  return {
    lines,
    subtotalSantim,
    depositCreditSantim,
    depositUnusedSantim,
    amountDueSantim: subtotalSantim - depositCreditSantim,
  };
}

/**
 * App bookings pay for the time they planned, plus any overstay.
 *
 * There is no refund for leaving early: planned blocks come from
 * planned_minutes, never from how long the car was actually there.
 */
function appLines(booking: BillableBooking, lot: BillableLot, checkoutAt: Date): BillLine[] {
  const plannedMinutes = booking.planned_minutes ?? 0;
  const plannedBlocks = blocksFor(plannedMinutes, lot.block_minutes);

  const lines: BillLine[] = [
    {
      kind: 'planned',
      minutes: plannedMinutes,
      blocks: plannedBlocks,
      unitSantim: lot.rate_per_block_santim,
      amountSantim: plannedBlocks * lot.rate_per_block_santim,
    },
  ];

  // planned_end_at is null until check-in. A booking billed before check-in
  // has no overstay by definition.
  const overstayMinutes = booking.planned_end_at
    ? elapsedMinutes(booking.planned_end_at, checkoutAt)
    : 0;

  if (overstayMinutes > 0) {
    const overstayBlocks = blocksFor(overstayMinutes, lot.block_minutes);
    lines.push({
      kind: 'overstay',
      minutes: overstayMinutes,
      blocks: overstayBlocks,
      unitSantim: lot.overstay_rate_per_block_santim,
      amountSantim: overstayBlocks * lot.overstay_rate_per_block_santim,
    });
  }

  return lines;
}

/**
 * Walk-ins pay for actual time, with a one-block minimum. They have no planned
 * end and never enter OVERSTAY, so they are never charged the overstay rate.
 */
function walkInLines(booking: BillableBooking, lot: BillableLot, checkoutAt: Date): BillLine[] {
  const actualMinutes = booking.checked_in_at
    ? elapsedMinutes(booking.checked_in_at, checkoutAt)
    : 0;

  // A car that arrives and leaves immediately still occupied the slot.
  const blocks = Math.max(1, blocksFor(actualMinutes, lot.block_minutes));

  return [
    {
      kind: 'walk_in',
      minutes: actualMinutes,
      blocks,
      unitSantim: lot.rate_per_block_santim,
      amountSantim: blocks * lot.rate_per_block_santim,
    },
  ];
}
