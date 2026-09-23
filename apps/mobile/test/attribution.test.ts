import { describe, expect, it } from 'vitest';
import {
  MAP_ATTRIBUTION,
  OPEN_FREE_MAP_STYLES,
  OSM_COPYRIGHT_URL,
  mapStyleFor,
} from '../src/map/tiles.js';

/**
 * ATTRIBUTION IS A LICENCE OBLIGATION, NOT A DESIGN DETAIL.
 *
 * OpenFreeMap requires its credit, and OpenStreetMap's ODbL requires the data
 * credit. Shipping the map without them is a breach, and the realistic way
 * that happens is not malice — it is someone tidying a layout and dropping a
 * small grey line they took for decoration. This test is what makes that fail
 * loudly instead of silently.
 */

describe('the required attribution', () => {
  it('is EXACTLY the wording OpenFreeMap asks for', () => {
    // From the OpenFreeMap README: "OpenFreeMap © OpenMapTiles Data from
    // OpenStreetMap". Asserted character for character, because "roughly
    // right" is not what a licence asks for.
    expect(MAP_ATTRIBUTION).toBe('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
  });

  it('credits all three parties', () => {
    // The service, the tile schema, and the data. Dropping any one of them
    // would still "look attributed" while failing the obligation.
    expect(MAP_ATTRIBUTION).toContain('OpenFreeMap');
    expect(MAP_ATTRIBUTION).toContain('OpenMapTiles');
    expect(MAP_ATTRIBUTION).toContain('OpenStreetMap');
  });

  it('points at the OSM copyright page', () => {
    expect(OSM_COPYRIGHT_URL).toBe('https://www.openstreetmap.org/copyright');
  });
});

describe('tile styles need no key', () => {
  it('uses plain OpenFreeMap endpoints with no query string', () => {
    /*
     * The whole reason this stack was chosen: no key, no account, no card.
     * A `?key=` or `?api_key=` creeping in would mean someone had swapped in
     * a provider that bills, which is exactly what this project cannot use.
     */
    for (const url of Object.values(OPEN_FREE_MAP_STYLES)) {
      expect(url).toMatch(/^https:\/\/tiles\.openfreemap\.org\/styles\/[a-z0-9]+$/u);
      expect(url).not.toContain('?');
      expect(url.toLowerCase()).not.toContain('key');
      expect(url.toLowerCase()).not.toContain('token');
    }
  });

  it('has a distinct style per theme', () => {
    // Dark mode is a different style sheet, not a filter over the light one,
    // so both have to exist and differ.
    expect(mapStyleFor('light')).toBe(OPEN_FREE_MAP_STYLES.light);
    expect(mapStyleFor('dark')).toBe(OPEN_FREE_MAP_STYLES.dark);
    expect(mapStyleFor('light')).not.toBe(mapStyleFor('dark'));
  });
});
