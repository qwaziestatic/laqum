import type { Database } from '@laqum/db';
import type { Kysely } from 'kysely';

/**
 * Minimal, explicit fixtures. Each test builds exactly the lot it needs, so a
 * failure points at the test's own data rather than at the shared dev seed.
 */

export interface LotOptions {
  name?: string;
  slots?: number;
  blockMinutes?: number;
  depositSantim?: number;
  ratePerBlockSantim?: number;
  overstayRatePerBlockSantim?: number;
  paymentWindowMinutes?: number;
  holdMinutes?: number;
  maxBookingDistanceM?: number;
  latitude?: number;
  longitude?: number;
}

export interface LotFixture {
  operatorId: string;
  lotId: string;
  slotIds: string[];
  latitude: number;
  longitude: number;
}

export async function createUser(
  db: Kysely<Database>,
  role: 'driver' | 'attendant' | 'operator_admin',
  phone: string,
): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ phone, role, full_name: `${role} ${phone}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A lot with `slots` app-bookable, in-service slots in a single zone. */
export async function createLot(
  db: Kysely<Database>,
  options: LotOptions = {},
): Promise<LotFixture> {
  const latitude = options.latitude ?? 9.0092;
  const longitude = options.longitude ?? 38.7869;

  const operator = await db
    .insertInto('operators')
    .values({ name: 'Test Operator', phone: '+251911000900' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const lot = await db
    .insertInto('lots')
    .values({
      operator_id: operator.id,
      name: options.name ?? 'Test Lot',
      address: 'Addis Ababa',
      latitude,
      longitude,
      contact_phone: '+251911000901',
      block_minutes: options.blockMinutes ?? 30,
      deposit_amount_santim: options.depositSantim ?? 0,
      rate_per_block_santim: options.ratePerBlockSantim ?? 2000,
      overstay_rate_per_block_santim: options.overstayRatePerBlockSantim ?? 4000,
      payment_window_minutes: options.paymentWindowMinutes ?? 3,
      hold_minutes: options.holdMinutes ?? 15,
      max_booking_distance_m: options.maxBookingDistanceM ?? 10_000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const count = options.slots ?? 1;
  const slotIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const slot = await db
      .insertInto('slots')
      .values({
        lot_id: lot.id,
        label: `A-${String(i + 1)}`,
        zone: 'main',
        grid_row: 0,
        grid_col: i,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    slotIds.push(slot.id);
  }

  return { operatorId: operator.id, lotId: lot.id, slotIds, latitude, longitude };
}

/**
 * Insert a booking directly, bypassing createBooking, so a test can start from
 * any state without walking the whole machine to get there.
 */
export async function seedBooking(
  db: Kysely<Database>,
  args: {
    lotId: string;
    slotId: string;
    userId?: string | null;
    source?: 'app' | 'walk_in';
    status: 'PENDING_PAYMENT' | 'RESERVED' | 'CHECKED_IN' | 'OVERSTAY' | 'CHECKED_OUT';
    plannedMinutes?: number | null;
    checkedInAt?: Date | null;
    plannedEndAt?: Date | null;
    holdExpiresAt?: Date | null;
    qrToken?: string;
    shortCode?: string;
    at?: Date;
  },
): Promise<string> {
  const source = args.source ?? 'app';
  const at = args.at ?? new Date('2026-03-01T08:00:00.000Z');
  const isApp = source === 'app';

  const row = await db
    .insertInto('bookings')
    .values({
      lot_id: args.lotId,
      slot_id: args.slotId,
      user_id: args.userId ?? null,
      source,
      status: args.status,
      planned_minutes: args.plannedMinutes ?? (isApp ? 60 : null),
      qr_token: isApp ? (args.qrToken ?? `qr-${crypto.randomUUID()}`) : null,
      short_code: isApp ? (args.shortCode ?? randomShortCode()) : null,
      checked_in_at: args.checkedInAt ?? null,
      planned_end_at: args.plannedEndAt ?? null,
      hold_expires_at: args.holdExpiresAt ?? null,
      created_at: at,
      updated_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('booking_events')
    .values({
      booking_id: row.id,
      from_status: null,
      to_status: args.status,
      actor_id: args.userId ?? null,
      at,
    })
    .execute();

  return row.id;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomShortCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
  }
  return code;
}
