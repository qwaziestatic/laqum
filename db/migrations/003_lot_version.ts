import { type Kysely, sql } from 'kysely';

/**
 * Adds lots.version: a commit-ordered sequence number per lot.
 *
 * WHY NOT updated_at. Realtime clients need to tell a stale buffered event
 * from a fresh one. `bookings.updated_at` cannot do that job, for two
 * independent reasons:
 *
 *   1. A FREE slot has no live booking. slot_status LEFT JOINs bookings, so
 *      its updated_at is NULL. A stale buffered "occupied" event carries a
 *      timestamp; the snapshot row carries nothing to compare it against, and
 *      the stale event wins over a newer "free" snapshot.
 *
 *   2. With more than one API instance, updated_at comes from two machines'
 *      wall clocks. Those are not mutually ordered, so comparing them across
 *      instances is meaningless however well they are synchronised.
 *
 * A per-lot counter fixes both. Every booking status change increments it in
 * THE SAME TRANSACTION as the change, so the row lock on lots serialises the
 * increments and versions are handed out in COMMIT order — not in clock order,
 * and not per-instance. A free slot is covered because the version belongs to
 * the lot, not to a booking that may not exist.
 *
 * integer, not bigint: one increment per booking status change means even
 * 10,000 changes a day would take roughly 570 years to reach 2^31. bigint maps
 * to a JS string in Kysely, which would put a string comparison in the middle
 * of the ordering rule — precisely where a subtle bug would hide.
 *
 * Forward-only: no down. See CLAUDE.md, "Migration policy".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE lots
      ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0
  `.execute(db);
}
