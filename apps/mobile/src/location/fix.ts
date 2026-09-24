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

/**
 * How hard to try for a fresh fix.
 *
 * 'balanced' is the default: fast, and usually enough — the gate decides
 * whether the accuracy is good enough for THIS lot. 'highest' is for when the
 * gate has just said it is not (need_better_fix): the device test showed the
 * Retry there asking Balanced again, and getting the same imprecise answer.
 */
export type FixAccuracy = 'balanced' | 'highest';

export interface LocationDeps {
  servicesEnabled: () => Promise<boolean>;
  /** A CHECK. Never shows UI and never pauses the activity. */
  getPermission: () => Promise<PermissionState>;
  /** May show the dialog, and on Android ALWAYS pauses the activity. */
  requestPermission: () => Promise<PermissionState>;
  /** A fresh fix. Measured on the device test at 60 ms to 17 s (Balanced). */
  currentPosition: (accuracy: FixAccuracy) => Promise<Fix>;
  /** The platform's cached fix, or null. Measured at 59–275 ms. */
  lastKnownPosition: () => Promise<Fix | null>;
  /** Epoch millis, the same clock as Fix.timestampMs. */
  now: () => number;
}

/**
 * How old a last-known fix may be and still be shown first. The fresh fix
 * replaces it within seconds, and it never reaches the booking gate, so this
 * only bounds how wrong the list can look for those seconds.
 */
export const QUICK_FIX_MAX_AGE_MS = 10 * 60_000;

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

/** Services, then permission under `prompt`. Null means a position may be read. */
async function access(
  prompt: PermissionPrompt,
  deps: LocationDeps,
): Promise<LocationFailure | null> {
  // Services BEFORE permission: a granted permission is useless with the
  // device toggle off, and reporting "permission denied" there is a lie.
  if (!(await deps.servicesEnabled())) return { kind: 'services_off' };

  let permission = await deps.getPermission();
  if (shouldAsk(permission, prompt)) permission = await deps.requestPermission();
  if (permission.status !== 'granted') {
    return { kind: 'permission_denied', canAskAgain: permission.canAskAgain };
  }
  return null;
}

async function freshFix(deps: LocationDeps, accuracy: FixAccuracy): Promise<LocationResult> {
  try {
    return { kind: 'fix', fix: await deps.currentPosition(accuracy) };
  } catch (err) {
    return {
      kind: 'unavailable',
      message: err instanceof Error ? err.message : 'No position could be determined',
    };
  }
}

/** A fresh fix: what the booking gate needs. */
export async function resolveFix(
  prompt: PermissionPrompt,
  deps: LocationDeps,
  accuracy: FixAccuracy = 'balanced',
): Promise<LocationResult> {
  return (await access(prompt, deps)) ?? freshFix(deps, accuracy);
}

/**
 * A quick fix first, then the fresh one: what the lot LIST needs.
 *
 * On the device test the list waited for a fresh fix that took 60 ms, 1.4 s
 * and 17 s on three cold starts, while the platform's last-known fix was
 * there in under 0.3 s with the same 100 m accuracy.
 *
 * `report` is called up to twice, in order: with a last-known fix no older
 * than QUICK_FIX_MAX_AGE_MS, then with the fresh result. A failed fresh fix
 * is NOT reported after a quick one, so a usable position is never replaced
 * by a warning. Failures of access are reported once, and no position is
 * read without permission.
 *
 * NEVER for the booking gate. A last-known fix can be minutes old; the gate
 * gets resolveFix and checks staleness itself.
 */
export async function resolveFixQuickThenFresh(
  prompt: PermissionPrompt,
  deps: LocationDeps,
  report: (result: LocationResult) => void,
): Promise<void> {
  const denied = await access(prompt, deps);
  if (denied) {
    report(denied);
    return;
  }

  let quick: Fix | null = null;
  try {
    quick = await deps.lastKnownPosition();
  } catch {
    // A cache miss is not worth a warning; the fresh fix decides.
  }
  if (quick && deps.now() - quick.timestampMs > QUICK_FIX_MAX_AGE_MS) quick = null;
  if (quick) report({ kind: 'fix', fix: quick });

  const fresh = await freshFix(deps, 'balanced');
  if (fresh.kind === 'fix' || !quick) report(fresh);
}

/**
 * Rejects if `work` has not settled within `ms`. For the highest-accuracy
 * request, which indoors can take far longer than a driver will wait, or
 * never arrive at all; resolveFix turns the rejection into 'unavailable'.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
