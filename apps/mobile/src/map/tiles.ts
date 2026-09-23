import type { Scheme } from '../theme.js';

/**
 * Basemap tiles: MapLibre over OpenFreeMap.
 *
 * APPROVED DEVIATION FROM THE BRIEF. The brief specifies react-native-maps
 * with the Google provider. Google Maps Platform requires a billing account
 * with an international card, which this project does not have, so the map is
 * MapLibre + OpenFreeMap instead. See CLAUDE.md, "Map stack".
 *
 * OpenFreeMap's own terms, quoted from its README:
 *
 *   "There's no registration, no user database, no API keys, and no cookies."
 *   "no limits on the number of map views or requests"
 *
 * There is nothing to sign up for, nothing to pay, and nothing to keep secret
 * — which is the entire reason it was chosen.
 *
 * WHAT IT DOES NOT OFFER: any uptime guarantee or SLA. It is a free public
 * service funded by sponsorship. The app therefore treats a blank map as an
 * expected state rather than a fault, and the lot LIST works without it.
 * OpenFreeMap recommends self-hosting for production; that is a Phase 5
 * decision, and it needs a server we do not yet have.
 */

/** Style endpoints, from https://openfreemap.org/quick_start/ */
export const OPEN_FREE_MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

export function mapStyleFor(scheme: Scheme): string {
  return OPEN_FREE_MAP_STYLES[scheme];
}

/**
 * THE ATTRIBUTION OPENFREEMAP REQUIRES, verbatim.
 *
 * From its README: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
 *
 * Rendered as permanent visible text, NOT left to MapLibre's built-in
 * ornament. Two reasons: the ornament is an attribution *button* that opens a
 * dialog (confirmed in the installed source — `attribution?: boolean` toggles
 * a button, not a line), so on its own it does not display the credit; and an
 * attribution that depends on a library default is one refactor away from a
 * licence breach. attribution.test.ts asserts this string exactly.
 */
export const MAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';

/** Where the OSM half of that credit points. */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
