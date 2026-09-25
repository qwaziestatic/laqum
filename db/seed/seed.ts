/**
 * Development seed data.
 *
 *   pnpm --filter @laqum/db seed
 *
 * Deterministic on purpose: no faker. Tests assert against these rows, and a
 * seed that changes between runs makes failures impossible to reproduce.
 *
 * Idempotent: it clears the tables it owns and reinserts. Safe to re-run.
 */
import { DEFAULT_BOOKING_RADIUS_M, DISPLAY_TIMEZONE } from '@laqum/shared';
import type { Kysely } from 'kysely';
import { createDb, createPool, type Database } from '../src/index.js';

interface ZoneSpec {
  zone: string;
  rows: number;
  cols: number;
  /** Row letters start here, so zones within a lot get distinct labels. */
  labelPrefix: string;
}

interface LotSpec {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  contact_phone: string;
  block_minutes: number;
  deposit_amount_santim: number;
  rate_per_block_santim: number;
  overstay_rate_per_block_santim: number;
  zones: ZoneSpec[];
  /** Labels kept off the app, as a walk-in / overstay buffer. */
  notAppBookable: string[];
  /** Labels blocked or under repair. */
  outOfService: string[];
}

/**
 * Two real Addis Ababa locations.
 *
 * The lots differ deliberately: Bole charges a deposit and has one large zone,
 * Piassa has a zero deposit and two zones. That covers both booking entry
 * points in the state machine (deposit > 0 -> PENDING_PAYMENT, deposit = 0 ->
 * RESERVED) and the multi-zone grid the dashboard has to render.
 */
const LOTS: LotSpec[] = [
  {
    name: 'Bole Medhanialem Parking',
    address: 'Bole Medhanialem, Bole Sub-city, Addis Ababa',
    latitude: 9.0092,
    longitude: 38.7869,
    contact_phone: '+251911234501',
    block_minutes: 30,
    deposit_amount_santim: 2000, // 20 ETB
    rate_per_block_santim: 2000, // 20 ETB per 30 minutes
    overstay_rate_per_block_santim: 4000, // 40 ETB per 30 minutes over
    zones: [{ zone: 'main', rows: 6, cols: 8, labelPrefix: 'A' }],
    notAppBookable: ['F-7', 'F-8'],
    outOfService: ['C-4'],
  },
  {
    name: 'Piassa Central Parking',
    address: 'Piassa, Arada Sub-city, Addis Ababa',
    latitude: 9.0348,
    longitude: 38.7508,
    contact_phone: '+251911234502',
    block_minutes: 30,
    deposit_amount_santim: 0, // no deposit: books straight to RESERVED
    rate_per_block_santim: 1500, // 15 ETB per 30 minutes
    overstay_rate_per_block_santim: 3000,
    zones: [
      { zone: 'ground', rows: 4, cols: 4, labelPrefix: 'G' },
      { zone: 'upper', rows: 2, cols: 4, labelPrefix: 'U' },
    ],
    // 'upper' is 2 rows from prefix 'U', so its labels are U-1..U-4 and
    // V-1..V-4. Row letters advance; column numbers do not continue across rows.
    notAppBookable: ['V-4'],
    outOfService: [],
  },
];

const OPERATOR = {
  name: 'Sunrise Hospitality PLC',
  phone: '+251911234500',
};

const ATTENDANT = {
  phone: '+251911000001',
  full_name: 'Aster Bekele',
  role: 'attendant',
} as const;

const DRIVER = {
  phone: '+251911000002',
  full_name: 'Dawit Haile',
  role: 'driver',
} as const;

interface SlotRow {
  label: string;
  zone: string;
  grid_row: number;
  grid_col: number;
  app_bookable: boolean;
  in_service: boolean;
}

/** Grid labels are `<prefix+row letter>-<1-based column>`, e.g. 'A-1', 'F-8'. */
export function buildSlots(spec: LotSpec): SlotRow[] {
  const slots: SlotRow[] = [];
  for (const zone of spec.zones) {
    const base = zone.labelPrefix.charCodeAt(0);
    for (let row = 0; row < zone.rows; row++) {
      for (let col = 0; col < zone.cols; col++) {
        const label = `${String.fromCharCode(base + row)}-${col + 1}`;
        slots.push({
          label,
          zone: zone.zone,
          grid_row: row,
          grid_col: col,
          app_bookable: !spec.notAppBookable.includes(label),
          in_service: !spec.outOfService.includes(label),
        });
      }
    }
  }

  // A label in notAppBookable or outOfService that matches no slot is a typo
  // that would otherwise pass silently, leaving the flag unapplied and the
  // seed subtly wrong. Fail loudly instead.
  const labels = new Set(slots.map((s) => s.label));
  for (const label of [...spec.notAppBookable, ...spec.outOfService]) {
    if (!labels.has(label)) {
      throw new Error(`Lot "${spec.name}" flags slot "${label}", which its grid does not contain.`);
    }
  }

  return slots;
}

async function clear(db: Kysely<Database>): Promise<void> {
  // Child-first, so no foreign key is ever left dangling. bookings and
  // payments are empty in a fresh seed but are cleared for re-runs.
  await db.deleteFrom('booking_events').execute();
  await db.deleteFrom('payments').execute();
  await db.deleteFrom('bookings').execute();
  await db.deleteFrom('lot_staff').execute();
  await db.deleteFrom('slots').execute();
  await db.deleteFrom('lots').execute();
  await db.deleteFrom('operators').execute();
  await db.deleteFrom('push_tokens').execute();
  await db.deleteFrom('refresh_tokens').execute();
  await db.deleteFrom('otp_codes').execute();
  await db.deleteFrom('users').execute();
}

/**
 * A lot AT THE TESTER'S OWN COORDINATES, for device testing.
 *
 * Arrival, live distance, the location gate and the countdowns are all
 * geography-dependent, and the seeded Addis lots are no use to someone
 * standing anywhere else. Set SEED_TEST_LOT_LAT and SEED_TEST_LOT_LNG and this
 * adds a small lot there.
 *
 * Deliberately IMPATIENT: a 5-minute block and a 3-minute hold, so a countdown
 * can be watched from start to expiry inside one test session rather than
 * waiting half an hour to learn whether expiry works.
 *
 * REFUSED IN PRODUCTION — twice over. main() already throws when NODE_ENV is
 * production, and this function throws independently, so importing seed() from
 * somewhere else cannot route around the check.
 */
export interface TestLotOptions {
  latitude: number;
  longitude: number;
  /** Booking radius. Small, so walking a block flips the location gate. */
  radiusM: number;
}

export const TEST_LOT_NAME = 'TEST LOT (device testing)';

export function testLotFromEnv(env: NodeJS.ProcessEnv = process.env): TestLotOptions | null {
  const lat = env['SEED_TEST_LOT_LAT'];
  const lng = env['SEED_TEST_LOT_LNG'];
  if (lat === undefined && lng === undefined) return null;

  if (env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a test lot: NODE_ENV is production.');
  }
  if (lat === undefined || lng === undefined) {
    throw new Error('Set BOTH SEED_TEST_LOT_LAT and SEED_TEST_LOT_LNG, or neither.');
  }

  /*
   * Trimmed and rejected when empty, NOT passed to Number().
   *
   * `Number('')` is 0, so an exported-but-empty SEED_TEST_LOT_LAT would
   * silently place the test lot at latitude 0 — in the Atlantic, several
   * thousand kilometres from anyone — and every booking would fail TOO_FAR
   * for a reason nobody would guess.
   */
  const latitude = lat.trim() === '' ? Number.NaN : Number(lat);
  const longitude = lng.trim() === '' ? Number.NaN : Number(lng);

  // Validated rather than trusted: a swapped pair or a stray character would
  // otherwise produce a lot in the sea and a confusing TOO_FAR every time.
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`SEED_TEST_LOT_LAT must be a number between -90 and 90; got ${lat}`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`SEED_TEST_LOT_LNG must be a number between -180 and 180; got ${lng}`);
  }

  const radiusRaw = env['SEED_TEST_LOT_RADIUS_M'] ?? '150';
  const radiusM = radiusRaw.trim() === '' ? Number.NaN : Number(radiusRaw);
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error(`SEED_TEST_LOT_RADIUS_M must be a positive number; got ${radiusRaw}`);
  }

  return { latitude, longitude, radiusM };
}

function testLotSpec(options: TestLotOptions): LotSpec {
  return {
    name: TEST_LOT_NAME,
    address: 'Created from SEED_TEST_LOT_LAT/LNG for device testing',
    latitude: options.latitude,
    longitude: options.longitude,
    contact_phone: '+251911000000',
    // Short everything: a full book -> hold -> expire cycle in minutes.
    block_minutes: 5,
    deposit_amount_santim: 0,
    rate_per_block_santim: 500,
    overstay_rate_per_block_santim: 1000,
    // One 2x3 zone: six slots is enough to fill a lot by hand and watch
    // LOT_FULL, without a grid that needs scrolling on a phone.
    zones: [{ zone: 'test', rows: 2, cols: 3, labelPrefix: 'T' }],
    notAppBookable: [],
    outOfService: [],
  };
}

export async function seed(
  db: Kysely<Database>,
  testLot: TestLotOptions | null = null,
): Promise<void> {
  const lots = testLot ? [...LOTS, testLotSpec(testLot)] : LOTS;

  await db.transaction().execute(async (trx) => {
    await clear(trx);

    const operator = await trx
      .insertInto('operators')
      .values(OPERATOR)
      .returning('id')
      .executeTakeFirstOrThrow();

    const attendant = await trx
      .insertInto('users')
      .values(ATTENDANT)
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx.insertInto('users').values(DRIVER).execute();

    for (const spec of lots) {
      const lot = await trx
        .insertInto('lots')
        .values({
          operator_id: operator.id,
          name: spec.name,
          address: spec.address,
          latitude: spec.latitude,
          longitude: spec.longitude,
          contact_phone: spec.contact_phone,
          block_minutes: spec.block_minutes,
          deposit_amount_santim: spec.deposit_amount_santim,
          rate_per_block_santim: spec.rate_per_block_santim,
          overstay_rate_per_block_santim: spec.overstay_rate_per_block_santim,
          // Explicit rather than the column default: 5 km, what a 15-minute
          // hold can reach in Addis traffic (constants.ts).
          max_booking_distance_m: DEFAULT_BOOKING_RADIUS_M,
          // The test lot overrides the schema defaults so a hold expires in
          // minutes, and its radius so walking a block flips the gate.
          ...(spec.name === TEST_LOT_NAME && testLot
            ? {
                hold_minutes: 3,
                payment_window_minutes: 3,
                max_booking_distance_m: Math.round(testLot.radiusM),
              }
            : {}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const slots = buildSlots(spec);
      await trx
        .insertInto('slots')
        .values(slots.map((s) => ({ ...s, lot_id: lot.id })))
        .execute();

      // The attendant works both lots.
      await trx.insertInto('lot_staff').values({ lot_id: lot.id, user_id: attendant.id }).execute();
    }
  });
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  const url = process.env['SEED_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env, or export it.');
  }

  // Throws on its own if NODE_ENV is production, so this cannot be reached
  // in production even if the guard above were removed.
  const testLot = testLotFromEnv();

  const pool = createPool({ connectionString: url });
  const db = createDb(pool);
  try {
    await seed(db, testLot);
    const totals = await db
      .selectFrom('slots')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    const lotCount = LOTS.length + (testLot ? 1 : 0);
    console.warn(
      `Seeded ${String(lotCount)} lots with ${String(totals.count)} slots. Times display in ${DISPLAY_TIMEZONE}.`,
    );
    if (testLot) {
      console.warn(
        `TEST LOT at ${String(testLot.latitude)}, ${String(testLot.longitude)} — ` +
          `${String(testLot.radiusM)} m radius, 5 min blocks, 3 min hold.`,
      );
    }
  } finally {
    await db.destroy();
  }
}

// Only run when invoked directly, so tests can import seed() without side
// effects. import.meta.main is Node 24+; comparing argv[1] to a file URL is
// the fragile alternative, especially on Windows paths.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
