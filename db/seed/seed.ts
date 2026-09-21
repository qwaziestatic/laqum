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
import { DISPLAY_TIMEZONE } from '@laqum/shared';
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

export async function seed(db: Kysely<Database>): Promise<void> {
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

    for (const spec of LOTS) {
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

  const pool = createPool({ connectionString: url });
  const db = createDb(pool);
  try {
    await seed(db);
    const totals = await db
      .selectFrom('slots')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    console.warn(
      `Seeded ${String(LOTS.length)} lots with ${String(totals.count)} slots. Times display in ${DISPLAY_TIMEZONE}.`,
    );
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
