import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Invariants that are properties of the SOURCE, not of any one execution.
 *
 * The brief asks for "a lint rule or a test that greps for violations" of the
 * single-writer rule. This is that test, plus the companion rule for the
 * injected clock.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Only these two files may write bookings.status. */
const STATUS_WRITERS = ['bookings/transition.ts', 'bookings/create.ts'];

interface SourceFile {
  path: string;
  text: string;
}

async function sourceFiles(dir: string, acc: SourceFile[] = []): Promise<SourceFile[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await sourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push({
        path: relative(SRC, full).replaceAll('\\', '/'),
        text: await readFile(full, 'utf8'),
      });
    }
  }
  return acc;
}

/** Strip comments so prose about `status` or `now()` is not a false positive. */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

describe('INVARIANT 3: one writer for bookings.status', () => {
  it('finds the writers where they are expected', async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const expected of STATUS_WRITERS) {
      expect(files.map((f) => f.path)).toContain(expected);
    }
  });

  it('lets no other file set a status on bookings', async () => {
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      if (STATUS_WRITERS.includes(file.path)) continue;
      const code = stripComments(file.text);

      // An update or insert touching bookings, that also mentions `status:`.
      const writesBookings =
        /\.updateTable\(\s*['"]bookings['"]\s*\)/u.test(code) ||
        /\.insertInto\(\s*['"]bookings['"]\s*\)/u.test(code);
      const setsStatus = /\bstatus\s*:/u.test(code) || /\bstatus\s*=/u.test(code);

      if (writesBookings && setsStatus) offenders.push(file.path);

      // Raw SQL is the other way round the query builder.
      if (/UPDATE\s+bookings[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bstatus\b/iu.test(code)) {
        offenders.push(`${file.path} (raw SQL)`);
      }
    }

    expect(offenders, 'only transition.ts and create.ts may write bookings.status').toEqual([]);
  });

  it('keeps status out of the patch type, so the compiler enforces it too', async () => {
    const text = await readFile(join(SRC, 'bookings/transition.ts'), 'utf8');
    expect(text).toMatch(/Omit<\s*Updateable<Database\['bookings'\]>,\s*'status'/u);
  });
});

describe('THE CLOCK LAW: no now() in business SQL', () => {
  it('never calls the database clock anywhere in the API source', async () => {
    // Postgres' now() is a second clock that FakeClock cannot move. One of
    // these in a WHERE clause silently defeats every time-dependent test.
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const code = stripComments(file.text);
      // Bare now(), not a method call: clock.now(), Date.now() and
      // performance.now() are the injected clock and are fine. The lookbehind
      // is what separates `now()` in SQL from `.now()` in TypeScript.
      if (/(?<![.\w])now\s*\(\)/iu.test(code)) offenders.push(file.path);
      if (/\bCURRENT_TIMESTAMP\b/iu.test(code)) offenders.push(`${file.path} (CURRENT_TIMESTAMP)`);
    }

    expect(
      offenders,
      'time must come from the injected Clock, passed as a bound parameter',
    ).toEqual([]);
  });

  it('catches a bare now() while ignoring the injected clock', () => {
    // Negative-test of the rule itself, so the lookbehind cannot silently rot
    // into a regex that matches nothing.
    const offending = /(?<![.\w])now\s*\(\)/iu;
    expect(offending.test('sql`SELECT * FROM bookings WHERE hold_expires_at <= now()`')).toBe(true);
    expect(offending.test('.set({ updated_at: now() })')).toBe(true);
    expect(offending.test('const now = clock.now();')).toBe(false);
    expect(offending.test('performance.now()')).toBe(false);
    expect(offending.test('Date.now()')).toBe(false);
  });

  it('still allows now() as a column default in the migration', async () => {
    // The law is about business SQL, not about the DDL, where now() is the
    // right thing for created_at.
    const ddl = await readFile(
      fileURLToPath(new URL('../../../db/migrations/001_initial.ts', import.meta.url)),
      'utf8',
    );
    expect(ddl).toMatch(/DEFAULT now\(\)/u);
  });
});
