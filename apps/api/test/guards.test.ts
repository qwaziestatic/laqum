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

      /*
       * Scan FORWARD from each write to the bookings table, not the whole
       * file. Checking the file as a whole flagged bookings/service.ts for a
       * `{ status: existing.status }` inside an AppError payload, which is a
       * read, not a write — a false positive that would train someone to
       * silence this test.
       */
      const writes = /\.(?:updateTable|insertInto)\(\s*['"]bookings['"]\s*\)/gu;
      for (const match of code.matchAll(writes)) {
        const chain = code.slice(match.index, match.index + 800);
        // `status:` is an object key in .set({...}) or .values({...}).
        // `.where('status', ...)` is a predicate and is perfectly fine.
        if (/\bstatus\s*:/u.test(chain)) offenders.push(file.path);
      }

      // Raw SQL is the other way round the query builder.
      if (/UPDATE\s+bookings[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bstatus\b/iu.test(code)) {
        offenders.push(`${file.path} (raw SQL)`);
      }
    }

    expect(offenders, 'only transition.ts and create.ts may write bookings.status').toEqual([]);
  });

  it('flags a status write while ignoring a status read', () => {
    // Negative-test of the rule, so it cannot rot into a regex matching
    // nothing. The first two are writes; the last two are not.
    const flags = (code: string): boolean => {
      const writes = /\.(?:updateTable|insertInto)\(\s*['"]bookings['"]\s*\)/gu;
      return [...code.matchAll(writes)].some((m) =>
        /\bstatus\s*:/u.test(code.slice(m.index, m.index + 800)),
      );
    };

    expect(flags(".updateTable('bookings').set({ status: 'PAID' })")).toBe(true);
    expect(flags(".insertInto('bookings').values({ status: 'CHECKED_IN' })")).toBe(true);
    expect(
      flags(".updateTable('bookings').set({ updated_at: now }).where('status', '=', 'X')"),
    ).toBe(false);
    expect(flags("throw new AppError('STATE_CONFLICT', 'nope', { status: row.status })")).toBe(
      false,
    );
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

describe('THE BIND LAW: only listen.ts binds a port', () => {
  /*
   * Express 5's app.listen(port, callback) hands a bind error TO THE
   * CALLBACK, so the usual "listening" callback logs success over a process
   * bound to nothing — and Node does not crash, because the error now has a
   * listener. That shipped once (see src/listen.ts). listen() resolves only
   * on a real 'listening' event and rejects everything else.
   */
  const LISTEN_CALL = /\.listen\s*\(/u;

  it('finds no .listen( outside listen.ts', async () => {
    const files = await sourceFiles(SRC);
    expect(files.map((f) => f.path)).toContain('listen.ts');

    const offenders = files
      .filter((file) => file.path !== 'listen.ts')
      .filter((file) => LISTEN_CALL.test(stripComments(file.text)))
      .map((file) => file.path);

    expect(offenders, 'bind ports through listen() in src/listen.ts').toEqual([]);
  });

  it('flags a listen call while ignoring prose about one', () => {
    // Negative-test of the rule, so it cannot rot into a regex matching
    // nothing, or into one tripped by a comment.
    expect(LISTEN_CALL.test("app.listen(config.PORT, () => log('up'))")).toBe(true);
    expect(LISTEN_CALL.test('server.listen (3000)')).toBe(true);
    expect(LISTEN_CALL.test(stripComments('// NOT app.listen(port, callback)'))).toBe(false);
    expect(LISTEN_CALL.test('const listener = onListening;')).toBe(false);
  });
});

describe('THE SOCKET LIMIT reaches production', () => {
  // createRealtimeServer takes the limiter as an option, so tests of other
  // behaviour can leave it out. The one real caller must not.
  it('is passed by server.ts, the only production caller', async () => {
    const server = await readFile(join(SRC, 'server.ts'), 'utf8');
    const call = /createRealtimeServer\(server, \{([\s\S]*?)\}\);/u.exec(server)?.[1] ?? '';
    expect(call).toMatch(/\brateLimiter: ctx\.rateLimiter\b/u);
  });
});

describe('THE SHUTDOWN reaches production', () => {
  it('is wired to both signals, with the configured deadline and the draining flag', async () => {
    const server = await readFile(join(SRC, 'server.ts'), 'utf8');
    expect(server).toMatch(/gracefulShutdown\(\{/u);
    expect(server).toMatch(/timeoutMs: config\.SHUTDOWN_TIMEOUT_MS/u);
    expect(server).toMatch(/isDraining: \(\) => draining/u);
    expect(server).toMatch(/for \(const signal of \['SIGTERM', 'SIGINT'\] as const\)/u);
    // The old in-line shutdown, which waited on the HTTP server first, is gone.
    expect(server).not.toMatch(/server\.close\(/u);
  });
});
