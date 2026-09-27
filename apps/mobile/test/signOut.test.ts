import { describe, expect, it, vi } from 'vitest';
import { signOut, type SignOutDeps } from '../src/state/signOut.js';

function deps(overrides: Partial<SignOutDeps> = {}) {
  const order: string[] = [];
  const logout = vi.fn(() => {
    order.push('logout');
    return Promise.resolve();
  });
  const clearSession = vi.fn(() => {
    order.push('clear');
    return Promise.resolve();
  });
  return {
    order,
    logout,
    clearSession,
    deps: {
      refreshToken: 'refresh-1',
      pushToken: () => Promise.resolve('ExponentPushToken[this-phone]'),
      logout,
      clearSession,
      ...overrides,
    } satisfies SignOutDeps,
  };
}

describe('Sign out', () => {
  it("tells the server first, with this phone's push token, then forgets the session", async () => {
    const d = deps();
    await signOut(d.deps);
    expect(d.logout).toHaveBeenCalledWith({
      refreshToken: 'refresh-1',
      expoPushToken: 'ExponentPushToken[this-phone]',
    });
    expect(d.order).toEqual(['logout', 'clear']);
  });

  it('still ends the session when the phone has no push token', async () => {
    const d = deps({ pushToken: () => Promise.resolve(null) });
    await signOut(d.deps);
    expect(d.logout).toHaveBeenCalledWith({ refreshToken: 'refresh-1' });
    expect(d.clearSession).toHaveBeenCalledOnce();
  });

  it('signs out HERE even when the server cannot be reached', async () => {
    const offline = deps({ logout: () => Promise.reject(new Error('Network request failed')) });
    await signOut(offline.deps);
    expect(offline.clearSession).toHaveBeenCalledOnce();

    const noToken = deps({ pushToken: () => Promise.reject(new Error('no Firebase')) });
    await signOut(noToken.deps);
    expect(noToken.logout).toHaveBeenCalledWith({ refreshToken: 'refresh-1' });
    expect(noToken.clearSession).toHaveBeenCalledOnce();
  });

  it('with no session, only clears', async () => {
    const d = deps({ refreshToken: null });
    await signOut(d.deps);
    expect(d.logout).not.toHaveBeenCalled();
    expect(d.clearSession).toHaveBeenCalledOnce();
  });
});
