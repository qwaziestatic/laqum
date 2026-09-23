import type { ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config.
 *
 * Replaces app.json so that secrets and per-machine values come from the
 * environment instead of the repository.
 *
 * THE MAPS KEY IS NOT A SECRET, AND THAT IS THE POINT. Any Android API key
 * ships inside the APK and can be extracted from it in about a minute. Keeping
 * it out of git stops it leaking into a public repo and into every fork, but
 * the REAL protection is the restriction in Google Cloud: the key is bound to
 * this package name AND the SHA-1 of the signing certificate, so an extracted
 * copy is useless in anyone else's app. docs/DEVICE-TEST.md step 3b has the
 * exact steps.
 */

const googleMapsApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY ?? '';

/**
 * Where the app talks to.
 *
 * On a device this MUST be the dev machine's LAN address — `localhost` is the
 * phone. Passed through `extra` as well as the EXPO_PUBLIC_ variable so it is
 * visible in `expo config` when diagnosing a build.
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/v1';

/** EAS injects this; it is 'development' | 'preview' | 'production'. */
const profile = process.env.EAS_BUILD_PROFILE ?? 'development';
const isProduction = profile === 'production';

const config: ExpoConfig = {
  name: 'ላቁም?',
  slug: 'laqum',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'laqum',
  userInterfaceStyle: 'automatic',
  // No `newArchEnabled`: SDK 57 removed it from ExpoConfig because the new
  // architecture is now the default and is no longer opt-in.

  android: {
    package: 'et.laqum.driver',
    // No `edgeToEdgeEnabled`: prebuild warns it is no longer customisable,
    // because Android 16 makes edge-to-edge mandatory.
    config: {
      // Empty in a checkout without the variable set. The map then renders
      // blank grey, which is a missing key rather than a broken app — called
      // out in the device script so it is not misdiagnosed.
      googleMaps: { apiKey: googleMapsApiKey },
    },
    permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'CAMERA'],
  },

  ios: {
    bundleIdentifier: 'et.laqum.driver',
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Laqum checks you are close enough to the parking lot before holding a slot for you.',
      NSCameraUsageDescription:
        'Laqum shows your booking QR code; the camera is not used to record anything.',
      ...(isProduction
        ? {}
        : {
            /*
             * iOS equivalent of the Android cleartext allowance below, for
             * the same reason and with the same production exclusion. iOS is
             * UNTESTED — see CLAUDE.md, Phase 4 open items.
             */
            NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
          }),
    },
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Laqum checks you are close enough to the parking lot before holding a slot for you.',
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          /*
           * CLEARTEXT HTTP TO THE DEV API — DEVELOPMENT AND PREVIEW ONLY.
           *
           * Android 9 (API 28) defaults `usesCleartextTraffic` to false, so a
           * release build silently refuses http:// and every request fails
           * with "Network request failed". The dev API is plain http on a LAN
           * address, so a build meant for device testing has to allow it.
           *
           * FALSE in production, explicitly. This is the setting that would
           * be genuinely dangerous to leave on in a shipped app, so it is
           * keyed off EAS_BUILD_PROFILE rather than left to a default, and
           * `expo prebuild` output is checked in DEVICE-TEST.md step 3c.
           */
          usesCleartextTraffic: !isProduction,
        },
      },
    ],
  ],

  experiments: { typedRoutes: true },

  extra: {
    apiUrl,
    eas: {
      // Written by `eas init`; empty until then, which is why push
      // registration cannot work before it.
      projectId: process.env.EAS_PROJECT_ID ?? '',
    },
  },
};

export default config;
