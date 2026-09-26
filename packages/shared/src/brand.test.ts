import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND, BRAND_ARTWORK, BRAND_TEXT_PAIRS, FORBIDDEN_BRAND_COLOURS } from './brand.js';
import { AA_CONTRAST, CONNECTION_PALETTE, STATUS_PALETTE, contrastRatio } from './palette.js';

/**
 * The brand colours: that they are the ones sampled from the illustration,
 * that everything drawn on them is legible, and that they stay out of the
 * way of the slot-status colours. docs/BRAND.md states the rules.
 */

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

interface Sampled {
  source: { file: string; sha256: string };
  colours: Record<'navy' | 'orange' | 'carRed' | 'paper', { hex: string }>;
  intro: { aspect: number; wordmark: typeof BRAND_ARTWORK.wordmark };
}
const generated = JSON.parse(
  readFileSync(repo('assets/brand/generated/brand.json'), 'utf8'),
) as Sampled;

// ─── CIEDE2000, for "do these two colours look alike" ─────────────────────

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005), kL = kC = kH = 1. */
function deltaE2000(
  [L1, a1, b1]: [number, number, number],
  [L2, a2, b2]: [number, number, number],
): number {
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (x: number, y: number): number => {
    if (x === 0 && y === 0) return 0;
    const h = Math.atan2(y, x) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dLp = L2 - L1;
  const dCp = c2p - c1p;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * rad);
  const lBar = (L1 + L2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hBar += h1p + h2p < 360 ? 360 : -360;
    hBar /= 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
}

const deltaE = (a: string, b: string): number => deltaE2000(toLab(a), toLab(b));

/** Every colour that means something in the operational UI, both themes. */
function statusAndConnectionSurfaces(): { name: string; hex: string }[] {
  const out: { name: string; hex: string }[] = [];
  for (const [status, themes] of Object.entries(STATUS_PALETTE)) {
    for (const theme of ['light', 'dark'] as const) {
      out.push({ name: `${status} (${theme})`, hex: themes[theme].surface });
    }
  }
  for (const [state, themes] of Object.entries(CONNECTION_PALETTE)) {
    for (const theme of ['light', 'dark'] as const) {
      out.push({ name: `connection ${state} (${theme})`, hex: themes[theme].surface });
    }
  }
  return out;
}

describe('the brand colours are the ones sampled from the illustration', () => {
  it('uses the untouched source file', () => {
    const bytes = readFileSync(repo(generated.source.file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(generated.source.sha256);
  });

  it('matches what scripts/brand/build.mjs sampled', () => {
    expect(BRAND.navy).toBe(generated.colours.navy.hex);
    expect(BRAND.orange).toBe(generated.colours.orange.hex);
    expect(BRAND.paper).toBe(generated.colours.paper.hex);
    expect(FORBIDDEN_BRAND_COLOURS.carRed).toBe(generated.colours.carRed.hex);
  });

  it('places the intro wordmark where the generated artwork expects it', () => {
    expect(BRAND_ARTWORK.aspect).toBe(generated.intro.aspect);
    expect(BRAND_ARTWORK.wordmark).toEqual(generated.intro.wordmark);
  });
});

describe('text on the brand colours', () => {
  it.each(BRAND_TEXT_PAIRS)('clears WCAG AA: $name', ({ ink, surface }) => {
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(AA_CONTRAST);
  });

  it('keeps orange away from text on light surfaces, where it fails AA', () => {
    // The reason the rule exists; if orange ever passed, the rule could relax.
    expect(contrastRatio(BRAND.orange, '#ffffff')).toBeLessThan(AA_CONTRAST);
    expect(BRAND_TEXT_PAIRS.some((pair) => pair.ink === BRAND.orange)).toBe(false);
  });
});

describe('the brand colours never collide with the slot-status colours', () => {
  it('computes CIEDE2000 correctly (Sharma et al., test pair 1)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
  });

  it('does not use the car red, or anything near it', () => {
    // "Near" is ΔE2000 ≤ 10, where the car red and the overstay red both sit.
    // The nearest brand colour is orange, at 19.3: a neighbour, not a shade.
    for (const hex of Object.values(BRAND)) {
      expect(deltaE(hex, FORBIDDEN_BRAND_COLOURS.carRed)).toBeGreaterThan(10);
    }
    expect(Math.round(deltaE(BRAND.orange, FORBIDDEN_BRAND_COLOURS.carRed) * 10) / 10).toBe(19.3);
    // The car red is the overstay tile's neighbour: exactly why it is refused.
    expect(
      deltaE(FORBIDDEN_BRAND_COLOURS.carRed, STATUS_PALETTE.overstay.light.surface),
    ).toBeLessThan(10);
  });

  it('is never nearly the same colour as a status or connection surface', () => {
    for (const brand of [BRAND.navy, BRAND.orange]) {
      for (const { name, hex } of statusAndConnectionSurfaces()) {
        expect(deltaE(brand, hex), `${brand} vs ${name}`).toBeGreaterThan(5);
      }
    }
  });

  it('is as close as docs/BRAND.md says, which is why it stays out of the operational UI', () => {
    const closest = (brand: string): { name: string; value: number } =>
      statusAndConnectionSurfaces()
        .map(({ name, hex }) => ({ name, value: Math.round(deltaE(brand, hex) * 10) / 10 }))
        .sort((a, b) => a.value - b.value)[0] ?? { name: 'none', value: Infinity };
    // If a palette changes, these change: update docs/BRAND.md with them.
    expect(closest(BRAND.navy)).toEqual({ name: 'out_of_service (dark)', value: 8 });
    expect(closest(BRAND.orange)).toEqual({ name: 'connection reconnecting (dark)', value: 9 });
  });
});
