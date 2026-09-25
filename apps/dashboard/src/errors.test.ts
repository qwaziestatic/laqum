import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, LOCALES } from '@laqum/shared';
import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES, ERROR_KEYS, errorKey, errorText } from './errors.js';
import { resources } from './i18n.js';

/**
 * The dashboard's errors, as the attendant reads them. The API's message is
 * developer English and must never reach the screen: the dashboard used to
 * fall back to it for any code it had no text for.
 */

function translatorFor(locale: (typeof LOCALES)[number]) {
  const instance = createInstance();
  void instance.init({ resources, lng: locale, initAsync: false });
  return instance.t;
}

describe('every error code has the dashboard own text', () => {
  const codes = [...ERROR_CODES, ...CLIENT_ERROR_CODES];

  it('in both languages, never empty', () => {
    for (const locale of LOCALES) {
      const errors = resources[locale].translation.error as Record<string, unknown>;
      for (const code of codes) {
        const text = errors[code];
        expect(typeof text, `${locale}.error.${code}`).toBe('string');
        expect(String(text).trim(), `${locale}.error.${code}`).not.toBe('');
      }
    }
  });

  it('never shows the API message, for any code, in either language', () => {
    for (const locale of LOCALES) {
      const t = translatorFor(locale);
      for (const code of codes) {
        const shown = errorText(t, { code });
        expect(shown, `${locale} ${code}`).not.toContain('developer message');
        expect(shown, `${locale} ${code}`).not.toBe(ERROR_KEYS[code]);
      }
    }
  });

  it('gives an unrecognised code the generic text, not whatever came back', () => {
    expect(errorKey({ code: 'SOMETHING_NEW' })).toBe('error.UNKNOWN');
  });
});

describe('the source', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/u.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
    });
  }

  it('never renders error.message, nor falls back to it', () => {
    // api/client.ts builds ApiErrors, so it is the one file that may read
    // `.message`; everything that shows text goes through errorText().
    const offenders = sources(root)
      .filter((file) => !file.endsWith(join('api', 'client.ts')))
      .flatMap((file) => {
        const text = readFileSync(file, 'utf8');
        return /\berror\.message\b|defaultValue:/u.test(text) ? [relative(root, file)] : [];
      });
    expect(offenders).toEqual([]);
  });
});
