import { type Mock, describe, expect, it, vi } from 'vitest';
import { BOOKING_STATUSES } from '@laqum/shared';
import {
  TOKEN_RETRY_DELAYS_MS,
  bookingEarnsPushAsk,
  maybeRegisterForPush,
  type PushDeps,
} from '../src/push/registration.js';

/**
 * The timing of the ask is the whole design, so it is what gets tested.
 */

function deps(overrides: Partial<PushDeps> = {}): PushDeps & {
  requestPermissions: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const requestPermissions = vi.fn().mockResolvedValue('granted');
  const upload = vi.fn().mockResolvedValue(undefined);
  // Resolves at once: the retry is tested by what it waits for, not by waiting.
  const sleep = vi.fn().mockResolvedValue(undefined);
  return {
    getPermissions: () => Promise.resolve('undetermined'),
    getToken: () => Promise.resolve('ExponentPushToken[abc]'),
    hasBooked: () => Promise.resolve(true),
    requestPermissions,
    upload,
    sleep,
    ...overrides,
  } as PushDeps & {
    requestPermissions: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
  };
}

/** A token that comes only on the given attempt (1-based), null before it. */
function tokenOnAttempt(n: number): Mock<() => Promise<string | null>> {
  let attempt = 0;
  return vi.fn<() => Promise<string | null>>(() => {
    attempt += 1;
    return Promise.resolve(attempt >= n ? 'ExponentPushToken[late]' : null);
  });
}

describe('the ask waits for the first booking', () => {
  it('does NOT prompt before the driver has booked', async () => {
    /*
     * A prompt at launch, before the value is obvious, is the reliable way to
     * get a permanent no — and a denied notification permission cannot be
     * re-requested in-app on either platform.
     */
    const d = deps({ hasBooked: () => Promise.resolve(false) });
    const result = await maybeRegisterForPush(d);

    expect(result).toEqual({ kind: 'too_early' });
    expect(d.requestPermissions).not.toHaveBeenCalled();
  });

  it('prompts once the driver HAS booked', async () => {
    const d = deps({ hasBooked: () => Promise.resolve(true) });
    const result = await maybeRegisterForPush(d);

    expect(d.requestPermissions).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'registered' });
    expect(d.upload).toHaveBeenCalledWith('ExponentPushToken[abc]');
  });
});

describe('already-decided permissions', () => {
  it('refreshes the token silently when already granted, without prompting', async () => {
    // Push tokens rotate, so this is not a no-op — but it must not re-prompt.
    const d = deps({ getPermissions: () => Promise.resolve('granted') });
    const result = await maybeRegisterForPush(d);

    expect(d.requestPermissions).not.toHaveBeenCalled();
    expect(d.upload).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: 'registered' });
  });

  it('registers even before a booking when permission already exists', async () => {
    // The gate protects the PROMPT, not the registration. If the driver has
    // already said yes, there is nothing to protect them from.
    const d = deps({
      getPermissions: () => Promise.resolve('granted'),
      hasBooked: () => Promise.resolve(false),
    });
    expect(await maybeRegisterForPush(d)).toMatchObject({ kind: 'registered' });
  });

  it('does not re-ask after a denial', async () => {
    const d = deps({ getPermissions: () => Promise.resolve('denied') });
    const result = await maybeRegisterForPush(d);

    expect(result).toEqual({ kind: 'denied' });
    expect(d.requestPermissions).not.toHaveBeenCalled();
  });
});

describe('failure is normal, not an error', () => {
  it('reports a refusal at the prompt without uploading', async () => {
    const d = deps({ requestPermissions: vi.fn().mockResolvedValue('denied') });
    expect(await maybeRegisterForPush(d)).toEqual({ kind: 'denied' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('reports unavailable when no token comes back, after the retries', async () => {
    // Happens on an emulator without Play Services, and in Expo Go.
    const d = deps({ getToken: () => Promise.resolve(null) });
    expect(await maybeRegisterForPush(d)).toEqual({ kind: 'unavailable' });
    expect(d.upload).not.toHaveBeenCalled();
  });
});

describe('a token that does not come at once (Session 3)', () => {
  /*
   * On the phone the first token fetch after the grant failed, nothing
   * retried, and the first booking's notice was lost.
   */
  it('is retried after the grant, and uploaded when it comes', async () => {
    const getToken = tokenOnAttempt(2);
    const d = deps({ getToken });
    const result = await maybeRegisterForPush(d);

    expect(result).toEqual({ kind: 'registered', token: 'ExponentPushToken[late]' });
    expect(d.upload).toHaveBeenCalledWith('ExponentPushToken[late]');
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(d.sleep.mock.calls).toEqual([[TOKEN_RETRY_DELAYS_MS[0]]]);
  });

  it('is retried on the silent path too, when permission was already granted', async () => {
    const d = deps({
      getPermissions: () => Promise.resolve('granted'),
      getToken: tokenOnAttempt(3),
    });
    expect(await maybeRegisterForPush(d)).toMatchObject({ kind: 'registered' });
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last delay, with increasing waits, and uploads nothing', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const d = deps({ getToken });
    expect(await maybeRegisterForPush(d)).toEqual({ kind: 'unavailable' });

    const waits = d.sleep.mock.calls.map(([ms]) => ms as number);
    expect(waits).toEqual([...TOKEN_RETRY_DELAYS_MS]);
    expect(waits.every((ms, i) => i === 0 || ms > (waits[i - 1] ?? 0))).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(TOKEN_RETRY_DELAYS_MS.length + 1);
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('NEVER prompts again while retrying', async () => {
    const d = deps({ getToken: vi.fn().mockResolvedValue(null) });
    await maybeRegisterForPush(d);
    // Once, for the ask itself; never for a retry.
    expect(d.requestPermissions).toHaveBeenCalledTimes(1);

    const alreadyGranted = deps({
      getPermissions: () => Promise.resolve('granted'),
      getToken: vi.fn().mockResolvedValue(null),
    });
    await maybeRegisterForPush(alreadyGranted);
    expect(alreadyGranted.requestPermissions).not.toHaveBeenCalled();
  });
});

describe('the foreground re-registration (usePush: hasBooked false)', () => {
  it('only CHECKS the permission, whatever it is: never a request', async () => {
    // On Android a request launches an activity, which is itself a return to
    // the foreground: requesting here would loop (CLAUDE.md).
    for (const status of ['granted', 'denied', 'undetermined'] as const) {
      const d = deps({
        getPermissions: () => Promise.resolve(status),
        hasBooked: () => Promise.resolve(false),
      });
      await maybeRegisterForPush(d);
      expect(d.requestPermissions, status).not.toHaveBeenCalled();
      expect(d.upload, status).toHaveBeenCalledTimes(status === 'granted' ? 1 : 0);
    }
  });
});

describe('which booking earns the ask', () => {
  it('asks only while the driver holds a slot on a timer', () => {
    expect(BOOKING_STATUSES.filter(bookingEarnsPushAsk)).toEqual([
      'RESERVED',
      'CHECKED_IN',
      'OVERSTAY',
    ]);
  });

  it('never while paying the deposit: the checkout is open over the app', () => {
    expect(bookingEarnsPushAsk('PENDING_PAYMENT')).toBe(false);
  });

  it('never for a booking that is over, as the constant true used to', () => {
    for (const status of ['EXPIRED', 'CANCELLED', 'CHECKED_OUT', 'PAID'] as const) {
      expect(bookingEarnsPushAsk(status), status).toBe(false);
    }
  });
});
