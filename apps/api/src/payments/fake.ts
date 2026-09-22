import type { Clock, ProviderPaymentStatus } from '@laqum/shared';
import {
  ProviderUnavailableError,
  type InitializeInput,
  type InitializeResult,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
  type VerifyResult,
} from './provider.js';

/**
 * The provider used by every automated test, and by local development.
 *
 * It models the behaviours that actually matter and are hard to provoke
 * against a sandbox: a payment that stays pending, one that fails, one whose
 * confirmed amount disagrees with ours, and a provider that is simply
 * unreachable.
 *
 * Time comes from the injected clock, so "succeeds after a delay" is tested by
 * advancing a FakeClock rather than by waiting.
 */

export interface FakePaymentOptions {
  clock: Clock;
  /** Seconds after initialize before a payment reports success. 0 = instant. */
  autoSucceedAfterSeconds?: number;
  baseCheckoutUrl?: string;
}

interface FakePayment {
  txRef: string;
  amountSantim: number;
  currency: string;
  initializedAt: Date;
  /** Overrides the automatic outcome when set. */
  forcedStatus?: ProviderPaymentStatus;
  /** Makes verify report a different amount, for the integrity test. */
  reportAmountSantim?: number;
  reportCurrency?: string;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly #clock: Clock;
  readonly #autoSucceedAfterSeconds: number;
  readonly #baseCheckoutUrl: string;
  readonly #payments = new Map<string, FakePayment>();
  readonly refunds: RefundInput[] = [];

  /** When true, every call throws ProviderUnavailableError. */
  unavailable = false;

  constructor(options: FakePaymentOptions) {
    this.#clock = options.clock;
    this.#autoSucceedAfterSeconds = options.autoSucceedAfterSeconds ?? 0;
    this.#baseCheckoutUrl = options.baseCheckoutUrl ?? 'https://checkout.test/pay';
  }

  #assertAvailable(): void {
    if (this.unavailable) {
      throw new ProviderUnavailableError('FakePaymentProvider is configured as unreachable');
    }
  }

  initialize(input: InitializeInput): Promise<InitializeResult> {
    this.#assertAvailable();

    this.#payments.set(input.txRef, {
      txRef: input.txRef,
      amountSantim: input.amountSantim,
      currency: 'ETB',
      initializedAt: this.#clock.now(),
    });

    return Promise.resolve({
      checkoutUrl: `${this.#baseCheckoutUrl}/${input.txRef}`,
      raw: { status: 'success', message: 'Hosted Link', data: { checkout_url: 'fake' } },
    });
  }

  verify(txRef: string): Promise<VerifyResult> {
    this.#assertAvailable();

    const payment = this.#payments.get(txRef);
    if (!payment) {
      // Chapa answers 404 for an unknown reference; the service treats an
      // unknown reference as "not confirmed", never as success.
      return Promise.resolve({
        status: 'failed',
        amountSantim: 0,
        currency: 'ETB',
        txRef,
        raw: { status: 'failed', message: 'Transaction not found' },
      });
    }

    const elapsedSeconds = (this.#clock.now().getTime() - payment.initializedAt.getTime()) / 1000;
    const status: ProviderPaymentStatus =
      payment.forcedStatus ??
      (elapsedSeconds >= this.#autoSucceedAfterSeconds ? 'success' : 'pending');

    return Promise.resolve({
      status,
      amountSantim: payment.reportAmountSantim ?? payment.amountSantim,
      currency: payment.reportCurrency ?? payment.currency,
      txRef,
      feeSantim: Math.round((payment.reportAmountSantim ?? payment.amountSantim) * 0.035),
      raw: { status: 'success', data: { status, amount: 'fake' } },
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    this.#assertAvailable();
    this.refunds.push(input);
    return Promise.resolve({
      status: 'initiated',
      refundReference: `FAKE-REF-${String(this.refunds.length)}`,
      raw: { status: 'success', data: { status: 'initiated' } },
    });
  }

  // ─── Test controls ──────────────────────────────────────────────────────

  /** Force the outcome verify will report for this reference. */
  setStatus(txRef: string, status: ProviderPaymentStatus): void {
    const payment = this.#payments.get(txRef);
    if (!payment) throw new Error(`FakePaymentProvider has no payment ${txRef}`);
    payment.forcedStatus = status;
  }

  /** Make verify disagree with what we recorded, for the integrity checks. */
  reportDifferentAmount(txRef: string, amountSantim: number): void {
    const payment = this.#payments.get(txRef);
    if (!payment) throw new Error(`FakePaymentProvider has no payment ${txRef}`);
    payment.reportAmountSantim = amountSantim;
  }

  reportDifferentCurrency(txRef: string, currency: string): void {
    const payment = this.#payments.get(txRef);
    if (!payment) throw new Error(`FakePaymentProvider has no payment ${txRef}`);
    payment.reportCurrency = currency;
  }

  initialized(txRef: string): boolean {
    return this.#payments.has(txRef);
  }

  reset(): void {
    this.#payments.clear();
    this.refunds.length = 0;
    this.unavailable = false;
  }
}
