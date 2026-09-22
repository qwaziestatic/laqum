import { AppError, santimToProviderAmount } from '@laqum/shared';
import { isProviderUnavailable } from './provider.js';
import { makeTxRef, type PaymentRow, type PaymentsContext } from './service.js';

/**
 * Starting a payment: create OUR row first, then ask the provider.
 *
 * The row exists before the customer ever sees a checkout page, so whatever
 * comes back later can be compared against what we intended to charge. A
 * provider-first flow would have nothing to compare against.
 */

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
    description?: string;
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
      provider: ctx.provider.name === 'chapa' ? 'chapa' : 'cash',
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
      returnUrl: `${ctx.config.PUBLIC_BASE_URL}/payment-complete`,
      description: input.description,
    });

    await ctx.db
      .updateTable('payments')
      .set({ provider_payload: JSON.stringify(result.raw), updated_at: now })
      .where('id', '=', payment.id)
      .execute();

    return { payment, checkoutUrl: result.checkoutUrl };
  } catch (err) {
    // The row stays pending rather than being deleted: if the provider
    // actually did create the transaction before failing to answer us, the
    // reference must still resolve when a webhook arrives.
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
