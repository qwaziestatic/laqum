import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  QUICK_FIX_MAX_AGE_MS,
  resolveFix,
  resolveFixQuickThenFresh,
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

const NOW = 1_790_000_000_000;
const FIX = { latitude: 9.0092, longitude: 38.7869, accuracyM: 12, timestampMs: NOW };
/** A cached fix 30 s old, as on the device (13–39 s). */
const CACHED = { latitude: 9.01, longitude: 38.79, accuracyM: 100, timestampMs: NOW - 30_000 };

/**
 * A fake device whose permission behaves like Android's: requesting records
 * the ask (so 'undetermined' becomes 'denied' if refused), and `onRequest`
 * fires the way the activity pause/resume does. No cached fix unless given.
 */
function device(
  initial: PermissionState,
  options: {
    answer?: 'grant' | 'refuse';
    onRequest?: () => void;
    lastKnown?: typeof FIX | null;
  } = {},
): LocationDeps & {
  requestPermission: ReturnType<typeof vi.fn>;
  lastKnownPosition: ReturnType<typeof vi.fn>;
} {
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
    lastKnownPosition: vi.fn(() => Promise.resolve(options.lastKnown ?? null)),
    now: () => NOW,
  };
}

/** Runs the list's resolver and returns everything it reported, in order. */
async function reports(
  prompt: 'first-time' | 'on-tap',
  deps: LocationDeps,
): Promise<LocationResult[]> {
  const seen: LocationResult[] = [];
  await resolveFixQuickThenFresh(prompt, deps, (result) => seen.push(result));
  return seen;
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

describe('resolveFixQuickThenFresh — the lot list', () => {
  /*
   * The device test's cold starts: fresh fix 60 ms, 1.4 s and 17 s; the
   * last-known fix under 0.3 s at the same 100 m accuracy. The list waited
   * for the fresh one.
   */

  it('reports the cached fix first, then the fresh one', async () => {
    const deps = device(GRANTED, { lastKnown: CACHED });

    expect(await reports('first-time', deps)).toEqual([
      { kind: 'fix', fix: CACHED },
      { kind: 'fix', fix: FIX },
    ]);
  });

  it('does not wait for a slow fresh fix before reporting the cached one', async () => {
    // A fresh fix that has not arrived yet, like the 17 s one on the device.
    let arrive: (fix: typeof FIX) => void = () => undefined;
    const deps = {
      ...device(GRANTED, { lastKnown: CACHED }),
      currentPosition: () =>
        new Promise<typeof FIX>((resolve) => {
          arrive = resolve;
        }),
    };
    const seen: LocationResult[] = [];

    const done = resolveFixQuickThenFresh('first-time', deps, (result) => seen.push(result));
    await vi.waitFor(() => {
      expect(seen).toEqual([{ kind: 'fix', fix: CACHED }]);
    });

    arrive(FIX);
    await done;
    expect(seen).toEqual([
      { kind: 'fix', fix: CACHED },
      { kind: 'fix', fix: FIX },
    ]);
  });

  it('skips a cached fix older than the limit', async () => {
    const stale = { ...CACHED, timestampMs: NOW - QUICK_FIX_MAX_AGE_MS - 1 };
    const deps = device(GRANTED, { lastKnown: stale });

    expect(await reports('first-time', deps)).toEqual([{ kind: 'fix', fix: FIX }]);
  });

  it('keeps a cached fix exactly at the limit', async () => {
    const edge = { ...CACHED, timestampMs: NOW - QUICK_FIX_MAX_AGE_MS };
    const deps = device(GRANTED, { lastKnown: edge });

    expect(await reports('first-time', deps)).toEqual([
      { kind: 'fix', fix: edge },
      { kind: 'fix', fix: FIX },
    ]);
  });

  it('reports only the fresh fix when nothing is cached', async () => {
    expect(await reports('first-time', device(GRANTED))).toEqual([{ kind: 'fix', fix: FIX }]);
  });

  it('never replaces a usable cached fix with a failed fresh one', async () => {
    const deps = {
      ...device(GRANTED, { lastKnown: CACHED }),
      currentPosition: () => Promise.reject(new Error('Location request timed out')),
    };

    expect(await reports('first-time', deps)).toEqual([{ kind: 'fix', fix: CACHED }]);
  });

  it('reports the failure when there is nothing better', async () => {
    const deps = {
      ...device(GRANTED),
      currentPosition: () => Promise.reject(new Error('Location request timed out')),
    };

    expect(await reports('first-time', deps)).toEqual([
      { kind: 'unavailable', message: 'Location request timed out' },
    ]);
  });

  it('treats a failing cache as empty rather than as an error', async () => {
    const deps = {
      ...device(GRANTED),
      lastKnownPosition: () => Promise.reject(new Error('cache unavailable')),
    };

    expect(await reports('first-time', deps)).toEqual([{ kind: 'fix', fix: FIX }]);
  });

  it('reads no position at all without permission, and reports the refusal once', async () => {
    const deps = device(DENIED, { lastKnown: CACHED });
    const currentPosition = vi.spyOn(deps, 'currentPosition');

    expect(await reports('first-time', deps)).toEqual([
      { kind: 'permission_denied', canAskAgain: true },
    ]);
    expect(deps.lastKnownPosition).not.toHaveBeenCalled();
    expect(currentPosition).not.toHaveBeenCalled();
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it('follows the same asking rules as resolveFix', async () => {
    const granted = device(GRANTED, { lastKnown: CACHED });
    await reports('first-time', granted);
    expect(granted.requestPermission).not.toHaveBeenCalled();

    const fresh = device(UNDETERMINED, { answer: 'grant', lastKnown: CACHED });
    await reports('first-time', fresh);
    expect(fresh.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('the booking gate never sees a cached fix', () => {
  it('resolveFix does not read the last-known position', async () => {
    // A cached fix can be minutes old; the gate must decide on a fresh one.
    const deps = device(GRANTED, { lastKnown: CACHED });

    expect(await resolveFix('on-tap', deps)).toEqual({ kind: 'fix', fix: FIX });
    expect(deps.lastKnownPosition).not.toHaveBeenCalled();
  });

  it('only Home uses the quick-then-fresh resolver', async () => {
    const app = fileURLToPath(new URL('../app', import.meta.url));
    const users: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if ((await readFile(full, 'utf8')).includes('getFixQuickThenFresh')) {
          users.push(relative(app, full).split('\\').join('/'));
        }
      }
    };
    await walk(app);
    expect(users).toEqual(['index.tsx']);
  });
});

describe.each([
  [
    'Home: quick then fresh',
    (deps: LocationDeps) => resolveFixQuickThenFresh('first-time', deps, () => undefined),
  ],
  ['book screen on mount: fresh', (deps: LocationDeps) => resolveFix('first-time', deps)],
] as const)('the Android reload loop from the device test — %s', (_name, automaticReload) => {
  const CAP = 100;

  /**
   * Home as the device log shows it. Each permission request pauses and
   * resumes the activity — one "return to the foreground" — and each return
   * reloads the home screen automatically. Runs until nothing is pending, or
   * CAP reloads, which means a loop.
   */
  async function runHome(
    initial: PermissionState,
    load: (deps: LocationDeps) => Promise<unknown>,
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
