import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_SCHEMA_SQL } from '../migrations/001_initial.js';

/**
 * db/schema.sql is documented as a reference copy of the reviewed DDL, with
 * the migration as the source of truth. A copy nobody checks drifts, so this
 * asserts the two are the same bytes.
 *
 * This test needs no database.
 */
describe('db/schema.sql', () => {
  it('is byte-identical to the SQL the migration executes', async () => {
    const path = fileURLToPath(new URL('../schema.sql', import.meta.url));
    const onDisk = await readFile(path, 'utf8');

    // .gitattributes normalizes the repo to LF, but a Windows checkout can
    // still hand us CRLF. The comparison is about content, not line endings.
    const normalize = (s: string): string => s.replace(/\r\n/gu, '\n');

    expect(normalize(onDisk)).toBe(normalize(INITIAL_SCHEMA_SQL));
  });
});
