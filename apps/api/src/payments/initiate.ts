import { AppError, santimToProviderAmount } from '@laqum/shared';
import { isProviderUnavailable } from './provider.js';
import { PAYMENT_RETURN_PATH } from './returnPage.js';
import { makeTxRef, type PaymentRow, type PaymentsContext } from './service.js';

/**
 * Starting a payment: create OUR row first, then ask the provider.
 *
 * The row exists before the customer ever sees a checkout page, so whatever
 * comes back later can be compared against what we intended to charge. A
 * provider-first flow would have nothing to compare against.
 */

/**
 * What Chapa shows on its checkout, by payment kind. PLAIN ASCII, both:
 * Chapa's public docs state no rule for the description's characters, and an
 * initialize Chapa rejects is a payment nobody can make. Keep them ASCII until
 * the sandbox proves Amharic is accepted (CLAUDE.md, Phase 2 open items).
 * Chosen here by kind, so no caller can pass anything else.
 */
export const PAYMENT_DESCRIPTIONS = {
  deposit: 'Laqum parking deposit',
  final: 'Laqum parking',
} as const satisfies Record<'deposit' | 'final', string>;

export interface InitiatedPayment {
  payment: PaymentRow;
  checkoutUrl: string;
}

export async function initiatePayment(
  ctx: PaymentsContext,
  input: {
    bookingId: string;
    kind: 'deposit' | 'final';
    amountSantim: number;
  },
): Promise<InitiatedPayment> {
  if (input.amountSantim <= 0) {
    throw new AppError('VALIDATION_ERROR', 'A payment amount must be positive', {
      amountSantim: input.amountSantim,
    });
  }

  const now = ctx.clock.now();
  const txRef = makeTxRef(input.kind === 'deposit' ? 'dep' : 'fin');

  const payment = await ctx.db
    .insertInto('payments')
    .values({
      booking_id: input.bookingId,
      kind: input.kind,
      /*
       * The rail, not the implementation. FakePaymentProvider stands in FOR
       * Chapa in development and tests, so its rows are 'chapa' too.
       * Recording them as 'cash' would both be a lie and violate
       * cash_has_recorder, which requires a named human recorder.
       */
      provider: 'chapa',
      amount_santim: input.amountSantim,
      status: 'pending',
      tx_ref: txRef,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  try {
    const result = await ctx.provider.initialize({
      txRef,
      amountSantim: input.amountSantim,
      callbackUrl: `${ctx.config.PUBLIC_BASE_URL}/v1/webhooks/chapa`,
      returnUrl: `${ctx.config.PUBLIC_BASE_URL}${PAYMENT_RETURN_PATH}`,
      description: PAYMENT_DESCRIPTIONS[input.kind],
    });

    // checkout_url marks the payment INITIALIZED: from here on the driver can
    // have paid, which is what the deposit expiry pre-check asks (migration 004).
    const initialized = await ctx.db
      .updateTable('payments')
      .set({
        provider_payload: JSON.stringify(result.raw),
        checkout_url: result.checkoutUrl,
        updated_at: now,
      })
      .where('id', '=', payment.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { payment: initialized, checkoutUrl: result.checkoutUrl };
  } catch (err) {
    // The row stays pending rather than being deleted: if the provider
    // actually did create the transaction before failing to answer us, the
    // reference must still resolve when a webhook arrives. It gets no
    // checkout_url: the driver was never given a way to pay.
    await ctx.db
      .updateTable('payments')
      .set({
        provider_payload: JSON.stringify({
          initializeError: err instanceof Error ? err.message : String(err),
        }),
        updated_at: now,
      })
      .where('id', '=', payment.id)
      .execute();

    if (isProviderUnavailable(err)) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Could not reach the payment provider');
    }
    throw err;
  }
}

/** The amount, as the provider will be asked to charge it. Used by the script. */
export { santimToProviderAmount };
