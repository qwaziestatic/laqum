import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLOT_DISPLAY_STATUSES } from './enums.js';
import { AA_CONTRAST, CONNECTION_PALETTE, STATUS_PALETTE, contrastRatio } from './palette.js';

/**
 * The palette is shared between the dashboard and the Phase 4 mobile app, so
 * these tests pin the two things that would otherwise rot quietly: that the
 * CSS and the TypeScript still agree, and that every pair is legible.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../../../apps/dashboard/src/index.css', import.meta.url)),
  'utf8',
);

/** Read a `--token: value;` declaration out of the CSS. */
function cssToken(name: string, block: 'light' | 'dark'): string | null {
  // The dark overrides live inside :root[data-theme='dark'] { ... }.
  const source =
    block === 'dark'
      ? (/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\s*\}/u.exec(CSS)?.[1] ?? '')
      : (/@theme\s*\{([\s\S]*?)\n\}/u.exec(CSS)?.[1] ?? '');

  const match = new RegExp(`--${name}:\\s*([^;]+);`, 'u').exec(source);
  return match?.[1]?.trim() ?? null;
}

describe('the palette covers every status', () => {
  it('has a light and dark pair for each display status', () => {
    expect(Object.keys(STATUS_PALETTE).sort()).toEqual([...SLOT_DISPLAY_STATUSES].sort());
  });

  it('uses hex, which React Native can parse', () => {
    // oklch would be better colour science and is unusable in RN. A token only
    // one consumer can read is not a shared token.
    for (const status of SLOT_DISPLAY_STATUSES) {
      for (const theme of ['light', 'dark'] as const) {
        const { surface, ink } = STATUS_PALETTE[status][theme];
        expect(surface, `${status}.${theme}.surface`).toMatch(/^#[0-9a-f]{6}$/u);
        expect(ink, `${status}.${theme}.ink`).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });
});

describe('legibility in daylight', () => {
  /*
   * WCAG AA, in BOTH themes. The dark theme is the one that slips: it is easy
   * to build by dimming, which lands everything in a grey mush that a sunlit
   * tablet then washes out entirely. Asserting the ratio makes "legible" a
   * number rather than an opinion.
   */
  it.each([...SLOT_DISPLAY_STATUSES])('%s clears AA in light and dark', (status) => {
    for (const theme of ['light', 'dark'] as const) {
      const { surface, ink } = STATUS_PALETTE[status][theme];
      const ratio = contrastRatio(surface, ink);
      expect(ratio, `${status}.${theme} was ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_CONTRAST,
      );
    }
  });

  it('keeps the two attention states STRONG in dark mode, not dimmed', () => {
    /*
     * Occupied and overstay are the two an attendant acts on. A dark theme
     * built by lowering opacity makes exactly these two recede. Their dark
     * surfaces must therefore be at least as luminous as their light ones are
     * dark — i.e. genuinely saturated colour, not a grey.
     */
    for (const status of ['occupied', 'overstay'] as const) {
      const dark = STATUS_PALETTE[status].dark;
      const ratio = contrastRatio(dark.surface, dark.ink);
      expect(ratio, `${status} dark contrast`).toBeGreaterThanOrEqual(AA_CONTRAST);
      // Not a near-grey: the channel spread proves real chroma survived.
      const value = dark.surface.replace('#', '');
      const channels = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
      const spread = Math.max(...channels) - Math.min(...channels);
      expect(spread, `${status} dark surface is too close to grey`).toBeGreaterThan(80);
    }
  });

  it('gives every connection state an AA-legible chip', () => {
    for (const state of Object.keys(CONNECTION_PALETTE) as (keyof typeof CONNECTION_PALETTE)[]) {
      for (const theme of ['light', 'dark'] as const) {
        const { surface, ink } = CONNECTION_PALETTE[state][theme];
        const ratio = contrastRatio(surface, ink);
        expect(
          ratio,
          `connection.${state}.${theme} was ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_CONTRAST);
      }
    }
  });

  it('keeps the LIVE chip clearly distinct from the free tile', () => {
    /*
     * THE bug this palette exists to fix: "live" was green, the grid is mostly
     * green when a lot is empty, and a green dot in a green field is
     * invisible. The live chip must contrast strongly against a free tile, not
     * blend into it.
     */
    for (const theme of ['light', 'dark'] as const) {
      const live = CONNECTION_PALETTE.live[theme].surface;
      const free = STATUS_PALETTE.free[theme].surface;
      const ratio = contrastRatio(live, free);
      expect(ratio, `live vs free in ${theme} was ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the CSS and the shared tokens agree', () => {
  /*
   * The dashboard cannot import TypeScript into its stylesheet, so the values
   * are written in both places. This test is what stops them drifting — the
   * failure mode otherwise is a mobile app whose colours quietly diverge from
   * the dashboard a year from now.
   */
  it.each([...SLOT_DISPLAY_STATUSES])('%s matches index.css in both themes', (status) => {
    const cssName = status === 'out_of_service' ? 'oos' : status;
    for (const theme of ['light', 'dark'] as const) {
      const expected = STATUS_PALETTE[status][theme];
      expect(cssToken(`color-slot-${cssName}`, theme), `--color-slot-${cssName} (${theme})`).toBe(
        expected.surface,
      );
      expect(
        cssToken(`color-slot-${cssName}-ink`, theme),
        `--color-slot-${cssName}-ink (${theme})`,
      ).toBe(expected.ink);
    }
  });

  it.each(Object.keys(CONNECTION_PALETTE))('connection %s matches index.css', (state) => {
    const key = state as keyof typeof CONNECTION_PALETTE;
    for (const theme of ['light', 'dark'] as const) {
      const expected = CONNECTION_PALETTE[key][theme];
      expect(cssToken(`color-conn-${state}`, theme), `--color-conn-${state} (${theme})`).toBe(
        expected.surface,
      );
      expect(
        cssToken(`color-conn-${state}-ink`, theme),
        `--color-conn-${state}-ink (${theme})`,
      ).toBe(expected.ink);
    }
  });
});
