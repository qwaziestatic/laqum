import type { ProviderPaymentStatus, ProviderRefundStatus } from '@laqum/shared';

/**
 * The payment provider seam.
 *
 * Everything above this interface is testable without a network: the fake
 * implements the same contract, including its failure modes. `ChapaProvider`
 * is the only file that knows a Chapa URL.
 *
 * Amounts crossing this boundary are ALWAYS integer santim. Each
 * implementation converts to and from whatever the provider speaks.
 */

export interface InitializeInput {
  /** Our reference. Unique, and what verify is later called with. */
  txRef: string;
  amountSantim: number;
  /** Where the provider should send the webhook. */
  callbackUrl?: string;
  /** Where the customer is sent after paying. */
  returnUrl?: string;
  email?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  phoneNumber?: string | undefined;
  description?: string | undefined;
}

export interface InitializeResult {
  checkoutUrl: string;
  /** The provider's untouched response, for provider_payload. */
  raw: unknown;
}

export interface VerifyResult {
  status: ProviderPaymentStatus;
  /** Converted from the provider's decimal amount. */
  amountSantim: number;
  currency: string;
  /**
   * Our reference as the provider reports it back. Undefined when the
   * provider does not echo it — for Chapa v1 the reference is bound by the
   * verify URL itself, which is a stronger guarantee than an echoed field.
   */
  txRef?: string | undefined;
  /** Provider fee, when reported. NOT deducted from amountSantim. */
  feeSantim?: number | undefined;
  raw: unknown;
}

export interface RefundInput {
  txRef: string;
  /** Omit for a full refund. */
  amountSantim?: number | undefined;
  reason?: string | undefined;
  /** Our own idempotency reference for the refund request. */
  reference?: string | undefined;
}

export interface RefundResult {
  status: ProviderRefundStatus;
  /** The provider's refund id, for later reconciliation. */
  refundReference?: string | undefined;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: 'chapa' | 'fake';
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(txRef: string): Promise<VerifyResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

/**
 * The provider could not be reached or answered unusably.
 *
 * Distinct from "the provider says this payment failed": callers must be able
 * to tell "no" from "I don't know", because expiring a booking on "I don't
 * know" can destroy a paid reservation.
 */
export class ProviderUnavailableError extends Error {
  // Error already declares `cause`; narrowing it here needs the modifier.
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.cause = cause;
  }
}

export function isProviderUnavailable(err: unknown): err is ProviderUnavailableError {
  return err instanceof ProviderUnavailableError;
}
