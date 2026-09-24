import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EVERY SCREEN CLEARS THE NAVIGATION BAR.
 *
 * Android 16 makes edge-to-edge mandatory, so each screen draws behind the
 * system navigation bar unless it pads itself. The device test found Home's
 * Refresh button under the bar; every other screen ends in a button inside a
 * ScrollView and had the same problem once scrolled to the end.
 *
 * There is no renderer in these tests, so this checks the source: every
 * screen calls useBottomInset and puts the result into a style. A new screen
 * without it fails here instead of on a phone.
 */

const APP = fileURLToPath(new URL('../app', import.meta.url));

/** Route files that are screens: everything but layouts. */
async function screens(dir = APP, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await screens(full, acc);
    else if (entry.name.endsWith('.tsx') && !entry.name.startsWith('_')) acc.push(full);
  }
  return acc;
}

function label(file: string): string {
  return relative(APP, file).split('\\').join('/');
}

const USES_INSET = /\buseBottomInset\(\d+\)/u;
const APPLIES_INSET = /paddingBottom:\s*bottomInset\b/u;

describe('bottom safe-area inset', () => {
  it('is applied by every screen', async () => {
    const files = await screens();
    expect(files.length).toBeGreaterThanOrEqual(6);

    const missing: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (!USES_INSET.test(text) || !APPLIES_INSET.test(text)) missing.push(label(file));
    }
    expect(missing, 'screens that can hide their last control under the nav bar').toEqual([]);
  });

  it('leaves no ScrollView padded only by its static style', async () => {
    // The exact shape the fix replaced; a copy-pasted screen would bring it back.
    const offenders: string[] = [];
    for (const file of await screens()) {
      if ((await readFile(file, 'utf8')).includes('contentContainerStyle={styles.content}')) {
        offenders.push(label(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises a screen that forgets the inset', () => {
    // Negative-test of the rules themselves.
    const forgot = '<ScrollView contentContainerStyle={styles.content}>';
    expect(USES_INSET.test(forgot) && APPLIES_INSET.test(forgot)).toBe(false);
    const fixed =
      'const bottomInset = useBottomInset(20);\n' +
      '<ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>';
    expect(USES_INSET.test(fixed) && APPLIES_INSET.test(fixed)).toBe(true);
  });
});
