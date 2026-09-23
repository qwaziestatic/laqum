import { describe, expect, it, vi } from 'vitest';
import {
  geoUri,
  googleMapsUrl,
  navigateTo,
  type Destination,
  type Opener,
} from '../src/nav/mapsLink.js';

const PIASSA: Destination = {
  latitude: 9.0348,
  longitude: 38.7508,
  label: 'Piassa Central Parking',
};

/** An opener that accepts only the schemes listed. */
function openerFor(accepted: string[]): Opener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    canOpen: (url) => Promise.resolve(accepted.some((prefix) => url.startsWith(prefix))),
    open: (url) => {
      if (!accepted.some((prefix) => url.startsWith(prefix))) {
        return Promise.reject(new Error('no handler'));
      }
      opened.push(url);
      return Promise.resolve();
    },
  };
}

describe('the URL', () => {
  it('navigates to COORDINATES, never to the lot name', () => {
    /*
     * A name may not resolve, or may resolve to a different place with a
     * similar name — sending the driver across the city. The coordinates are
     * what the booking was validated against.
     */
    const url = googleMapsUrl(PIASSA);
    expect(url).toContain('destination=9.0348%2C38.7508');
    expect(url).not.toContain('Piassa');
  });

  it('asks for driving directions', () => {
    expect(googleMapsUrl(PIASSA)).toContain('travelmode=driving');
  });

  it('builds a geo: URI with a label for the pin', () => {
    const uri = geoUri(PIASSA);
    expect(uri).toMatch(/^geo:9\.0348,38\.7508\?q=/u);
    expect(decodeURIComponent(uri)).toContain('Piassa Central Parking');
  });
});

describe('the fallback chain', () => {
  it('uses Google Maps when it is installed', async () => {
    const opener = openerFor(['https://www.google.com/maps']);
    const result = await navigateTo(PIASSA, opener);
    expect(result).toMatchObject({ opened: true, via: 'google-maps' });
  });

  it('falls back to geo: so ANY maps app can take it', async () => {
    // Google Maps absent, but OsmAnd or Waze may be there.
    const opener = openerFor(['geo:']);
    const result = await navigateTo(PIASSA, opener);
    expect(result).toMatchObject({ opened: true, via: 'geo' });
    expect(opener.opened[0]).toMatch(/^geo:/u);
  });

  it('falls back to the browser when no maps app answers', async () => {
    // canOpen says no to everything, but the browser tier tries anyway —
    // canOpen lies under Android 11+ package visibility.
    const opener: Opener & { opened: string[] } = {
      opened: [],
      canOpen: () => Promise.resolve(false),
      open: (url) => {
        opener.opened.push(url);
        return Promise.resolve();
      },
    };
    const result = await navigateTo(PIASSA, opener);
    expect(result).toMatchObject({ opened: true, via: 'browser' });
  });

  it('gives the driver the coordinates when nothing at all opens', async () => {
    const opener = openerFor([]);
    const result = await navigateTo(PIASSA, opener);
    expect(result).toEqual({ opened: false, coordinates: '9.0348, 38.7508' });
  });

  it('survives open() throwing AFTER canOpen said yes', async () => {
    /*
     * A real race: the handler can disappear between the two calls, and on
     * Android canOpen is answered from a cached package list. A throw here
     * must fall through, not surface.
     */
    const opener: Opener = {
      canOpen: (url) => Promise.resolve(url.startsWith('https://')),
      open: (url) => {
        if (url.startsWith('https://')) return Promise.reject(new Error('activity not found'));
        return Promise.resolve();
      },
    };
    const result = await navigateTo(PIASSA, opener);
    // First tier threw, geo was refused by canOpen, browser tier threw too.
    expect(result).toEqual({ opened: false, coordinates: '9.0348, 38.7508' });
  });

  it('tries the tiers in order and stops at the first success', async () => {
    const canOpen = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue(undefined);
    await navigateTo(PIASSA, { canOpen, open });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toContain('google.com/maps');
  });
});
