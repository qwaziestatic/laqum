import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_SCHEMA_SQL } from '../migrations/001_initial.js';

/**
 * db/schema.sql is the reference copy of the INITIAL reviewed DDL, with
 * 001_initial as the source of truth. A copy nobody checks drifts, so this
 * asserts the two are the same bytes.
 *
 * It is deliberately NOT regenerated as later migrations land: migrations are
 * forward-only, so the current schema is 001 plus everything after it, and
 * db/test/schema.test.ts is the authority on that shape.
 *
 * This test needs no database.
 */
describe('db/schema.sql', () => {
  it('is byte-identical to the SQL the INITIAL migration executes', async () => {
    const path = fileURLToPath(new URL('../schema.sql', import.meta.url));
    const onDisk = await readFile(path, 'utf8');

    // .gitattributes normalizes the repo to LF, but a Windows checkout can
    // still hand us CRLF. The comparison is about content, not line endings.
    const normalize = (s: string): string => s.replace(/\r\n/gu, '\n');

    expect(normalize(onDisk)).toBe(normalize(INITIAL_SCHEMA_SQL));
  });
});
