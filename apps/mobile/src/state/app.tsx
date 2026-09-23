import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { ApiClient, type Session } from '../api/client.js';
import { Api } from '../api/endpoints.js';
import { secureTokenStore } from '../api/secureTokens.js';

/**
 * One ApiClient for the whole app, so the single-flight refresh actually is
 * single-flight. A client per screen would defeat the entire mechanism — each
 * would hold its own `#refreshing` and they would race exactly as if there
 * were no de-duplication at all.
 */

/**
 * Where the API lives.
 *
 * `EXPO_PUBLIC_API_URL` is read at build time by Expo. On a physical device
 * this must be the dev machine's LAN address — `localhost` is the PHONE, not
 * the laptop, which is the single most common reason a device build appears
 * to be "offline". See docs/DEVICE-TEST.md.
 */
const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:3000/v1';

export interface AppContextValue {
  api: Api;
  client: ApiClient;
  session: Session | null;
  signedOutReason: string | null;
  setSession: (session: Session | null) => Promise<void>;
  ready: boolean;
  /** Increments whenever the app returns to the foreground. */
  foregroundEpoch: number;
  apiUrl: string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const [foregroundEpoch, setForegroundEpoch] = useState(0);

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_URL,
        tokens: secureTokenStore,
        fetch: (...args) => fetch(...args),
        monotonic: () => performance.now(),
        now: () => Date.now(),
        onSignedOut: () => {
          setSessionState(null);
          setSignedOutReason('Your session has ended. Sign in again.');
        },
      }),
    [],
  );

  const api = useMemo(() => new Api(client), [client]);

  // Restore a persisted session before the first render decides where to go.
  useEffect(() => {
    void client.restore().then((restored) => {
      setSessionState(restored);
      setReady(true);
    });
  }, [client]);

  /*
   * FOREGROUND IS A RESYNC TRIGGER, not just a lifecycle event.
   *
   * Timers do not fire reliably in the background, so anything counting down
   * is stale on resume — and the server may have expired the booking while
   * the app slept. Screens watch `foregroundEpoch` and REFETCH rather than
   * extrapolating from the last value they held.
   */
  useEffect(() => {
    const onChange = (next: AppStateStatus): void => {
      if (next === 'active') setForegroundEpoch((epoch) => epoch + 1);
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => {
      subscription.remove();
    };
  }, []);

  const setSession = useCallback(
    async (next: Session | null) => {
      await client.setSession(next);
      setSessionState(next);
      if (next) setSignedOutReason(null);
    },
    [client],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      api,
      client,
      session,
      signedOutReason,
      setSession,
      ready,
      foregroundEpoch,
      apiUrl: API_URL,
    }),
    [api, client, session, signedOutReason, setSession, ready, foregroundEpoch],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}
