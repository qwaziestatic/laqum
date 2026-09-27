import { type Kysely, sql } from 'kysely';

/**
 * The language each device's notifications are written in.
 *
 * Decided by the product owner (Phase 5, D3): the language lives with the
 * push token, because the server has no other way to know it (the app keeps
 * the driver's choice on the phone), and the app registers again whenever
 * the language changes. Existing tokens get Amharic, the app's default.
 *
 * Forward-only: no down. See CLAUDE.md, "Migration policy".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE push_tokens
      ADD COLUMN locale text NOT NULL DEFAULT 'am'
      CONSTRAINT push_tokens_locale_known CHECK (locale IN ('am', 'en'))
  `.execute(db);
}
