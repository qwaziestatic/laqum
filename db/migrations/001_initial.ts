import { type Kysely, sql } from 'kysely';

/**
 * The initial schema, exactly as reviewed and specified in the project brief.
 *
 * INITIAL_SCHEMA_SQL below is the source of truth. db/schema.sql is a
 * reference copy of the same bytes, and db/test/schema-copy.test.ts asserts
 * the two are identical, so the copy can never silently drift.
 *
 * The whole script is sent to Postgres in ONE sql.raw() call, so what the
 * database receives is character-for-character what is written here. Kysely
 * runs each migration inside a transaction and Postgres is transactional for
 * DDL, so this either fully applies or fully rolls back.
 *
 * Do not rename, reorder, or "simplify" anything in this string. Changes to
 * the schema belong in a new migration.
 */
export const INITIAL_SCHEMA_SQL = `-- ─── Enums ───────────────────────────────────────────────────────────────
CREATE TYPE user_role        AS ENUM ('driver', 'attendant', 'operator_admin');
CREATE TYPE booking_source   AS ENUM ('app', 'walk_in');
CREATE TYPE booking_status   AS ENUM (
  'PENDING_PAYMENT',  -- slot held while the deposit is being paid
  'RESERVED',         -- deposit paid, driver en route
  'CHECKED_IN',       -- car is in the slot
  'OVERSTAY',         -- planned end passed, car still there
  'CHECKED_OUT',      -- car left, bill computed, slot freed
  'PAID',             -- final bill settled
  'EXPIRED',          -- payment window or hold window lapsed
  'CANCELLED'         -- driver cancelled before arrival
);
CREATE TYPE payment_kind     AS ENUM ('deposit', 'final', 'refund');
CREATE TYPE payment_provider AS ENUM ('chapa', 'telebirr', 'cash');
CREATE TYPE payment_status   AS ENUM ('pending', 'success', 'failed');

-- ─── People and auth ─────────────────────────────────────────────────────
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text NOT NULL UNIQUE,              -- E.164, login identity
  full_name  text,
  role       user_role NOT NULL DEFAULT 'driver',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_by_phone ON otp_codes (phone, created_at DESC);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_by_user ON refresh_tokens (user_id);

CREATE TABLE push_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operators (                        -- a hotel, a company: the owner of lots
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Lots and slots ──────────────────────────────────────────────────────
CREATE TABLE lots (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id                     uuid NOT NULL REFERENCES operators(id),
  name                            text NOT NULL,
  address                         text,
  latitude                        double precision NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude                       double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  contact_phone                   text NOT NULL,  -- tap-to-call target
  payment_window_minutes          int NOT NULL DEFAULT 3     CHECK (payment_window_minutes > 0),
  hold_minutes                    int NOT NULL DEFAULT 15    CHECK (hold_minutes > 0),
  max_booking_distance_m          int NOT NULL DEFAULT 10000 CHECK (max_booking_distance_m > 0),
  block_minutes                   int NOT NULL DEFAULT 30    CHECK (block_minutes > 0),
  deposit_amount_santim           int NOT NULL DEFAULT 0     CHECK (deposit_amount_santim >= 0),
  rate_per_block_santim           int NOT NULL CHECK (rate_per_block_santim >= 0),
  overstay_rate_per_block_santim  int NOT NULL CHECK (overstay_rate_per_block_santim >= 0),
  is_active                       boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lot_staff (                        -- which attendants/admins work which lot
  lot_id  uuid NOT NULL REFERENCES lots(id)  ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (lot_id, user_id)
);

CREATE TABLE slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id       uuid NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  label        text NOT NULL,                   -- painted on the ground: 'A-12'
  zone         text NOT NULL DEFAULT 'main',    -- floor or section
  grid_row     int  NOT NULL CHECK (grid_row >= 0),
  grid_col     int  NOT NULL CHECK (grid_col >= 0),
  app_bookable boolean NOT NULL DEFAULT true,   -- false = kept for walk-ins / overstay buffer
  in_service   boolean NOT NULL DEFAULT true,   -- false = blocked or under repair
  UNIQUE (lot_id, label),
  UNIQUE (lot_id, zone, grid_row, grid_col),
  UNIQUE (id, lot_id)                           -- target for the composite FK below
);

-- ─── Bookings ────────────────────────────────────────────────────────────
CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id            uuid NOT NULL,
  slot_id           uuid NOT NULL,
  user_id           uuid REFERENCES users(id),  -- NULL for walk-ins
  source            booking_source NOT NULL,
  status            booking_status NOT NULL,
  vehicle_plate     text,
  planned_minutes   int CHECK (planned_minutes > 0),
  qr_token          text UNIQUE,                -- NULL for walk-ins
  short_code        text CHECK (short_code ~ '^[A-HJ-NP-Z2-9]{6}$'),  -- manual QR fallback; no 0/O/1/I
  hold_expires_at   timestamptz,                -- payment window, then arrival window
  checked_in_at     timestamptz,
  planned_end_at    timestamptz,
  checked_out_at    timestamptz,
  amount_due_santim int CHECK (amount_due_santim >= 0),  -- set at checkout, deposit already credited
  created_by        uuid REFERENCES users(id),  -- attendant for walk-ins
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),  -- set by transition(); clients use it to drop stale events

  FOREIGN KEY (slot_id, lot_id) REFERENCES slots (id, lot_id),  -- a booking's lot is its slot's lot

  CONSTRAINT app_booking_has_user  CHECK (source = 'walk_in' OR user_id    IS NOT NULL),
  CONSTRAINT app_booking_has_qr    CHECK (source = 'walk_in' OR qr_token   IS NOT NULL),
  CONSTRAINT app_booking_has_code  CHECK (source = 'walk_in' OR short_code IS NOT NULL),
  CONSTRAINT app_booking_has_plan  CHECK (source = 'walk_in' OR planned_minutes IS NOT NULL)
);

-- THE double-booking guard: at most one live booking per slot.
CREATE UNIQUE INDEX one_live_booking_per_slot ON bookings (slot_id)
  WHERE status IN ('PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY');

-- One live booking per driver.
CREATE UNIQUE INDEX one_live_booking_per_user ON bookings (user_id)
  WHERE user_id IS NOT NULL
    AND status IN ('PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY');

-- Short codes are unique among live bookings (they are reused over time).
CREATE UNIQUE INDEX one_live_booking_per_short_code ON bookings (short_code)
  WHERE short_code IS NOT NULL
    AND status IN ('PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY');

CREATE INDEX bookings_live_by_lot ON bookings (lot_id)
  WHERE status IN ('PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY');
CREATE INDEX bookings_hold_expiry ON bookings (hold_expires_at)
  WHERE status IN ('PENDING_PAYMENT', 'RESERVED');
CREATE INDEX bookings_planned_end ON bookings (planned_end_at)
  WHERE status = 'CHECKED_IN';
CREATE INDEX bookings_unpaid_by_user ON bookings (user_id)
  WHERE status = 'CHECKED_OUT';

-- ─── Payments ────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES bookings(id),
  kind             payment_kind NOT NULL,
  provider         payment_provider NOT NULL,
  amount_santim    int NOT NULL CHECK (amount_santim > 0),
  status           payment_status NOT NULL DEFAULT 'pending',
  tx_ref           text UNIQUE,                 -- our reference sent to the provider; makes webhooks idempotent
  provider_payload jsonb,                       -- raw verify response, for disputes
  recorded_by      uuid REFERENCES users(id),   -- attendant, for cash
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_has_recorder CHECK (provider <> 'cash' OR recorded_by IS NOT NULL),
  CONSTRAINT online_has_ref    CHECK (provider =  'cash' OR tx_ref      IS NOT NULL)
);
CREATE INDEX payments_by_booking ON payments (booking_id);

CREATE UNIQUE INDEX one_paid_deposit_per_booking ON payments (booking_id)
  WHERE kind = 'deposit' AND status = 'success';
CREATE UNIQUE INDEX one_paid_final_per_booking ON payments (booking_id)
  WHERE kind = 'final' AND status = 'success';

-- ─── Audit trail ─────────────────────────────────────────────────────────
CREATE TABLE booking_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  from_status booking_status,                   -- NULL on creation
  to_status   booking_status NOT NULL,
  actor_id    uuid REFERENCES users(id),        -- NULL = system job or payment webhook
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_by_booking ON booking_events (booking_id, at);

-- ─── What the dashboard grid reads ───────────────────────────────────────
-- Slot status is DERIVED from bookings, never stored on the slot.
CREATE VIEW slot_status AS
SELECT
  s.id AS slot_id, s.lot_id, s.label, s.zone, s.grid_row, s.grid_col, s.app_bookable, s.in_service,
  CASE
    WHEN NOT s.in_service                            THEN 'out_of_service'
    WHEN b.status IN ('PENDING_PAYMENT', 'RESERVED') THEN 'reserved'
    WHEN b.status = 'CHECKED_IN'                     THEN 'occupied'
    WHEN b.status = 'OVERSTAY'                       THEN 'overstay'
    ELSE 'free'
  END AS display_status,
  b.id AS booking_id, b.source, b.vehicle_plate, b.hold_expires_at, b.planned_end_at, b.updated_at
FROM slots s
LEFT JOIN bookings b
  ON b.slot_id = s.id
 AND b.status IN ('PENDING_PAYMENT', 'RESERVED', 'CHECKED_IN', 'OVERSTAY');
`;

/**
 * Dropped in reverse dependency order. The view first (it depends on both
 * tables), then tables, then the enum types that the tables referenced.
 *
 * This exists so the up/down round-trip can be tested. It is NOT a commitment
 * that every future migration ships a down: see CLAUDE.md, "Migration policy".
 */
const DROP_SCHEMA_SQL = `
DROP VIEW IF EXISTS slot_status;

DROP TABLE IF EXISTS booking_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS slots;
DROP TABLE IF EXISTS lot_staff;
DROP TABLE IF EXISTS lots;
DROP TABLE IF EXISTS operators;
DROP TABLE IF EXISTS push_tokens;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payment_provider;
DROP TYPE IF EXISTS payment_kind;
DROP TYPE IF EXISTS booking_status;
DROP TYPE IF EXISTS booking_source;
DROP TYPE IF EXISTS user_role;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(INITIAL_SCHEMA_SQL).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(DROP_SCHEMA_SQL).execute(db);
}
