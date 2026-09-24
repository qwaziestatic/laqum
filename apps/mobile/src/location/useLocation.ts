import * as Location from 'expo-location';
import { useCallback, useState } from 'react';
import {
  resolveFix,
  type LocationDeps,
  type LocationResult,
  type PermissionPrompt,
  type PermissionState,
} from './fix.js';

export type { LocationFailure, LocationResult, PermissionPrompt } from './fix.js';

/**
 * The expo-location binding for fix.ts, which holds the decisions — above all
 * WHEN the app may ask for permission, and why asking is never free on
 * Android. This file only translates.
 */

function toPermission(response: Location.LocationPermissionResponse): PermissionState {
  // Widened to string: expo-location types status as an enum, so comparing
  // against a literal is not a shared-type comparison.
  const status: string = response.status;
  return {
    status: status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined',
    canAskAgain: response.canAskAgain,
  };
}

export const expoLocationDeps: LocationDeps = {
  servicesEnabled: () => Location.hasServicesEnabledAsync(),
  getPermission: async () => toPermission(await Location.getForegroundPermissionsAsync()),
  requestPermission: async () => toPermission(await Location.requestForegroundPermissionsAsync()),
  currentPosition: async () => {
    const position = await Location.getCurrentPositionAsync({
      // Balanced, not Highest: Highest waits for GPS lock, which in a city
      // street can take 30s or never. The gate decides whether the accuracy
      // we got is good enough for THIS lot, so a fast coarse fix is often
      // sufficient and a slow precise one often unnecessary.
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      // Some platforms report null; the gate treats that as maximally
      // uncertain rather than perfect.
      accuracyM: position.coords.accuracy ?? Number.POSITIVE_INFINITY,
      timestampMs: position.timestamp,
    };
  },
};

/** See PermissionPrompt: 'first-time' unless the driver just pressed a button. */
export function getFix(prompt: PermissionPrompt): Promise<LocationResult> {
  return resolveFix(prompt, expoLocationDeps);
}

export interface UseLocation {
  request: (prompt: PermissionPrompt) => Promise<LocationResult>;
  last: LocationResult | null;
  busy: boolean;
}

export function useLocation(): UseLocation {
  const [last, setLast] = useState<LocationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(async (prompt: PermissionPrompt) => {
    setBusy(true);
    try {
      const result = await getFix(prompt);
      setLast(result);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  return { request, last, busy };
}
