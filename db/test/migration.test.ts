import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownMigrationNames } from '../src/migrator.js';
import {
  connectTestDb,
  freshSchema,
  migrateDown,
  migrateToLatest,
  query,
  resetSchema,
  type TestDb,
} from './helpers.js';

let ctx: TestDb;

beforeAll(() => {
  ctx = connectTestDb();
});

afterAll(async () => {
  // Leave the database migrated: other suites and the seed script expect it.
  await freshSchema(ctx.db);
  await ctx.close();
});

async function tableNames(): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    ctx.db,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE 'kysely_%'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function enumNames(): Promise<string[]> {
  const rows = await query<{ typname: string }>(
    ctx.db,
    `SELECT typname FROM pg_type
      WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
      ORDER BY typname`,
  );
  return rows.map((r) => r.typname);
}

describe('migrator', () => {
  it('knows about the migrations this build ships', () => {
    expect(knownMigrationNames()).toEqual(['001_initial']);
  });

  it('records the migration as applied', async () => {
    await freshSchema(ctx.db);
    const rows = await query<{ name: string }>(
      ctx.db,
      `SELECT name FROM kysely_migration ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['001_initial']);
  });

  it('is a no-op when run a second time', async () => {
    await freshSchema(ctx.db);
    const before = await tableNames();

    // Running up again must not fail and must not change anything. This is the
    // property that lets a deploy re-run migrations safely.
    await migrateToLatest(ctx.db);

    expect(await tableNames()).toEqual(before);
    const rows = await query<{ count: string }>(
      ctx.db,
      `SELECT count(*)::text AS count FROM kysely_migration`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('rolls back cleanly and can be re-applied', async () => {
    await freshSchema(ctx.db);
    expect(await tableNames()).toHaveLength(11);
    expect(await enumNames()).toHaveLength(6);

    await migrateDown(ctx.db);

    // The down migration drops the view, the tables and the enum types.
    expect(await tableNames()).toEqual([]);
    expect(await enumNames()).toEqual([]);

    await migrateToLatest(ctx.db);
    expect(await tableNames()).toHaveLength(11);
    expect(await enumNames()).toHaveLength(6);
  });

  it('applies to a completely empty database', async () => {
    await resetSchema(ctx.db);
    await migrateToLatest(ctx.db);
    expect(await tableNames()).toHaveLength(11);
  });
});
