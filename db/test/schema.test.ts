import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  LIVE_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  SLOT_DISPLAY_STATUSES,
  USER_ROLES,
} from '@laqum/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, freshSchema, query, type TestDb } from './helpers.js';

/**
 * Proves the migrations produce the schema the application depends on, by
 * introspecting what Postgres actually built rather than by reading DDL back.
 *
 * This asserts the CURRENT schema: 001_initial plus every migration after it.
 * db/schema.sql remains the byte-for-byte reference copy of 001 alone (see
 * schema-copy.test.ts); the current shape lives here, because with
 * forward-only migrations no single file is the whole picture.
 *
 * Every assertion below is a fact the application depends on. If a future
 * migration changes one, this test fails and the change has to be deliberate.
 */

let ctx: TestDb;

beforeAll(async () => {
  ctx = connectTestDb();
  await freshSchema(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('enum types', () => {
  it('has exactly the six enums, with labels in the declared order', async () => {
    const rows = await query<{ typname: string; enumlabel: string }>(
      ctx.db,
      `SELECT t.typname, e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace
        ORDER BY t.typname, e.enumsortorder`,
    );

    const byType = new Map<string, string[]>();
    for (const row of rows) {
      const labels = byType.get(row.typname) ?? [];
      labels.push(row.enumlabel);
      byType.set(row.typname, labels);
    }

    expect([...byType.keys()].sort()).toEqual([
      'booking_source',
      'booking_status',
      'payment_kind',
      'payment_provider',
      'payment_status',
      'user_role',
    ]);

    // Order matters: it is the enum's sort order, and it is what the brief
    // specified. These also pin packages/shared to the database.
    //
    // payment_status carries 'superseded' from migration 002. ALTER TYPE ADD
    // VALUE appends, so it sorts last — which is why shared lists it last too.
    expect(byType.get('user_role')).toEqual([...USER_ROLES]);
    expect(byType.get('booking_source')).toEqual([...BOOKING_SOURCES]);
    expect(byType.get('booking_status')).toEqual([...BOOKING_STATUSES]);
    expect(byType.get('payment_kind')).toEqual([...PAYMENT_KINDS]);
    expect(byType.get('payment_provider')).toEqual([...PAYMENT_PROVIDERS]);
    expect(byType.get('payment_status')).toEqual([...PAYMENT_STATUSES]);
    expect(byType.get('payment_status')).toEqual(['pending', 'success', 'failed', 'superseded']);
  });
});

describe('tables and columns', () => {
  it('has exactly the eleven specified tables', async () => {
    const rows = await query<{ table_name: string }>(
      ctx.db,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name NOT LIKE 'kysely_%'
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'booking_events',
      'bookings',
      'lot_staff',
      'lots',
      'operators',
      'otp_codes',
      'payments',
      'push_tokens',
      'refresh_tokens',
      'slots',
      'users',
    ]);
  });

  it('has every column with the specified type and nullability', async () => {
    const rows = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      ctx.db,
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.table_name NOT LIKE 'kysely_%'
        ORDER BY c.table_name, c.ordinal_position`,
    );

    const actual = rows.map(
      (r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`,
    );

    // "USER-DEFINED" is how information_schema reports an enum-typed column.
    expect(actual).toEqual([
      'booking_events.id bigint NO',
      'booking_events.booking_id uuid NO',
      'booking_events.from_status USER-DEFINED YES',
      'booking_events.to_status USER-DEFINED NO',
      'booking_events.actor_id uuid YES',
      'booking_events.note text YES',
      'booking_events.at timestamp with time zone NO',

      'bookings.id uuid NO',
      'bookings.lot_id uuid NO',
      'bookings.slot_id uuid NO',
      'bookings.user_id uuid YES',
      'bookings.source USER-DEFINED NO',
      'bookings.status USER-DEFINED NO',
      'bookings.vehicle_plate text YES',
      'bookings.planned_minutes integer YES',
      'bookings.qr_token text YES',
      'bookings.short_code text YES',
      'bookings.hold_expires_at timestamp with time zone YES',
      'bookings.checked_in_at timestamp with time zone YES',
      'bookings.planned_end_at timestamp with time zone YES',
      'bookings.checked_out_at timestamp with time zone YES',
      'bookings.amount_due_santim integer YES',
      'bookings.created_by uuid YES',
      'bookings.created_at timestamp with time zone NO',
      'bookings.updated_at timestamp with time zone NO',

      'lot_staff.lot_id uuid NO',
      'lot_staff.user_id uuid NO',

      'lots.id uuid NO',
      'lots.operator_id uuid NO',
      'lots.name text NO',
      'lots.address text YES',
      'lots.latitude double precision NO',
      'lots.longitude double precision NO',
      'lots.contact_phone text NO',
      'lots.payment_window_minutes integer NO',
      'lots.hold_minutes integer NO',
      'lots.max_booking_distance_m integer NO',
      'lots.block_minutes integer NO',
      'lots.deposit_amount_santim integer NO',
      'lots.rate_per_block_santim integer NO',
      'lots.overstay_rate_per_block_santim integer NO',
      'lots.is_active boolean NO',
      'lots.created_at timestamp with time zone NO',
      // Migration 003: the realtime ordering token.
      'lots.version integer NO',

      'operators.id uuid NO',
      'operators.name text NO',
      'operators.phone text NO',
      'operators.created_at timestamp with time zone NO',

      'otp_codes.id uuid NO',
      'otp_codes.phone text NO',
      'otp_codes.code_hash text NO',
      'otp_codes.attempts integer NO',
      'otp_codes.expires_at timestamp with time zone NO',
      'otp_codes.consumed_at timestamp with time zone YES',
      'otp_codes.created_at timestamp with time zone NO',

      'payments.id uuid NO',
      'payments.booking_id uuid NO',
      'payments.kind USER-DEFINED NO',
      'payments.provider USER-DEFINED NO',
      'payments.amount_santim integer NO',
      'payments.status USER-DEFINED NO',
      'payments.tx_ref text YES',
      'payments.provider_payload jsonb YES',
      'payments.recorded_by uuid YES',
      'payments.created_at timestamp with time zone NO',
      'payments.updated_at timestamp with time zone NO',
      // 004: set only when the provider accepted initialize.
      'payments.checkout_url text YES',

      'push_tokens.id uuid NO',
      'push_tokens.user_id uuid NO',
      'push_tokens.expo_push_token text NO',
      'push_tokens.created_at timestamp with time zone NO',

      'refresh_tokens.id uuid NO',
      'refresh_tokens.user_id uuid NO',
      'refresh_tokens.token_hash text NO',
      'refresh_tokens.expires_at timestamp with time zone NO',
      'refresh_tokens.revoked_at timestamp with time zone YES',
      'refresh_tokens.created_at timestamp with time zone NO',

      'slots.id uuid NO',
      'slots.lot_id uuid NO',
      'slots.label text NO',
      'slots.zone text NO',
      'slots.grid_row integer NO',
      'slots.grid_col integer NO',
      'slots.app_bookable boolean NO',
      'slots.in_service boolean NO',

      'users.id uuid NO',
      'users.phone text NO',
      'users.full_name text YES',
      'users.role USER-DEFINED NO',
      'users.created_at timestamp with time zone NO',
    ]);
  });

  it('stores money as integer santim, never float or numeric', async () => {
    const rows = await query<{ table_name: string; column_name: string; data_type: string }>(
      ctx.db,
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%santim%'
        ORDER BY table_name, column_name`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe('integer');
    }
  });

  it('stores every timestamp as timestamptz, never naive', async () => {
    const rows = await query<{ column_name: string; data_type: string }>(
      ctx.db,
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type LIKE 'timestamp%'
          AND table_name NOT LIKE 'kysely_%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data_type).toBe('timestamp with time zone');
    }
  });
});

describe('the double-booking guard', () => {
  it('builds every partial index with the exact predicate specified', async () => {
    const rows = await query<{ indexname: string; indexdef: string }>(
      ctx.db,
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
        ORDER BY indexname`,
    );
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect([...defs.keys()]).toEqual([
      'bookings_hold_expiry',
      'bookings_live_by_lot',
      'bookings_planned_end',
      'bookings_unpaid_by_user',
      'one_live_booking_per_short_code',
      'one_live_booking_per_slot',
      'one_live_booking_per_user',
      'one_paid_deposit_per_booking',
      'one_paid_final_per_booking',
    ]);

    const live =
      "(status = ANY (ARRAY['PENDING_PAYMENT'::booking_status, 'RESERVED'::booking_status, 'CHECKED_IN'::booking_status, 'OVERSTAY'::booking_status]))";

    expect(defs.get('one_live_booking_per_slot')).toBe(
      `CREATE UNIQUE INDEX one_live_booking_per_slot ON public.bookings USING btree (slot_id) WHERE ${live}`,
    );
    expect(defs.get('one_live_booking_per_user')).toBe(
      `CREATE UNIQUE INDEX one_live_booking_per_user ON public.bookings USING btree (user_id) WHERE ((user_id IS NOT NULL) AND ${live})`,
    );
    expect(defs.get('one_live_booking_per_short_code')).toBe(
      `CREATE UNIQUE INDEX one_live_booking_per_short_code ON public.bookings USING btree (short_code) WHERE ((short_code IS NOT NULL) AND ${live})`,
    );
    expect(defs.get('bookings_live_by_lot')).toBe(
      `CREATE INDEX bookings_live_by_lot ON public.bookings USING btree (lot_id) WHERE ${live}`,
    );
    expect(defs.get('bookings_hold_expiry')).toBe(
      "CREATE INDEX bookings_hold_expiry ON public.bookings USING btree (hold_expires_at) WHERE (status = ANY (ARRAY['PENDING_PAYMENT'::booking_status, 'RESERVED'::booking_status]))",
    );
    expect(defs.get('bookings_planned_end')).toBe(
      "CREATE INDEX bookings_planned_end ON public.bookings USING btree (planned_end_at) WHERE (status = 'CHECKED_IN'::booking_status)",
    );
    expect(defs.get('bookings_unpaid_by_user')).toBe(
      "CREATE INDEX bookings_unpaid_by_user ON public.bookings USING btree (user_id) WHERE (status = 'CHECKED_OUT'::booking_status)",
    );
    expect(defs.get('one_paid_deposit_per_booking')).toBe(
      "CREATE UNIQUE INDEX one_paid_deposit_per_booking ON public.payments USING btree (booking_id) WHERE ((kind = 'deposit'::payment_kind) AND (status = 'success'::payment_status))",
    );
    expect(defs.get('one_paid_final_per_booking')).toBe(
      "CREATE UNIQUE INDEX one_paid_final_per_booking ON public.payments USING btree (booking_id) WHERE ((kind = 'final'::payment_kind) AND (status = 'success'::payment_status))",
    );
  });

  it("agrees with the shared package's LIVE_STATUSES list", async () => {
    // packages/shared says LIVE_STATUSES is written down in exactly one place.
    // This proves that place matches what the database enforces, by reading
    // the statuses back out of the index predicates themselves.
    const rows = await query<{ indexname: string; indexdef: string }>(
      ctx.db,
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('one_live_booking_per_slot', 'one_live_booking_per_user',
                            'one_live_booking_per_short_code', 'bookings_live_by_lot')`,
    );
    expect(rows).toHaveLength(4);

    for (const row of rows) {
      const statuses = [...row.indexdef.matchAll(/'([A-Z_]+)'::booking_status/gu)].map((m) => m[1]);
      expect(statuses, `index ${row.indexname}`).toEqual([...LIVE_STATUSES]);
    }
  });
});

describe('constraints', () => {
  it('ties a booking to its slot with a composite foreign key', async () => {
    const rows = await query<{ def: string }>(
      ctx.db,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND contype = 'f'
        ORDER BY conname`,
    );
    const defs = rows.map((r) => r.def);

    // This is what makes "a booking's lot is its slot's lot" impossible to
    // violate, and it is why bookings.lot_id needs no separate FK to lots.
    expect(defs).toContain('FOREIGN KEY (slot_id, lot_id) REFERENCES slots(id, lot_id)');
    expect(defs).toContain('FOREIGN KEY (user_id) REFERENCES users(id)');
    expect(defs).toContain('FOREIGN KEY (created_by) REFERENCES users(id)');
  });

  it('has the composite unique key on slots that the FK targets', async () => {
    const rows = await query<{ def: string }>(
      ctx.db,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'slots'::regclass AND contype = 'u'`,
    );
    const defs = rows.map((r) => r.def);
    expect(defs).toContain('UNIQUE (id, lot_id)');
    expect(defs).toContain('UNIQUE (lot_id, label)');
    expect(defs).toContain('UNIQUE (lot_id, zone, grid_row, grid_col)');
  });

  it('enforces the app-booking check constraints', async () => {
    const rows = await query<{ conname: string; def: string }>(
      ctx.db,
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.def]));

    expect(byName.get('app_booking_has_user')).toBe(
      "CHECK (((source = 'walk_in'::booking_source) OR (user_id IS NOT NULL)))",
    );
    expect(byName.get('app_booking_has_qr')).toBe(
      "CHECK (((source = 'walk_in'::booking_source) OR (qr_token IS NOT NULL)))",
    );
    expect(byName.get('app_booking_has_code')).toBe(
      "CHECK (((source = 'walk_in'::booking_source) OR (short_code IS NOT NULL)))",
    );
    expect(byName.get('app_booking_has_plan')).toBe(
      "CHECK (((source = 'walk_in'::booking_source) OR (planned_minutes IS NOT NULL)))",
    );
    expect(byName.get('bookings_short_code_check')).toBe(
      "CHECK ((short_code ~ '^[A-HJ-NP-Z2-9]{6}$'::text))",
    );
  });

  it('enforces the payment check constraints', async () => {
    const rows = await query<{ conname: string; def: string }>(
      ctx.db,
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'payments'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    const byName = new Map(rows.map((r) => [r.conname, r.def]));

    expect(byName.get('cash_has_recorder')).toBe(
      "CHECK (((provider <> 'cash'::payment_provider) OR (recorded_by IS NOT NULL)))",
    );
    expect(byName.get('online_has_ref')).toBe(
      "CHECK (((provider = 'cash'::payment_provider) OR (tx_ref IS NOT NULL)))",
    );
    expect(byName.get('payments_amount_santim_check')).toBe('CHECK ((amount_santim > 0))');
  });
});

describe('slot_status view', () => {
  it('exists as a view, so slot status is derived and never stored', async () => {
    const views = await query<{ table_name: string }>(
      ctx.db,
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
    );
    expect(views.map((v) => v.table_name)).toEqual(['slot_status']);

    // The guarantee behind "no status column on slots".
    const slotColumns = await query<{ column_name: string }>(
      ctx.db,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'slots'`,
    );
    expect(slotColumns.map((c) => c.column_name)).not.toContain('status');
    expect(slotColumns.map((c) => c.column_name)).not.toContain('display_status');
  });

  it('exposes exactly the columns the dashboard grid reads', async () => {
    const rows = await query<{ column_name: string }>(
      ctx.db,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'slot_status'
        ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'slot_id',
      'lot_id',
      'label',
      'zone',
      'grid_row',
      'grid_col',
      'app_bookable',
      'in_service',
      'display_status',
      'booking_id',
      'source',
      'vehicle_plate',
      'hold_expires_at',
      'planned_end_at',
      'updated_at',
    ]);
  });

  it('can only produce the display statuses the shared package declares', async () => {
    // Read the literals out of the view definition itself.
    const [row] = await query<{ def: string }>(
      ctx.db,
      `SELECT pg_get_viewdef('slot_status'::regclass, true) AS def`,
    );
    const def = row?.def ?? '';
    const emitted = new Set([...def.matchAll(/THEN '([a-z_]+)'::text/gu)].map((m) => m[1]));
    emitted.add('free'); // the ELSE branch

    expect([...emitted].sort()).toEqual([...SLOT_DISPLAY_STATUSES].sort());
  });
});
