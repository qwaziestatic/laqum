import { type Kysely, sql } from 'kysely';

/**
 * Adds payment_status 'superseded'.
 *
 * WHY: a final payment the provider genuinely collected, but which our ledger
 * could not apply to the booking because one_paid_final_per_booking permits
 * only ONE successful final per booking. Recording that as 'failed' made the
 * ledger disagree with Chapa's settlement report — the money moved, so
 * 'failed' is a lie. 'superseded' says exactly what happened: collected, not
 * applied, and owed back to the driver.
 *
 * THE POSTGRES CONSTRAINT THAT SHAPES THIS MIGRATION:
 *
 *   ALTER TYPE ... ADD VALUE may run inside a transaction on PG12+, but the
 *   new value CANNOT BE USED in the transaction that added it:
 *     "New enum values must be committed before they can be used."
 *
 *   Verified directly against Postgres 16. Kysely wraps each migration in a
 *   transaction, so this migration ONLY adds the label. Any backfill that
 *   writes 'superseded' needs its own later migration, which will run in a
 *   separate transaction.
 *
 * No backfill is included because nothing is deployed yet: there are no
 * historical rows to reclassify.
 *
 * Forward-only: no `down`. See CLAUDE.md, "Migration policy". Kysely skips a
 * migration that has no down method when migrating down.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // IF NOT EXISTS makes a partially-applied deploy safe to re-run.
  await sql`ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'superseded'`.execute(db);
}
