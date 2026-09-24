import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveFix,
  shouldAsk,
  type LocationDeps,
  type LocationResult,
  type PermissionState,
} from '../src/location/fix.js';

/**
 * WHEN the app asks for location — the device-test blocker.
 *
 * On Android every permission request launches the system permission
 * activity, even for a permission already granted. That pauses and resumes
 * our activity, which the app reads as a return to the foreground, which
 * reloaded the home screen, which requested again. The device log showed 84
 * requests in 19 s, then `wm_task_removed … rapid-activity-launch`: Android 16
 * removed the app's task and it vanished with no error.
 */

const GRANTED: PermissionState = { status: 'granted', canAskAgain: true };
const UNDETERMINED: PermissionState = { status: 'undetermined', canAskAgain: true };
const DENIED: PermissionState = { status: 'denied', canAskAgain: true };
const BLOCKED: PermissionState = { status: 'denied', canAskAgain: false };

const FIX = { latitude: 9.0092, longitude: 38.7869, accuracyM: 12, timestampMs: 1 };

/**
 * A fake device whose permission behaves like Android's: requesting records
 * the ask (so 'undetermined' becomes 'denied' if refused), and `onRequest`
 * fires the way the activity pause/resume does.
 */
function device(
  initial: PermissionState,
  options: { answer?: 'grant' | 'refuse'; onRequest?: () => void } = {},
): LocationDeps & { requestPermission: ReturnType<typeof vi.fn> } {
  let state = initial;
  const requestPermission = vi.fn(() => {
    options.onRequest?.();
    if (state.status !== 'granted' && (state.status === 'undetermined' || state.canAskAgain)) {
      state =
        options.answer === 'grant' ? GRANTED : { status: 'denied', canAskAgain: state.canAskAgain };
    }
    return Promise.resolve(state);
  });
  return {
    servicesEnabled: () => Promise.resolve(true),
    getPermission: () => Promise.resolve(state),
    requestPermission,
    currentPosition: () => Promise.resolve(FIX),
  };
}

describe('shouldAsk', () => {
  it('never asks for a permission that is already granted', () => {
    expect(shouldAsk(GRANTED, 'first-time')).toBe(false);
    expect(shouldAsk(GRANTED, 'on-tap')).toBe(false);
  });

  it('asks on the first-ever occasion, whatever triggered it', () => {
    expect(shouldAsk(UNDETERMINED, 'first-time')).toBe(true);
    expect(shouldAsk(UNDETERMINED, 'on-tap')).toBe(true);
  });

  it('re-asks after a refusal only from a tap, and only while Android allows it', () => {
    expect(shouldAsk(DENIED, 'first-time')).toBe(false);
    expect(shouldAsk(DENIED, 'on-tap')).toBe(true);
    expect(shouldAsk(BLOCKED, 'on-tap')).toBe(false);
  });
});

describe('resolveFix', () => {
  it('gets a fix WITHOUT requesting when permission is already granted', async () => {
    // The regression itself: this request is what launched the activity.
    const deps = device(GRANTED);

    const result = await resolveFix('first-time', deps);

    expect(result).toEqual({ kind: 'fix', fix: FIX });
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('asks once on first use, and uses the answer', async () => {
    const deps = device(UNDETERMINED, { answer: 'grant' });

    expect(await resolveFix('first-time', deps)).toEqual({ kind: 'fix', fix: FIX });
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal without asking again on an automatic reload', async () => {
    const deps = device(DENIED);

    const result = await resolveFix('first-time', deps);

    expect(result).toEqual({ kind: 'permission_denied', canAskAgain: true });
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('lets a tap re-ask after a refusal', async () => {
    const deps = device(DENIED, { answer: 'grant' });

    expect(await resolveFix('on-tap', deps)).toEqual({ kind: 'fix', fix: FIX });
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('does not ask when Android has blocked asking, even from a tap', async () => {
    const deps = device(BLOCKED);

    const result = await resolveFix('on-tap', deps);

    expect(result).toEqual({ kind: 'permission_denied', canAskAgain: false });
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('checks services before anything, and touches no permission when they are off', async () => {
    const deps = { ...device(GRANTED), servicesEnabled: () => Promise.resolve(false) };
    const getPermission = vi.spyOn(deps, 'getPermission');

    expect(await resolveFix('on-tap', deps)).toEqual({ kind: 'services_off' });
    expect(getPermission).not.toHaveBeenCalled();
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('reports a position failure as unavailable, not as a permission problem', async () => {
    const deps = {
      ...device(GRANTED),
      currentPosition: () => Promise.reject(new Error('Location request timed out')),
    };

    expect(await resolveFix('first-time', deps)).toEqual({
      kind: 'unavailable',
      message: 'Location request timed out',
    });
  });
});

describe('the Android reload loop from the device test', () => {
  const CAP = 100;

  /**
   * Home as the device log shows it. Each permission request pauses and
   * resumes the activity — one "return to the foreground" — and each return
   * reloads the home screen automatically. Runs until nothing is pending, or
   * CAP reloads, which means a loop.
   */
  async function runHome(
    initial: PermissionState,
    load: (deps: LocationDeps) => Promise<LocationResult>,
    answer: 'grant' | 'refuse' = 'refuse',
  ): Promise<{ requests: number; reloads: number }> {
    let pendingForegrounds = 0;
    const deps = device(initial, {
      answer,
      onRequest: () => {
        pendingForegrounds += 1;
      },
    });

    let reloads = 1;
    await load(deps); // the first focus
    while (pendingForegrounds > 0 && reloads < CAP) {
      pendingForegrounds -= 1;
      reloads += 1;
      await load(deps);
    }
    return { requests: deps.requestPermission.mock.calls.length, reloads };
  }

  const automaticReload = (deps: LocationDeps): Promise<LocationResult> =>
    resolveFix('first-time', deps);

  it('settles at once when permission is already granted — the device-test case', async () => {
    expect(await runHome(GRANTED, automaticReload)).toEqual({ requests: 0, reloads: 1 });
  });

  it('asks exactly once on a fresh install, whatever the answer', async () => {
    expect(await runHome(UNDETERMINED, automaticReload, 'grant')).toEqual({
      requests: 1,
      reloads: 2,
    });
    expect(await runHome(UNDETERMINED, automaticReload, 'refuse')).toEqual({
      requests: 1,
      reloads: 2,
    });
  });

  it('never asks after a refusal', async () => {
    expect(await runHome(DENIED, automaticReload)).toEqual({ requests: 0, reloads: 1 });
    expect(await runHome(BLOCKED, automaticReload)).toEqual({ requests: 0, reloads: 1 });
  });

  it('catches the old behaviour: requesting on every load runs away', async () => {
    // What getFix did before the fix, so this harness is known to detect the
    // loop rather than to pass by construction.
    const requestEveryTime = async (deps: LocationDeps): Promise<LocationResult> => {
      await deps.requestPermission();
      return { kind: 'fix', fix: await deps.currentPosition() };
    };

    const run = await runHome(GRANTED, requestEveryTime);

    expect(run.reloads).toBe(CAP);
    expect(run.requests).toBe(CAP);
  });
});

describe('only the binding may request location permission', () => {
  const ROOTS = ['../src', '../app'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  const BINDING = 'src/location/useLocation.ts';
  const MOBILE = fileURLToPath(new URL('..', import.meta.url));

  async function sources(dir: string, acc: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await sources(full, acc);
      else if (/\.tsx?$/u.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  it('finds requestForegroundPermissionsAsync nowhere else', async () => {
    // Every other route to the dialog bypasses shouldAsk, which is how an
    // automatic reload would start asking again.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of await sources(root)) {
        const path = relative(MOBILE, file).replaceAll('\\', '/');
        if (path === BINDING) continue;
        if ((await readFile(file, 'utf8')).includes('requestForegroundPermissionsAsync')) {
          offenders.push(path);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(await readFile(join(MOBILE, BINDING), 'utf8')).toContain(
      'requestForegroundPermissionsAsync',
    );
  });
});
