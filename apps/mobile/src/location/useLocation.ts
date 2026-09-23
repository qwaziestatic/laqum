import * as Location from 'expo-location';
import { useCallback, useState } from 'react';
import type { Fix } from './gate.js';

/**
 * Getting a fix, and naming the three ways it fails.
 *
 * These are genuinely different problems with genuinely different fixes, and
 * collapsing them into "location unavailable" sends the driver to the wrong
 * place:
 *
 *   permission — the app may ask; recovery is Settings > Permissions
 *   services   — location is off DEVICE-WIDE; recovery is the system toggle,
 *                and no permission grant will help
 *   unavailable— permission and services are fine, no fix arrived (indoors,
 *                underground car park); recovery is to move and retry
 *
 * `hasServicesEnabledAsync` is what separates the first two, and it is the
 * check most apps skip — which is why they tell a user to grant a permission
 * they have already granted.
 */

export type LocationFailure =
  | { kind: 'permission_denied'; canAskAgain: boolean }
  | { kind: 'services_off' }
  | { kind: 'unavailable'; message: string };

export type LocationResult = { kind: 'fix'; fix: Fix } | LocationFailure;

export interface UseLocation {
  request: () => Promise<LocationResult>;
  last: LocationResult | null;
  busy: boolean;
}

export async function getFix(): Promise<LocationResult> {
  // Services BEFORE permission: a granted permission is useless with the
  // device toggle off, and reporting "permission denied" there is a lie.
  const servicesOn = await Location.hasServicesEnabledAsync();
  if (!servicesOn) return { kind: 'services_off' };

  const permission = await Location.requestForegroundPermissionsAsync();
  // Widened to string: expo-location types status as an enum, so comparing
  // against a literal is not a shared-type comparison.
  const status: string = permission.status;
  if (status !== 'granted') {
    return { kind: 'permission_denied', canAskAgain: permission.canAskAgain };
  }

  try {
    const position = await Location.getCurrentPositionAsync({
      // Balanced, not Highest: Highest waits for GPS lock, which in a city
      // street can take 30s or never. The gate decides whether the accuracy
      // we got is good enough for THIS lot, so a fast coarse fix is often
      // sufficient and a slow precise one often unnecessary.
      accuracy: Location.Accuracy.Balanced,
    });

    return {
      kind: 'fix',
      fix: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        // Some platforms report null; the gate treats that as maximally
        // uncertain rather than perfect.
        accuracyM: position.coords.accuracy ?? Number.POSITIVE_INFINITY,
        timestampMs: position.timestamp,
      },
    };
  } catch (err) {
    return {
      kind: 'unavailable',
      message: err instanceof Error ? err.message : 'No position could be determined',
    };
  }
}

export function useLocation(): UseLocation {
  const [last, setLast] = useState<LocationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(async () => {
    setBusy(true);
    try {
      const result = await getFix();
      setLast(result);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  return { request, last, busy };
}
