import { type Kysely, sql } from 'kysely';
import type pg from 'pg';
import { createPool, createUntypedDb } from '../src/connection.js';
import { createMigrator } from '../src/migrator.js';

/**
 * Integration tests run against a real Postgres from docker-compose.test.yml.
 * The brief forbids mocking the database, and a partial unique index cannot be
 * mocked in any case: the whole point is that Postgres enforces it.
 */
export function testDatabaseUrl(): string {
  return process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';
}

export interface TestDb {
  db: Kysely<unknown>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function connectTestDb(): TestDb {
  const pool = createPool({ connectionString: testDatabaseUrl(), max: 5 });
  const db = createUntypedDb(pool);
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

/**
 * Drop everything and start clean. Dropping the schema also drops the
 * kysely_migration bookkeeping tables, so the migrator replays from zero.
 */
export async function resetSchema(db: Kysely<unknown>): Promise<void> {
  await sql.raw('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;').execute(db);
}

/** Kysely types a migration failure as `unknown`, and it is not always an Error. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function migrateToLatest(db: Kysely<unknown>): Promise<void> {
  const { error } = await createMigrator(db).migrateToLatest();
  if (error !== undefined) throw asError(error);
}

export async function migrateDown(db: Kysely<unknown>): Promise<void> {
  const { error } = await createMigrator(db).migrateDown();
  if (error !== undefined) throw asError(error);
}

/** A clean, fully migrated database. */
export async function freshSchema(db: Kysely<unknown>): Promise<void> {
  await resetSchema(db);
  await migrateToLatest(db);
}

interface RowsResult<T> {
  rows: T[];
}

/** Run read-only introspection SQL and get plain rows back. */
export async function query<T>(db: Kysely<unknown>, text: string): Promise<T[]> {
  const result = (await sql.raw(text).execute(db)) as unknown as RowsResult<T>;
  return result.rows;
}
