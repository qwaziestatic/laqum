import { LOCALES, SLOT_DISPLAY_STATUSES, informalAmharic } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { resources } from './i18n.js';

type Json = Record<string, unknown>;

/** Flatten to dotted paths so two bundles can be compared key by key. */
function keyPaths(value: Json, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null ? keyPaths(child as Json, path) : [path];
  });
}

describe('translation bundles', () => {
  it('ships a bundle for every supported locale', () => {
    expect(Object.keys(resources).sort()).toEqual([...LOCALES].sort());
  });

  it('has identical keys in every locale', () => {
    // The usual i18n failure: a key is added in English and forgotten in
    // Amharic, so Amharic users see a raw key. This catches it at test time.
    const [first, ...rest] = LOCALES;
    const reference = keyPaths(resources[first].translation).sort();

    for (const locale of rest) {
      expect(keyPaths(resources[locale].translation).sort(), locale).toEqual(reference);
    }
  });

  it('has no empty strings', () => {
    for (const locale of LOCALES) {
      const bundle = resources[locale].translation as unknown as Json;
      for (const path of keyPaths(bundle)) {
        const value = path.split('.').reduce<unknown>((acc, key) => (acc as Json)[key], bundle);
        expect(typeof value, `${locale}.${path}`).toBe('string');
        expect((value as string).trim().length, `${locale}.${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('translates every slot display status the view can produce', () => {
    // slot_status.display_status is rendered directly in the Phase 3 grid, so
    // a missing label here would be a visible gap in the attendant UI.
    for (const locale of LOCALES) {
      const slot = resources[locale].translation.slot as unknown as Json;
      for (const status of SLOT_DISPLAY_STATUSES) {
        expect(Object.keys(slot), `${locale}.slot`).toContain(status);
      }
    }
  });

  it('speaks to the reader politely: no informal, gendered second person', () => {
    // The product owner's decision (shared/register.ts). The dashboard was
    // drafted in the informal form; docs/AMHARIC-REVIEW.md lists each change.
    const bundle = resources.am.translation as unknown as Json;
    const informal = keyPaths(bundle).flatMap((path) => {
      const text = path.split('.').reduce<unknown>((acc, key) => (acc as Json)[key], bundle);
      return informalAmharic(String(text)).map((word) => `${path}: ${word}`);
    });
    expect(informal).toEqual([]);
  });

  it('actually differs between Amharic and English', () => {
    // Guards against a bundle copied and never translated.
    expect(resources.am.translation.app.tagline).not.toBe(resources.en.translation.app.tagline);
  });
});
