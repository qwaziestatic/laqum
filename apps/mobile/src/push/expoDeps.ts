import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import type { Api } from '../api/endpoints.js';
import type { PermissionStatus, PushDeps } from './registration.js';

/**
 * The Expo-backed implementation of PushDeps.
 *
 * Kept apart from registration.ts so the decision logic — which is the part
 * that is easy to get wrong — is testable without a device or a native
 * module.
 */

function toStatus(status: Notifications.PermissionStatus): PermissionStatus {
  // Widened to string before comparing: expo types these as an enum, and a
  // string literal is not the same enum type even when the values match.
  const value: string = status;
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  return 'undetermined';
}

export function pushDeps(api: Api, hasBooked: boolean): PushDeps {
  return {
    getPermissions: async () => toStatus((await Notifications.getPermissionsAsync()).status),
    requestPermissions: async () =>
      toStatus((await Notifications.requestPermissionsAsync()).status),

    getToken: async () => {
      /*
       * The EAS project id is REQUIRED for a development or production build.
       * Without it getExpoPushTokenAsync throws rather than returning null,
       * and the failure reads as a permissions problem — so it is caught and
       * reported as "unavailable", which is what it actually is.
       */
      const eas = Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined;
      const projectId = eas?.projectId;
      if (!projectId) return null;
      try {
        const token = await Notifications.getExpoPushTokenAsync({ projectId });
        return token.data;
      } catch {
        // No Play Services, an emulator, or Expo Go: not an error worth
        // showing the driver, who did not ask for any of this.
        return null;
      }
    },

    upload: async (token) => {
      await api.registerPushToken(token);
    },

    hasBooked: () => Promise.resolve(hasBooked),
  };
}
