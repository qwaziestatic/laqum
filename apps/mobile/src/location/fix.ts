import type { Fix } from './gate.js';

/**
 * Getting a fix, and when the app may ASK for location.
 *
 * Kept free of expo-location (see useLocation.ts for the binding) so the
 * decision is testable without a device, like push/registration.ts.
 *
 * THE ANDROID TRAP THIS EXISTS FOR. On Android, requesting a permission
 * ALWAYS launches the system's permission activity, even when the permission
 * is already granted — expo-modules-core's PermissionsService calls
 * Activity.requestPermissions with no "already granted?" check. That pauses
 * and resumes our activity, so AppState goes background → active, which
 * bumps `foregroundEpoch`, which reloads the screen, which requested again.
 * On the device test that loop ran ~4 times a second with no UI visible, until
 * Android 16 removed the app's task for "rapid-activity-launch" — the app
 * simply vanished while the driver looked at it.
 *
 * So permission is CHECKED first (no activity, no pause), and REQUESTED only
 * when `prompt` allows it and the answer is not already known.
 */

/**
 * When getFix may show the system permission dialog. Required, so every call
 * site has to decide.
 *
 * - 'first-time': only if this install has never asked. For anything that
 *   runs without a tap — mount, focus, return to the foreground. It asks at
 *   most once, ever, so no reload can turn into a loop.
 * - 'on-tap': also re-ask after an earlier refusal, while Android still
 *   allows asking. Only for a button the driver pressed.
 */
export type PermissionPrompt = 'first-time' | 'on-tap';

export interface PermissionState {
  /**
   * 'undetermined' means this install has never asked: expo-modules-core
   * records every request, and reports 'denied' ever after.
   */
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

export interface LocationDeps {
  servicesEnabled: () => Promise<boolean>;
  /** A CHECK. Never shows UI and never pauses the activity. */
  getPermission: () => Promise<PermissionState>;
  /** May show the dialog, and on Android ALWAYS pauses the activity. */
  requestPermission: () => Promise<PermissionState>;
  currentPosition: () => Promise<Fix>;
}

/*
 * The three failures are genuinely different problems with different fixes,
 * and collapsing them into "location unavailable" sends the driver to the
 * wrong place:
 *
 *   permission — the app may ask; recovery is Settings > Permissions
 *   services   — location is off DEVICE-WIDE; recovery is the system toggle,
 *                and no permission grant will help
 *   unavailable— permission and services are fine, no fix arrived (indoors,
 *                underground car park); recovery is to move and retry
 */
export type LocationFailure =
  | { kind: 'permission_denied'; canAskAgain: boolean }
  | { kind: 'services_off' }
  | { kind: 'unavailable'; message: string };

export type LocationResult = { kind: 'fix'; fix: Fix } | LocationFailure;

/** Whether to call requestPermission, given what the check returned. */
export function shouldAsk(permission: PermissionState, prompt: PermissionPrompt): boolean {
  if (permission.status === 'granted') return false;
  if (permission.status === 'undetermined') return true;
  // Denied before. Only a tap may ask again, and only while Android would
  // actually show the dialog; otherwise the request is a no-op that still
  // launches (and pauses for) the permission activity.
  return prompt === 'on-tap' && permission.canAskAgain;
}

export async function resolveFix(
  prompt: PermissionPrompt,
  deps: LocationDeps,
): Promise<LocationResult> {
  // Services BEFORE permission: a granted permission is useless with the
  // device toggle off, and reporting "permission denied" there is a lie.
  if (!(await deps.servicesEnabled())) return { kind: 'services_off' };

  let permission = await deps.getPermission();
  if (shouldAsk(permission, prompt)) permission = await deps.requestPermission();
  if (permission.status !== 'granted') {
    return { kind: 'permission_denied', canAskAgain: permission.canAskAgain };
  }

  try {
    return { kind: 'fix', fix: await deps.currentPosition() };
  } catch (err) {
    return {
      kind: 'unavailable',
      message: err instanceof Error ? err.message : 'No position could be determined',
    };
  }
}
