import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, informalAmharic } from '@laqum/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { am } from '../src/i18n/am.js';
import { type Messages, languageForLocale, resources } from '../src/i18n/core.js';
import { en } from '../src/i18n/en.js';
import type { Button, Notice } from '../src/ui.js';

/**
 * AMHARIC AND ENGLISH, and no English on an Amharic screen.
 *
 * Three layers, because each catches what the others cannot:
 *   1. the bundles: identical keys, identical {{placeholders}}, nothing
 *      empty, and no Latin text in Amharic;
 *   2. the types: the UI primitives take only `Shown` text (i18n/core.ts), so
 *      an English literal passed to a Button or Notice does not compile;
 *   3. the source: everything the types cannot see, such as text written
 *      directly into JSX, a placeholder, or a header title.
 */

type Json = Record<string, unknown>;

function leaves(value: Json, prefix = ''): [string, string][] {
  return Object.entries(value).flatMap(([key, child]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'string' ? [[path, child]] : leaves(child as Json, path);
  });
}

const EN = new Map(leaves(en));
const AM = new Map(leaves(am));

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1] ?? '').sort();
}

/**
 * Latin text the Amharic bundle may contain, by key. Only the language
 * switch's "English": it names the other language in that language, so a
 * reader who needs it can find it.
 */
const LATIN_ALLOWED_IN_AMHARIC = new Set(['language.en']);

describe('the bundles', () => {
  it('ships a bundle for every supported locale', () => {
    expect(Object.keys(resources).sort()).toEqual([...LOCALES].sort());
  });

  it('has identical keys in both languages', () => {
    expect([...AM.keys()].sort()).toEqual([...EN.keys()].sort());
  });

  it('refuses, at compile time, a key missing from Amharic or only in Amharic', () => {
    // @ts-expect-error - app.tagline is missing
    const missing: Messages = { ...am, app: { name: 'ላቁም?' } };
    // @ts-expect-error - a key English does not have
    const extra: Messages = { ...am, stray: 'ተጨማሪ' };
    expect([missing, extra]).toHaveLength(2);
  });

  it('has nothing empty', () => {
    for (const [locale, bundle] of [
      ['en', EN],
      ['am', AM],
    ] as const) {
      for (const [key, text] of bundle) expect(text.trim(), `${locale}.${key}`).not.toBe('');
    }
  });

  it('keeps every {{placeholder}}: a dropped one silently loses the amount or the time', () => {
    for (const [key, english] of EN) {
      expect(placeholders(AM.get(key) ?? ''), key).toEqual(placeholders(english));
    }
  });

  it('has no Latin text in Amharic, apart from the language switch', () => {
    for (const [key, text] of AM) {
      if (LATIN_ALLOWED_IN_AMHARIC.has(key)) continue;
      const withoutPlaceholders = text.replace(/\{\{\w+\}\}/gu, '');
      expect(withoutPlaceholders, key).not.toMatch(/[A-Za-z]/u);
      expect(withoutPlaceholders, key).toMatch(/[ሀ-፿]/u);
    }
  });

  it('speaks to the reader politely: no informal, gendered second person', () => {
    // The product owner's decision (shared/register.ts): the app cannot know
    // whether a man or a woman is reading.
    const informal = [...AM].flatMap(([key, text]) =>
      informalAmharic(text).map((word) => `${key}: ${word}`),
    );
    expect(informal).toEqual([]);
  });

  it('actually differs from English wherever English has words', () => {
    // A key copied and never translated.
    const same = [...EN].filter(([key, text]) => /[A-Za-z]{2}/u.test(text) && AM.get(key) === text);
    expect(same.map(([key]) => key)).toEqual(['language.en']);
  });
});

describe('the types', () => {
  it('refuse a bare string where the UI shows text', () => {
    // @ts-expect-error - a literal is not Shown: it must come through t() or verbatim()
    const label: Parameters<typeof Button>[0]['label'] = 'Cancel';
    // @ts-expect-error - the same for a notice
    const message: Parameters<typeof Notice>[0]['message'] = 'Something went wrong';
    expect([label, message]).toHaveLength(2);
  });
});

describe('the language, from the phone', () => {
  it('follows an Amharic or an English phone', () => {
    expect(languageForLocale('am_ET')).toBe('am');
    expect(languageForLocale('am-ET')).toBe('am');
    expect(languageForLocale('en_US')).toBe('en');
    expect(languageForLocale('en-GB')).toBe('en');
    expect(languageForLocale('EN')).toBe('en');
  });

  it('falls back to Amharic, the default, for anything else', () => {
    expect(languageForLocale('om_ET')).toBe('am');
    expect(languageForLocale('fr-FR')).toBe('am');
    expect(languageForLocale('')).toBe('am');
    expect(languageForLocale(null)).toBe('am');
  });
});

// ─── The source ───────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Props whose value is read out or shown: they must be translated. */
const TEXT_PROPS = new Set([
  'accessibilityLabel',
  'accessibilityHint',
  'placeholder',
  'title',
  'label',
  'message',
  'actionLabel',
]);

/** Examples of what to type, not wording: the same in any language. */
const ALLOWED_LITERALS = new Set(['+251911000002', '000000', 'AA-12345']);

const LATIN = /[A-Za-z]/u;

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('');
  }
  return null;
}

function isWording(text: string | null): text is string {
  return text !== null && LATIN.test(text) && !ALLOWED_LITERALS.has(text);
}

/** Every place a screen could put English on screen without the types noticing. */
function leaksIn(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const where = (node: ts.Node): string =>
    `${relative(ROOT, file)}:${String(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`;

  const visit = (node: ts.Node): void => {
    // Text written straight into JSX: <Text>Pay now</Text>.
    if (ts.isJsxText(node) && LATIN.test(node.text)) {
      found.push(`${where(node)} JSX text "${node.text.trim()}"`);
    }
    // A literal as a JSX child: <Text>{'Pay now'}</Text>.
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      const text = literalText(node.expression);
      if (isWording(text)) found.push(`${where(node)} JSX child "${text}"`);
    }
    // A text prop given a literal: placeholder="Plate".
    if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText(source))) {
      const init = node.initializer;
      const value =
        init === undefined
          ? null
          : ts.isStringLiteral(init)
            ? init.text
            : ts.isJsxExpression(init) && init.expression
              ? literalText(init.expression)
              : null;
      if (isWording(value)) found.push(`${where(node)} ${node.name.getText(source)}="${value}"`);
    }
    // A header title in screen options: { title: 'Pay' }.
    if (
      ts.isPropertyAssignment(node) &&
      ['title', 'headerTitle'].includes(node.name.getText(source))
    ) {
      const text = literalText(node.initializer);
      if (isWording(text)) found.push(`${where(node)} title "${text}"`);
    }
    // verbatim() is for data, never for wording.
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'verbatim' &&
      node.arguments[0] !== undefined
    ) {
      const text = literalText(node.arguments[0]);
      if (isWording(text)) found.push(`${where(node)} verbatim("${text}")`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no English written into a screen', () => {
  const files = [...tsxFiles(join(ROOT, 'app')), ...tsxFiles(join(ROOT, 'src'))];

  it('scans every screen and component', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('finds none: every word on screen comes from the bundles', () => {
    // The map credit (src/map/tiles.ts, MAP_ATTRIBUTION) is the one English
    // text left on screen, deliberately: it is the licensors' required
    // wording, not the app's, and it is a named constant, not a literal here.
    expect(files.flatMap(leaksIn)).toEqual([]);
  });

  it('would catch the forms it looks for', () => {
    // The scanner itself, against a file written to leak in each way.
    const probe = join(ROOT, 'test', 'fixtures', 'leaky.tsx');
    expect(leaksIn(probe).map((line) => line.replace(/^.*?:\d+ /u, ''))).toEqual([
      'title "Settings"',
      'JSX text "Book now"',
      'JSX child "Pay now"',
      'placeholder="Your plate"',
      'label="Cancel"',
      'verbatim("Welcome back")',
    ]);
  });
});
