import { describe, expect, it, vi } from 'vitest';
import { maybeRegisterForPush, type PushDeps } from '../src/push/registration.js';

/**
 * The timing of the ask is the whole design, so it is what gets tested.
 */

function deps(overrides: Partial<PushDeps> = {}): PushDeps & {
  requestPermissions: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
} {
  const requestPermissions = vi.fn().mockResolvedValue('granted');
  const upload = vi.fn().mockResolvedValue(undefined);
  return {
    getPermissions: () => Promise.resolve('undetermined'),
    getToken: () => Promise.resolve('ExponentPushToken[abc]'),
    hasBooked: () => Promise.resolve(true),
    requestPermissions,
    upload,
    ...overrides,
  } as PushDeps & {
    requestPermissions: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  };
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

  it('reports unavailable when no token comes back', async () => {
    // Happens on an emulator without Play Services, and in Expo Go.
    const d = deps({ getToken: () => Promise.resolve(null) });
    expect(await maybeRegisterForPush(d)).toEqual({ kind: 'unavailable' });
    expect(d.upload).not.toHaveBeenCalled();
  });
});
