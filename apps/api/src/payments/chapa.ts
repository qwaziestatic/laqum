import {
  PAYMENT_CURRENCY,
  providerAmountToSantim,
  santimToProviderAmount,
  type ProviderPaymentStatus,
  type ProviderRefundStatus,
} from '@laqum/shared';
import type { Logger } from 'pino';
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
 * Chapa, API v1. The ONLY file in this codebase that knows a Chapa URL.
 *
 * Every endpoint and field below is taken from Chapa's current documentation,
 * not from memory:
 *
 *   initialize  POST /v1/transaction/initialize
 *               https://developer.chapa.co/integrations/accept-payments
 *               Required: amount, currency, tx_ref. Optional: email,
 *               first_name, last_name, phone_number, callback_url, return_url.
 *               Returns { status, message, data: { checkout_url } }.
 *
 *   verify      GET /v1/transaction/verify/<tx_ref>
 *               https://developer.chapa.co/integrations/verify-payments
 *               data carries first_name, last_name, email, currency, amount,
 *               charge, mode, method, type, status. Status is documented as
 *               "failed, success, pending".
 *
 *   refund      POST /v1/refund/<tx_ref>
 *               https://developer.chapa.co/refund
 *               Optional: reason, amount (omit for a full refund), meta,
 *               reference. Returns data: { amount, currency, ref_id,
 *               payment_reference, status, ... }.
 *               "Chapa charges are non-refundable. The transaction amount plus
 *               charges are taken from your available balance."
 *
 * AMOUNT NOTE: verify returns both `amount` and `charge`. `charge` is Chapa's
 * fee and is NOT subtracted here — `amountSantim` is the transaction amount as
 * Chapa reports it, which is what the integrity check compares against the row
 * we created. Whether `amount` is gross or net of the fee depends on the
 * merchant's fee settings, so scripts/chapa-sandbox.mjs prints amount, charge
 * and currency from a real test-mode transaction to confirm before live use.
 */

export interface ChapaOptions {
  secretKey: string;
  baseUrl: string;
  logger: Logger;
  /** Injected so the request shape can be asserted without a network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ChapaEnvelope {
  status?: unknown;
  message?: unknown;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readStatus(value: unknown): ProviderPaymentStatus {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (status === 'success' || status === 'failed' || status === 'pending') return status;
  // An unrecognised status is NOT success. Anything we cannot read as a
  // definite success must never settle a booking.
  return 'failed';
}

function readRefundStatus(value: unknown): ProviderRefundStatus {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  for (const known of ['initiated', 'processing', 'refunded', 'reversed'] as const) {
    if (status === known) return known;
  }
  return 'initiated';
}

export class ChapaProvider implements PaymentProvider {
  readonly name = 'chapa';
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ChapaOptions) {
    this.#secretKey = options.secretKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async #call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<ChapaEnvelope> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.#secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch (err) {
      // A transport failure is "I don't know", never "no".
      throw new ProviderUnavailableError(`Chapa request to ${path} failed`, err);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderUnavailableError(
        `Chapa returned a non-JSON response from ${path} (HTTP ${String(response.status)})`,
      );
    }

    // 404 from verify means "no such transaction", which is an answer, not an
    // outage. 5xx is an outage.
    if (response.status >= 500) {
      throw new ProviderUnavailableError(
        `Chapa returned HTTP ${String(response.status)} from ${path}`,
      );
    }

    return asRecord(parsed);
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const body: Record<string, unknown> = {
      amount: santimToProviderAmount(input.amountSantim),
      currency: PAYMENT_CURRENCY,
      tx_ref: input.txRef,
    };
    if (input.email !== undefined) body['email'] = input.email;
    if (input.firstName !== undefined) body['first_name'] = input.firstName;
    if (input.lastName !== undefined) body['last_name'] = input.lastName;
    if (input.phoneNumber !== undefined) body['phone_number'] = input.phoneNumber;
    if (input.callbackUrl !== undefined) body['callback_url'] = input.callbackUrl;
    if (input.returnUrl !== undefined) body['return_url'] = input.returnUrl;
    if (input.description !== undefined) {
      body['customization'] = { title: 'Laqum', description: input.description };
    }

    const envelope = await this.#call('/v1/transaction/initialize', { method: 'POST', body });
    const checkoutUrl = asRecord(envelope.data)['checkout_url'];

    if (typeof checkoutUrl !== 'string' || checkoutUrl.length === 0) {
      this.#logger.error({ envelope }, 'Chapa initialize returned no checkout_url');
      throw new ProviderUnavailableError('Chapa initialize returned no checkout_url');
    }

    return { checkoutUrl, raw: envelope };
  }

  async verify(txRef: string): Promise<VerifyResult> {
    const envelope = await this.#call(`/v1/transaction/verify/${encodeURIComponent(txRef)}`, {
      method: 'GET',
    });
    const data = asRecord(envelope.data);

    const amount = data['amount'];
    // -1 can never equal a real payments.amount_santim, so an unreadable or
    // missing amount fails the integrity check rather than passing silently.
    let amountSantim = -1;
    if (typeof amount === 'string' || typeof amount === 'number') {
      try {
        amountSantim = providerAmountToSantim(amount);
      } catch (err) {
        // An unreadable amount cannot match, so the integrity check rejects
        // it. Logged because it means Chapa changed its response shape.
        this.#logger.error({ err, txRef, amount }, 'Chapa verify returned an unreadable amount');
      }
    }

    const charge = data['charge'];
    let feeSantim: number | undefined;
    if (typeof charge === 'string' || typeof charge === 'number') {
      try {
        feeSantim = providerAmountToSantim(charge);
      } catch {
        feeSantim = undefined;
      }
    }

    const currency = data['currency'];
    const echoedRef = data['tx_ref'] ?? data['reference'];

    return {
      status: readStatus(data['status']),
      amountSantim,
      currency: typeof currency === 'string' ? currency : '',
      txRef: typeof echoedRef === 'string' ? echoedRef : undefined,
      feeSantim,
      raw: envelope,
    };
  }

  /**
   * Chapa's fees are non-refundable, so a full refund still costs the merchant
   * the original charge. Omitting `amount` refunds the whole transaction.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const body: Record<string, unknown> = {};
    if (input.amountSantim !== undefined) {
      body['amount'] = santimToProviderAmount(input.amountSantim);
    }
    if (input.reason !== undefined) body['reason'] = input.reason;
    if (input.reference !== undefined) body['reference'] = input.reference;

    const envelope = await this.#call(`/v1/refund/${encodeURIComponent(input.txRef)}`, {
      method: 'POST',
      body,
    });
    const data = asRecord(envelope.data);
    const refId = data['ref_id'];

    return {
      status: readRefundStatus(data['status']),
      refundReference: typeof refId === 'string' ? refId : undefined,
      raw: envelope,
    };
  }
}
