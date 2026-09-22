import type { SlotDisplayStatus } from '@laqum/shared';

/**
 * How each slot status is presented — in ONE place.
 *
 * STATUS IS NEVER CONVEYED BY COLOUR ALONE. Every status has three channels:
 *
 *   colour  — fastest to read across a grid, at a glance;
 *   glyph   — survives glare, greyscale, and colour vision deficiency;
 *   label   — unambiguous, and translated.
 *
 * Keeping the three together in one table is what makes that guarantee
 * checkable: a new status cannot be added with a colour and no glyph, because
 * the type requires all three. statusPresentation.test.ts asserts the table is
 * complete and that no two statuses share a glyph.
 */

export interface StatusPresentation {
  /** Tailwind classes for the tile surface and its ink. */
  surface: string;
  /**
   * A geometric glyph, not an emoji: emoji render differently on every
   * platform and some Android builds have no colour font at all.
   */
  glyph: string;
  /** i18n key under `slot.`. */
  labelKey: string;
  /** Sort weight for "needs attention first" ordering in the header. */
  urgency: number;
}

export const STATUS_PRESENTATION: Record<SlotDisplayStatus, StatusPresentation> = {
  free: {
    surface: 'bg-slot-free text-slot-free-ink',
    glyph: '○',
    labelKey: 'slot.free',
    urgency: 0,
  },
  reserved: {
    surface: 'bg-slot-reserved text-slot-reserved-ink',
    glyph: '◔',
    labelKey: 'slot.reserved',
    urgency: 1,
  },
  occupied: {
    surface: 'bg-slot-occupied text-slot-occupied-ink',
    glyph: '●',
    labelKey: 'slot.occupied',
    urgency: 2,
  },
  overstay: {
    surface: 'bg-slot-overstay text-slot-overstay-ink',
    glyph: '▲',
    labelKey: 'slot.overstay',
    urgency: 3,
  },
  out_of_service: {
    surface: 'bg-slot-oos text-slot-oos-ink',
    glyph: '✕',
    labelKey: 'slot.out_of_service',
    urgency: 0,
  },
};

export function presentationFor(status: SlotDisplayStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}
