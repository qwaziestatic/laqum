/**
 * "Navigate" — hand off to Google Maps, and cope when it is not there.
 *
 * We do not build turn-by-turn (the brief is explicit). The job is to get the
 * driver into a maps app with the lot as the destination, and to degrade in a
 * way that still lets them find the place.
 *
 * THE ORDER, and why:
 *
 *   1. The Google Maps UNIVERSAL link. On Android with Maps installed the OS
 *      routes https://www.google.com/maps/... straight into the app; without
 *      it, the same URL opens the mobile site, which still gives directions.
 *      One URL covers the common case and its own fallback, which is why it
 *      is first rather than a maps:// scheme.
 *   2. `geo:` — Android's standard geo intent. Worth trying when the universal
 *      link is refused, because it lets the driver pick ANY installed maps app
 *      (OsmAnd, Waze, a local favourite), not only Google's.
 *   3. The plain web URL, forced.
 *   4. Nothing opened: hand the caller the coordinates to display with a copy
 *      button, plus the lot's phone number. A driver who can read the numbers
 *      aloud to someone is not stuck.
 *
 * All of it is a pure URL-builder plus an injected opener, so the ordering is
 * unit-tested without a device.
 */

export interface Destination {
  latitude: number;
  longitude: number;
  /** Shown to the user in the final fallback. */
  label: string;
}

/**
 * Coordinates only, never a place name.
 *
 * A lot's `name` is operator-supplied and may not resolve — or worse, may
 * resolve to a DIFFERENT place with a similar name, sending the driver across
 * Addis. The latitude and longitude are what the booking was validated
 * against, so they are what we navigate to.
 */
export function googleMapsUrl(destination: Destination): string {
  const coords = `${String(destination.latitude)},${String(destination.longitude)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coords)}&travelmode=driving`;
}

/** Android's geo intent, with a label for the pin. */
export function geoUri(destination: Destination): string {
  const coords = `${String(destination.latitude)},${String(destination.longitude)}`;
  return `geo:${coords}?q=${encodeURIComponent(`${coords}(${destination.label})`)}`;
}

export interface Opener {
  canOpen: (url: string) => Promise<boolean>;
  open: (url: string) => Promise<void>;
}

export type NavigateOutcome =
  | { opened: true; url: string; via: 'google-maps' | 'geo' | 'browser' }
  | { opened: false; coordinates: string };

/**
 * Try each tier in order; report which one worked.
 *
 * Every step is guarded: `canOpen` can lie (it returns false for undeclared
 * schemes on Android 11+ package visibility), and `open` can still throw when
 * the target disappears between the two calls. So a failure at any tier falls
 * through rather than surfacing, and only the last one gives up.
 */
export async function navigateTo(
  destination: Destination,
  opener: Opener,
): Promise<NavigateOutcome> {
  const tiers: { url: string; via: 'google-maps' | 'geo' | 'browser' }[] = [
    { url: googleMapsUrl(destination), via: 'google-maps' },
    { url: geoUri(destination), via: 'geo' },
    { url: googleMapsUrl(destination), via: 'browser' },
  ];

  for (const tier of tiers) {
    try {
      // The last tier does not ask permission: if nothing else worked, try to
      // open it anyway rather than refusing on canOpen's word.
      if (tier.via !== 'browser' && !(await opener.canOpen(tier.url))) continue;
      await opener.open(tier.url);
      return { opened: true, url: tier.url, via: tier.via };
    } catch {
      // Fall through to the next tier.
    }
  }

  return {
    opened: false,
    coordinates: `${String(destination.latitude)}, ${String(destination.longitude)}`,
  };
}
