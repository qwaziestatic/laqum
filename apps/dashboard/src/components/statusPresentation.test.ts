import { SLOT_DISPLAY_STATUSES } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { resources } from '../i18n.js';
import { STATUS_PRESENTATION, presentationFor } from './statusPresentation.js';

/**
 * STATUS IS NEVER CONVEYED BY COLOUR ALONE.
 *
 * The brief requires it and the setting demands it: a tablet in direct Addis
 * sun washes out hue long before it washes out shape, and roughly one man in
 * twelve has a colour vision deficiency. These tests make the rule checkable
 * rather than a note in a comment.
 */

describe('every status has all three channels', () => {
  it('covers every display status the view can receive', () => {
    // Driven from the shared constant, so a new status added to the database
    // view fails here rather than rendering as a blank tile.
    expect(Object.keys(STATUS_PRESENTATION).sort()).toEqual([...SLOT_DISPLAY_STATUSES].sort());
  });

  it('gives every status a colour, a glyph AND a label key', () => {
    for (const status of SLOT_DISPLAY_STATUSES) {
      const presentation = presentationFor(status);
      expect(presentation.surface, `${status} colour`).toMatch(/^bg-/u);
      expect(presentation.glyph.trim().length, `${status} glyph`).toBeGreaterThan(0);
      expect(presentation.labelKey, `${status} label`).toBe(`slot.${status}`);
    }
  });

  it('gives every status a DISTINCT glyph', () => {
    // Two statuses sharing a glyph would collapse the non-colour channel
    // exactly where it is needed most.
    const glyphs = SLOT_DISPLAY_STATUSES.map((status) => presentationFor(status).glyph);
    expect(new Set(glyphs).size, 'glyphs must be unique').toBe(glyphs.length);
  });

  it('gives every status a DISTINCT surface class', () => {
    const surfaces = SLOT_DISPLAY_STATUSES.map((status) => presentationFor(status).surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it('uses only glyphs that render without a colour emoji font', () => {
    /*
     * Emoji are banned here. They render differently on every platform, some
     * Android builds ship no colour emoji font at all, and a tofu box is
     * worse than no glyph. Geometric shapes are in every system font.
     */
    for (const status of SLOT_DISPLAY_STATUSES) {
      const glyph = presentationFor(status).glyph;
      const codePoint = glyph.codePointAt(0) ?? 0;
      // Emoji live above U+1F000; variation selectors signal emoji rendering.
      expect(codePoint, `${status} must not be an emoji`).toBeLessThan(0x1f000);
      expect(glyph, `${status} must not force emoji presentation`).not.toContain('️');
    }
  });

  it('has a translated label for every status in BOTH locales', () => {
    for (const locale of ['am', 'en'] as const) {
      const slot = resources[locale].translation.slot as unknown as Record<string, string>;
      for (const status of SLOT_DISPLAY_STATUSES) {
        expect(slot[status]?.trim(), `${locale}.slot.${status}`).toBeTruthy();
      }
    }
  });
});
