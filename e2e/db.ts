import { createDb, createPool, type Database } from '@laqum/db';
import type { Kysely } from 'kysely';

/**
 * Direct database access for the two slot states the DASHBOARD cannot create.
 *
 * An attendant cannot make a booking RESERVED (a driver does that from the
 * mobile app, which is Phase 4) and cannot make one OVERSTAY (time does that).
 * Both states must appear in the screenshots, so the test writes them.
 *
 * Deliberately NOT a test-only API endpoint. A `/v1/e2e/...` route would be
 * real, shippable surface area guarded only by an environment check — exactly
 * the kind of thing that survives into production. A test reaching into the
 * test database reaches nothing else.
 */

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';

export async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const pool = createPool({ connectionString: TEST_DATABASE_URL });
  const db = createDb(pool);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

export interface SeededStates {
  reservedSlotLabel: string;
  overstaySlotLabel: string;
}

/**
 * Put one slot into RESERVED and one into OVERSTAY in the named lot.
 *
 * The lot version is bumped for each, exactly as a real transition would, so
 * any dashboard already connected receives a consistent view on its next
 * snapshot rather than a change the version never accounted for.
 */
export async function seedDisplayStates(lotName: string, labels: SeededStates): Promise<void> {
  await withDb(async (db) => {
    const lot = await db
      .selectFrom('lots')
      .select(['id'])
      .where('name', '=', lotName)
      .executeTakeFirstOrThrow();

    const driver = await db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'driver')
      .executeTakeFirstOrThrow();

    const slotFor = async (label: string): Promise<string> => {
      const row = await db
        .selectFrom('slots')
        .select('id')
        .where('lot_id', '=', lot.id)
        .where('label', '=', label)
        .executeTakeFirstOrThrow();
      return row.id;
    };

    const now = new Date();
    const reservedSlot = await slotFor(labels.reservedSlotLabel);
    const overstaySlot = await slotFor(labels.overstaySlotLabel);

    // RESERVED: held, not yet arrived.
    await db
      .insertInto('bookings')
      .values({
        lot_id: lot.id,
        slot_id: reservedSlot,
        user_id: driver.id,
        source: 'app',
        status: 'RESERVED',
        planned_minutes: 60,
        qr_token: `e2e-reserved-${String(Date.now())}`,
        // The alphabet excludes 0/O/1/I so a code read aloud cannot be
        // mistyped; the column has a CHECK constraint enforcing it.
        short_code: 'RSVD23',
        hold_expires_at: new Date(now.getTime() + 15 * 60_000),
        created_at: now,
        updated_at: now,
      })
      .execute();

    /*
     * OVERSTAY: checked in, and planned_end_at already passed.
     *
     * No user, so it does not trip one_live_booking_per_user against the
     * RESERVED booking above — the same seeded driver cannot hold two live
     * bookings, and that constraint is correct.
     */
    await db
      .insertInto('bookings')
      .values({
        lot_id: lot.id,
        slot_id: overstaySlot,
        user_id: null,
        source: 'walk_in',
        status: 'OVERSTAY',
        vehicle_plate: 'AA-90909',
        planned_minutes: null,
        checked_in_at: new Date(now.getTime() - 3 * 60 * 60_000),
        planned_end_at: new Date(now.getTime() - 60 * 60_000),
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Two changes, two versions — the same accounting a real transition does.
    await db
      .updateTable('lots')
      .set((eb) => ({ version: eb('version', '+', 2) }))
      .where('id', '=', lot.id)
      .execute();
  });
}
