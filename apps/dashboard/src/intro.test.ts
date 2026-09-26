import { BRAND } from '@laqum/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTRO_MS, INTRO_SESSION_KEY, REDUCED_MOTION_MS, planIntro } from './intro.js';

/**
 * The dashboard's opening animation: once per browser session, at most
 * 800 ms, never in the way. The browser behaviour itself (shown once, not
 * on a reload) is e2e/intro.spec.ts.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
const CSS = read('index.css');

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => {
      data.clear();
    },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('once per browser session', () => {
  it('plays the first time, and records it at once', () => {
    const session = memoryStorage();
    expect(planIntro(session, false)).toEqual({ reducedMotion: false, durationMs: INTRO_MS });
    expect(session.data.get(INTRO_SESSION_KEY)).toBe('1');
  });

  it('does not play again in the same session: a reload is not a new session', () => {
    const session = memoryStorage();
    planIntro(session, false);
    expect(planIntro(session, false)).toBeNull();
  });

  it('does not play at all where it could not remember', () => {
    expect(planIntro(null, false)).toBeNull();
    const refusing = memoryStorage();
    refusing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(planIntro(refusing, false)).toBeNull();
  });

  it('is decided per page load, outside React, so a reconnect cannot replay it', () => {
    const main = read('main.tsx');
    expect(main).toMatch(/^const intro = planIntro\(/mu);
    expect(main).toMatch(/<App \/>\s*<Intro plan=\{intro\} \/>/u);
    // Nothing else decides it.
    for (const file of sourceFiles()) {
      if (file === 'main.tsx' || file === 'intro.ts' || file.endsWith('.test.ts')) continue;
      expect(read(file), file).not.toMatch(/planIntro\(/u);
    }
  });
});

describe('reduced motion', () => {
  it('shows a still frame for at most 300 ms', () => {
    expect(planIntro(memoryStorage(), true)).toEqual({
      reducedMotion: true,
      durationMs: REDUCED_MOTION_MS,
    });
    expect(REDUCED_MOTION_MS).toBeLessThanOrEqual(300);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.laqum-intro,\s*\.laqum-intro-card,\s*\.laqum-intro-picture > \.laqum-intro-wordmark \{\s*animation: none;/u,
    );
  });
});

describe('the time bound, read back from the stylesheet', () => {
  const animations = [
    ...CSS.matchAll(/animation: (laqum-intro-[\w-]+) (\d+)ms [^;]*?(\d+)ms both;/gu),
  ].map((m) => ({ name: m[1] ?? '', duration: Number(m[2]), delay: Number(m[3]) }));

  it('animates three things, each finished by INTRO_MS', () => {
    expect(animations.map((a) => a.name).sort()).toEqual([
      'laqum-intro-card',
      'laqum-intro-exit',
      'laqum-intro-settle',
    ]);
    for (const a of animations) expect(a.delay + a.duration, a.name).toBeLessThanOrEqual(INTRO_MS);
    expect(INTRO_MS).toBeLessThanOrEqual(800);
  });

  it('is gone exactly when the component removes it', () => {
    const exit = animations.find((a) => a.name === 'laqum-intro-exit');
    expect((exit?.delay ?? 0) + (exit?.duration ?? 0)).toBe(INTRO_MS);
  });

  it('moves only opacity and transform', () => {
    const keyframes = [...CSS.matchAll(/@keyframes laqum-intro-[\w-]+ \{([\s\S]*?)\n\}/gu)].map(
      (m) => m[1] ?? '',
    );
    expect(keyframes).toHaveLength(3);
    for (const body of keyframes) {
      const properties = [...body.matchAll(/^\s*([a-z-]+):/gmu)].map((m) => m[1]);
      for (const property of properties) expect(['opacity', 'transform']).toContain(property);
    }
  });
});

describe('never in the way', () => {
  it('lets every touch through and hides itself from screen readers', () => {
    expect(/\.laqum-intro \{[^}]*pointer-events: none;/u.test(CSS)).toBe(true);
    expect(read('components/Intro.tsx')).toMatch(/aria-hidden="true"/u);
  });

  it('leaves the page named in the current language', () => {
    const main = read('main.tsx');
    expect(main).toMatch(/document\.title = /u);
    expect(main).toMatch(/document\.documentElement\.lang = i18n\.language/u);
    expect(main).toMatch(/i18n\.on\('languageChanged', nameThePage\)/u);
  });
});

function sourceFiles(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|css)$/u.test(entry.name))
      acc.push(relative(SRC, full).split('\\').join('/'));
  }
  return acc;
}

describe('brand colours are identity, not interface (docs/BRAND.md)', () => {
  it('appear only in the intro, never in the operational UI', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === 'components/Intro.tsx' || file.endsWith('.test.ts')) continue;
      const text = read(file);
      const hexes = [BRAND.navy, BRAND.orange].filter((hex) => text.toLowerCase().includes(hex));
      if (hexes.length > 0 || /\bBRAND\b/u.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
