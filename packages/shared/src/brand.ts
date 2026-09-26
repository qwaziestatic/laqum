/**
 * THE BRAND COLOURS. Identity, not interface.
 *
 * Sampled from the product owner's illustration
 * (assets/brand/source/laqum-illustration.jpg) by scripts/brand/build.mjs,
 * which records them in assets/brand/generated/brand.json; brand.test.ts
 * asserts the two agree. The rules are in docs/BRAND.md; in short:
 *
 * - They mark the product: the icon, the splash, the intro, the favicon. They
 *   never fill a tile, chip, badge or button in the operational UI, where
 *   colour means slot status. That is not caution for its own sake: navy is
 *   ΔE2000 8.0 from the dark theme's out-of-service tile and 14.0 from the
 *   light "occupied" blue, and orange is 9.0 from the dark "reconnecting"
 *   chip. Kept apart, they cannot be mistaken for each other.
 * - The car's red is sampled only to be refused (FORBIDDEN_BRAND_COLOURS):
 *   red means "act now" in this product, and that red is ΔE2000 8.3 from the
 *   overstay tile.
 * - Every text/background pair below clears WCAG AA. The brand surfaces are
 *   the same in both themes (a navy backdrop, a white card), so each pair
 *   holds in light and dark alike.
 */
export const BRAND = {
  /** The "ላቁም?" wordmark's navy: the brand primary. */
  navy: '#1f3f71',
  /** Anything drawn ON navy: the splash mark, the intro's loading indicator. */
  onNavy: '#ffffff',
  /** The attendant's orange: an accent, used sparingly. Never text on a light surface. */
  orange: '#d57933',
  /** Text on orange, should any ever be drawn there. */
  onOrange: '#0f172a',
  /** The illustration's white, and so the card it is presented on. */
  paper: '#fdfdfd',
} as const;

/**
 * The intro artwork's geometry, generated with its images by
 * scripts/brand/build.mjs (brand.json, "intro"); brand.test.ts checks they
 * agree. The illustration is shown with its wordmark cut out, and the
 * wordmark is drawn on top at this box, in fractions of the illustration, so
 * the two land on the original composition at any size.
 */
export const BRAND_ARTWORK = {
  aspect: 2.19333,
  wordmark: { left: 0.59726, top: 0.30125, width: 0.38412, height: 0.2925 },
} as const;

/** Sampled only so it can be refused. */
export const FORBIDDEN_BRAND_COLOURS = {
  /** The car's red. Red means "act now" here; this is not a UI colour. */
  carRed: '#dc544e',
} as const;

export interface BrandTextPair {
  name: string;
  ink: string;
  surface: string;
}

/** Every text-on-brand-colour pair the product draws, each asserted ≥ AA. */
export const BRAND_TEXT_PAIRS: readonly BrandTextPair[] = [
  { name: 'the white mark on the navy splash', ink: BRAND.onNavy, surface: BRAND.navy },
  { name: 'the navy wordmark on the paper card', ink: BRAND.navy, surface: BRAND.paper },
  { name: 'the navy wordmark on the white icon', ink: BRAND.navy, surface: '#ffffff' },
  { name: 'ink on the orange accent', ink: BRAND.onOrange, surface: BRAND.orange },
];
