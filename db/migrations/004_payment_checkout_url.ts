import { type Kysely, sql } from 'kysely';

/**
 * Adds payments.checkout_url: the provider's hosted checkout for this payment.
 *
 * Set only when the provider ACCEPTED initialize and handed back a checkout.
 * A row is written before initialize is called (so a late webhook can still
 * resolve its reference), which means a pending row alone does not say the
 * driver was ever given a way to pay. This column does:
 *
 *   NULL      the provider never gave us a checkout. The driver cannot have
 *             paid, so nothing is "pending with the provider".
 *   not NULL  the driver was, or can be, sent there. Reopening the payment
 *             reuses it instead of opening a second reference for one charge.
 *
 * THE GUARD IT EXISTS FOR. The deposit expiry pre-check defers expiry while
 * the provider is unreachable, because the driver may have paid. That is true
 * only of an initialized payment. Without this column a deposit whose
 * initialize FAILED looked the same as one awaiting the driver, so a provider
 * outage at booking time held the slot for the whole deferral bound past its
 * payment window.
 *
 * No backfill: before this migration nothing initialized a deposit, so no
 * pending deposit row can have had a checkout.
 *
 * Forward-only: no down. See CLAUDE.md, "Migration policy".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS checkout_url text
  `.execute(db);
}
