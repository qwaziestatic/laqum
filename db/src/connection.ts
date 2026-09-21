import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './generated.js';

/**
 * Postgres returns int8 (bigint) as a string by default, because a 64-bit
 * integer does not fit in a JS number. booking_events.id is the only bigint in
 * the schema and we never do arithmetic on it, so parsing it to a number here
 * would be a silent precision trap. It stays a string.
 *
 * int4 and numeric are left at their defaults: int4 already parses to number,
 * and the schema has no numeric columns (money is int santim).
 */

export type Database = DB;

export interface PoolOptions {
  connectionString: string;
  /** Keep this comfortably under Postgres' max_connections. */
  max?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // Fail fast instead of hanging a request behind an unreachable database.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * A Kysely instance whose schema is not yet known. Used by the migrator and by
 * tests that run before code generation has produced `generated.ts`.
 */
export function createUntypedDb(pool: pg.Pool): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool }),
  });
}
