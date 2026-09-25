import { type Kysely, sql } from 'kysely';

/**
 * The default booking radius: 5 km, not the brief's 10 km.
 *
 * APPROVED DEVIATION (CLAUDE.md, "Booking radius"): a 15-minute hold in Addis
 * traffic covers about 5 km, and 10 km means holds that expire before the
 * driver arrives. The 1 km floor is enforced by the admin API
 * (createLotSchema, updateLotSchema), not here: the development seed's TEST
 * LOT is deliberately smaller.
 *
 * The default only: existing lots keep the radius they were created with, as
 * an operator may have chosen it. The literal is frozen here, like every
 * migration; db/test/schema.test.ts asserts it equals DEFAULT_BOOKING_RADIUS_M.
 *
 * Forward-only: no down. See CLAUDE.md, "Migration policy".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE lots
      ALTER COLUMN max_booking_distance_m SET DEFAULT 5000
  `.execute(db);
}
