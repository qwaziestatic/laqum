import type { SlotDisplayStatus } from './enums.js';

/**
 * THE slot status palette. One source for web and React Native.
 *
 * The dashboard's CSS tokens and the Phase 4 mobile app both read these, and
 * `palette.test.ts` parses `apps/dashboard/src/index.css` to assert the CSS
 * matches value-for-value — so the two cannot drift.
 *
 * WHY HEX, NOT oklch. oklch is the better colour space and is what the CSS
 * originally used, but React Native does not accept it. A shared token that
 * only one of the two consumers can parse is not shared. Hex is the format
 * both understand, so it is the canonical form and the CSS uses it verbatim.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. Every status also carries a glyph and a
 * translated word (see the dashboard's statusPresentation.ts). These values
 * still carry real weight — they are read first and fastest across a grid —
 * but nothing depends on them alone.
 *
 * CONTRAST. Every ink-on-surface pair here clears WCAG AA (4.5:1) in BOTH
 * themes, asserted by test. This is not a formality: the tablet is mounted at
 * a lot entrance in direct Addis sun at 2,300m, where a washed-out screen eats
 * most of the contrast a designer assumed.
 */

export interface StatusColour {
  /** Tile background. */
  surface: string;
  /** Text and glyph drawn on that background. */
  ink: string;
}

export interface StatusPalette {
  light: StatusColour;
  dark: StatusColour;
}

/**
 * DEVIATION FROM THE BRIEF, approved by the product owner.
 *
 * The brief specifies occupied = red and overstay = red-purple. Shipped
 * instead: occupied = BLUE, overstay = RED.
 *
 * The reason is that red should mean "act now". Occupied is the normal,
 * expected state of a working lot — on a busy evening most tiles are occupied,
 * and a grid that is mostly red trains an attendant to ignore red. Overstay is
 * the state that actually costs the operator money and needs someone to walk
 * over, so it gets the alarm colour on its own. Keeping the two in different
 * hue families also separates them for the red-green colour vision deficiency
 * that affects roughly one man in twelve.
 */
export const STATUS_PALETTE: Record<SlotDisplayStatus, StatusPalette> = {
  free: {
    light: { surface: '#86efac', ink: '#14532d' },
    dark: { surface: '#15803d', ink: '#dcfce7' },
  },
  reserved: {
    light: { surface: '#fcd34d', ink: '#451a03' },
    dark: { surface: '#a16207', ink: '#fef9c3' },
  },
  occupied: {
    // Darkened from a mid blue so white text clears AA rather than only
    // AA-large: a slot label is not large text.
    light: { surface: '#1d4ed8', ink: '#ffffff' },
    dark: { surface: '#2563eb', ink: '#ffffff' },
  },
  overstay: {
    light: { surface: '#dc2626', ink: '#ffffff' },
    dark: { surface: '#e11d48', ink: '#ffffff' },
  },
  out_of_service: {
    light: { surface: '#cbd5e1', ink: '#1e293b' },
    dark: { surface: '#334155', ink: '#cbd5e1' },
  },
};

/**
 * The connection indicator's own palette — deliberately NOT a status colour.
 *
 * "Live" used to be green, which made it invisible: a lot is mostly free, so
 * the grid is mostly green, and a green dot in a green field says nothing.
 * The connection state is the one thing an attendant MUST notice changing,
 * because a dashboard that has silently stopped updating looks exactly like a
 * quiet lot.
 *
 * So `live` is a high-contrast INVERTED chip — near-black on light, near-white
 * on dark. It is the only inverted element on the screen, which is what makes
 * it readable against any grid, and it cannot collide with a future status
 * colour because it is not a hue at all. The degraded states then depart from
 * that dark chip in an obvious direction.
 */
export const CONNECTION_PALETTE = {
  live: {
    light: { surface: '#0f172a', ink: '#f8fafc', dot: '#4ade80' },
    dark: { surface: '#f1f5f9', ink: '#0f172a', dot: '#16a34a' },
  },
  connecting: {
    light: { surface: '#e2e8f0', ink: '#334155', dot: '#64748b' },
    dark: { surface: '#1e293b', ink: '#cbd5e1', dot: '#64748b' },
  },
  reconnecting: {
    light: { surface: '#c2410c', ink: '#ffffff', dot: '#ffffff' },
    dark: { surface: '#fb923c', ink: '#431407', dot: '#431407' },
  },
  offline: {
    light: { surface: '#b91c1c', ink: '#ffffff', dot: '#ffffff' },
    dark: { surface: '#f87171', ink: '#450a0a', dot: '#450a0a' },
  },
} as const;

export type ConnectionPaletteKey = keyof typeof CONNECTION_PALETTE;

/** Relative luminance, per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal-size text. */
export const AA_CONTRAST = 4.5;
