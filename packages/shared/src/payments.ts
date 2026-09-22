import { z } from 'zod';

/**
 * The money boundary between this system and a payment provider.
 *
 * Internally everything is integer santim. Chapa speaks decimal BIRR, and its
 * verify response returns `amount` as a JSON number (e.g. 100) or a string
 * (e.g. "100.00") depending on the call. Converting with parseFloat and
 * comparing would let a rounding error decide whether a payment is accepted,
 * so the conversion is exact, total, and tested at the boundaries.
 */

export const PAYMENT_CURRENCY = 'ETB';

/** Chapa documents transaction status as failed | success | pending. */
export const PROVIDER_PAYMENT_STATUSES = ['success', 'failed', 'pending'] as const;
export type ProviderPaymentStatus = (typeof PROVIDER_PAYMENT_STATUSES)[number];
export const providerPaymentStatusSchema = z.enum(PROVIDER_PAYMENT_STATUSES);

/**
 * Chapa refund status, per its refund docs: initiated | processing | refunded
 * | reversed.
 */
export const PROVIDER_REFUND_STATUSES = [
  'initiated',
  'processing',
  'refunded',
  'reversed',
] as const;
export type ProviderRefundStatus = (typeof PROVIDER_REFUND_STATUSES)[number];

export class AmountParseError extends RangeError {
  constructor(value: unknown, why: string) {
    super(`Cannot read provider amount ${JSON.stringify(value)} as santim: ${why}`);
    this.name = 'AmountParseError';
  }
}

const DECIMAL = /^(\d+)(?:\.(\d{1,2}))?$/u;

/**
 * Birr (as the provider reports it) to integer santim.
 *
 * Strings are parsed digit-by-digit rather than through Number, so "100.10"
 * cannot become 10009.999. Numbers are accepted but must land exactly on a
 * santim: 0.015 birr is not a representable amount and is rejected rather
 * than silently rounded into or out of a match.
 */
export function providerAmountToSantim(value: string | number): number {
  if (typeof value === 'string') {
    const match = DECIMAL.exec(value.trim());
    if (!match) throw new AmountParseError(value, 'not a non-negative decimal with up to 2 places');

    const whole = Number(match[1]);
    // "1.5" means 50 santim, not 5. Pad before parsing.
    const fraction = Number((match[2] ?? '').padEnd(2, '0'));
    const santim = whole * 100 + fraction;
    if (!Number.isSafeInteger(santim)) throw new AmountParseError(value, 'too large');
    return santim;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new AmountParseError(value, 'not a finite non-negative number');
  }

  const scaled = value * 100;
  const rounded = Math.round(scaled);
  // Floating point cannot represent every 2-decimal birr value exactly, so
  // allow a hair of slack — but reject anything that is genuinely not a whole
  // number of santim.
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new AmountParseError(value, 'has sub-santim precision');
  }
  if (!Number.isSafeInteger(rounded)) throw new AmountParseError(value, 'too large');
  return rounded;
}

/** Integer santim to the decimal birr string the provider expects. */
export function santimToProviderAmount(santim: number): string {
  if (!Number.isSafeInteger(santim) || santim < 0) {
    throw new AmountParseError(santim, 'santim must be a non-negative safe integer');
  }
  const whole = Math.trunc(santim / 100);
  const fraction = santim % 100;
  return `${String(whole)}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Why a successfully-collected payment is sitting in the operator's refund
 * queue. Both are money we hold that the driver should get back.
 */
export const REFUND_REASONS = ['late_deposit', 'overpayment'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * What the driver is told about money on their booking. Surfaced by
 * GET /bookings/:id and /bookings/current; push notifications are Phase 5.
 */
export const PAYMENT_NOTICES = [
  'deposit_refund_pending',
  'overpayment_refund_pending',
  'payment_pending',
] as const;
export type PaymentNotice = (typeof PAYMENT_NOTICES)[number];

export const payBookingSchema = z.object({});
export type PayBookingRequest = z.infer<typeof payBookingSchema>;

export const recordRefundSchema = z.object({
  /** Omit to refund the whole collected amount. */
  amountSantim: z.int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
});
export type RecordRefundRequest = z.infer<typeof recordRefundSchema>;
