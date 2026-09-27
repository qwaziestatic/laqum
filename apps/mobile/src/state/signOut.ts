import type { LogoutInput } from '@laqum/shared';

/**
 * Sign out: end the session on the server, stop this phone's notifications,
 * forget the tokens here.
 *
 * The server is told FIRST, while the refresh token still exists, in one
 * request: logout revokes the session and deletes this device's push token
 * (only if it is this user's). The local session is cleared WHATEVER
 * happens: a driver who taps Sign out offline is signed out on this phone.
 * The server then still holds the session until it expires, and the token
 * until the next sign-in on this phone re-points it.
 */
export interface SignOutDeps {
  refreshToken: string | null;
  /** This device's push token, only if notifications are already allowed. Never prompts. */
  pushToken: () => Promise<string | null>;
  logout: (input: LogoutInput) => Promise<unknown>;
  clearSession: () => Promise<void>;
}

export async function signOut(deps: SignOutDeps): Promise<void> {
  try {
    if (deps.refreshToken) {
      const expoPushToken = await deps.pushToken().catch(() => null);
      await deps.logout({
        refreshToken: deps.refreshToken,
        ...(expoPushToken ? { expoPushToken } : {}),
      });
    }
  } catch {
    // Offline or refused: still signed out here.
  } finally {
    await deps.clearSession();
  }
}
