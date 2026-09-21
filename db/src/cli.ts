/**
 * Migration CLI.
 *
 *   pnpm --filter @laqum/db migrate up      apply all pending migrations
 *   pnpm --filter @laqum/db migrate down    roll back the most recent migration
 *   pnpm --filter @laqum/db migrate status  list migrations and whether applied
 *
 * Reads DATABASE_URL, or MIGRATE_DATABASE_URL when set (tests point that at
 * the throwaway database from docker-compose.test.yml).
 */
import type { MigrationResult } from 'kysely/migration';
import { createPool, createUntypedDb } from './connection.js';
import { createMigrator } from './migrator.js';

const COMMANDS = ['up', 'down', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function parseCommand(argv: readonly string[]): Command {
  const arg = argv[2] ?? 'up';
  const match = COMMANDS.find((c) => c === arg);
  if (!match) {
    throw new Error(`Unknown command "${arg}". Expected one of: ${COMMANDS.join(', ')}.`);
  }
  return match;
}

function databaseUrl(): string {
  const url = process.env['MIGRATE_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env, or export it.');
  }
  return url;
}

function report(results: readonly MigrationResult[], verb: string): void {
  for (const result of results) {
    if (result.status === 'Success') {
      console.warn(`${result.migrationName}: ${verb}`);
    } else if (result.status === 'Error') {
      console.error(`${result.migrationName}: FAILED`);
    }
  }
}

async function run(): Promise<void> {
  const command = parseCommand(process.argv);
  const pool = createPool({ connectionString: databaseUrl() });
  const db = createUntypedDb(pool);
  const migrator = createMigrator(db);

  try {
    if (command === 'status') {
      for (const m of await migrator.getMigrations()) {
        console.warn(`${m.name}  ${m.executedAt ? `applied ${m.executedAt.toISOString()}` : 'pending'}`);
      }
      return;
    }

    // migrateUp() applies a single migration, so `up` uses migrateToLatest().
    // `down` rolls back exactly one step, which is the intended behaviour.
    const { error, results } =
      command === 'up' ? await migrator.migrateToLatest() : await migrator.migrateDown();

    report(results ?? [], command === 'up' ? 'applied' : 'rolled back');
    if (error) throw error;
    if ((results ?? []).length === 0) {
      console.warn(command === 'up' ? 'No pending migrations.' : 'Nothing to roll back.');
    }
  } finally {
    await db.destroy();
  }
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
