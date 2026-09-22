import type { Kysely } from 'kysely';
// Kysely 0.29 moved the migrator out of the root entry point into the
// `kysely/migration` subpath export. Importing it from 'kysely' fails at
// runtime with "does not provide an export named 'Migrator'".
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import * as migration001 from '../migrations/001_initial.js';
import * as migration002 from '../migrations/002_payment_status_superseded.js';

/**
 * Migrations are registered explicitly rather than discovered from disk.
 *
 * Kysely ships FileMigrationProvider, but it dynamic-import()s absolute paths,
 * which throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows ("Only URLs with a
 * scheme in: file, data are supported") because `C:\...` is read as a `c:`
 * scheme. Development here is on Windows and CI is on Linux, so a
 * discovery mechanism that behaves differently across the two is a liability.
 *
 * An explicit registry is also typechecked: a migration that fails to compile
 * breaks the build instead of being silently skipped at runtime.
 *
 * Add new migrations here, in order. Keys are the migration names Kysely
 * records in the kysely_migration table and must never be renamed.
 */
const MIGRATIONS: Record<string, Migration> = {
  '001_initial': migration001,
  '002_payment_status_superseded': migration002,
};

const provider: MigrationProvider = {
  getMigrations() {
    return Promise.resolve(MIGRATIONS);
  },
};

export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({ db, provider });
}

/** The migration names this build knows about, in application order. */
export function knownMigrationNames(): string[] {
  return Object.keys(MIGRATIONS).sort();
}
