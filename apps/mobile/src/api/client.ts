import { ServerClock, parseDateHeader } from '../time/serverClock.js';

/**
 * The driver app's API client.
 *
 * TWO things here are worth reading before changing anything:
 *
 * 1. SINGLE-FLIGHT REFRESH. When the access token expires, several requests
 *    are usually in the air at once — the map is polling lots while the
 *    booking screen fetches its own state. Each gets a 401. If each refreshed
 *    independently, they would race: refresh tokens ROTATE, so the second
 *    refresh presents a token the first has already consumed, the server
 *    rejects it, and the driver is signed out mid-booking for no reason.
 *    So at most one refresh is ever in flight; the others await the same
 *    promise.
 *
 * 2. EVERY RESPONSE RE-SYNCS THE CLOCK, from the `Date` header the response
 *    already carries. Countdowns run on server time (see serverClock.ts), and
 *    this is what keeps that estimate fresh without a dedicated endpoint.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface Session {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  user: { id: string; phone: string; role: string; fullName: string | null };
}

/** Where the tokens live. expo-secure-store in the app; a map in tests. */
export interface TokenStore {
  read: () => Promise<Session | null>;
  write: (session: Session | null) => Promise<void>;
}

/** Injected so tests need neither a network nor a device. */
export interface ClientDeps {
  baseUrl: string;
  tokens: TokenStore;
  fetch: typeof fetch;
  /** Monotonic milliseconds; `performance.now` in the app. */
  monotonic: () => number;
  /** Wall clock; `Date.now` in the app. */
  now: () => number;
  /** Called when the session ends for good, so the UI can return to login. */
  onSignedOut: () => void;
}

export class ApiClient {
  readonly clock = new ServerClock();
  readonly #deps: ClientDeps;
  #session: Session | null = null;

  /**
   * The in-flight refresh, if any.
   *
   * THIS FIELD IS THE WHOLE MECHANISM. Non-null means a refresh is running and
   * every other 401 must await it rather than starting its own.
   */
  #refreshing: Promise<ApiResult<Session>> | null = null;

  constructor(deps: ClientDeps) {
    this.#deps = deps;
  }

  get session(): Session | null {
    return this.#session;
  }

  /** Load a persisted session at startup. */
  async restore(): Promise<Session | null> {
    this.#session = await this.#deps.tokens.read();
    return this.#session;
  }

  async setSession(session: Session | null): Promise<void> {
    this.#session = session;
    await this.#deps.tokens.write(session);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const first = await this.#send<T>(path, init);
    if (first.status !== 401 || !this.#session) return first.result;

    // One shared refresh, however many requests land here at once.
    const refreshed = await this.#refreshOnce();
    if (!refreshed.ok) return { ok: false, error: refreshed.error };

    const retried = await this.#send<T>(path, init);
    return retried.result;
  }

  async #send<T>(
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; result: ApiResult<T> }> {
    const headers = new Headers(init.headers);
    if (this.#session) headers.set('Authorization', `Bearer ${this.#session.accessToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await this.#deps.fetch(`${this.#deps.baseUrl}${path}`, { ...init, headers });
    } catch (err) {
      return {
        status: 0,
        result: {
          ok: false,
          error: {
            code: 'NETWORK',
            message: err instanceof Error ? err.message : 'The request could not be sent',
          },
        },
      };
    }

    this.#sampleClock(response);

    if (response.status === 204) {
      return { status: 204, result: { ok: true, data: undefined as T } };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: response.status,
        result: {
          ok: false,
          error: { code: 'BAD_RESPONSE', message: `HTTP ${String(response.status)}` },
        },
      };
    }

    if (response.ok) return { status: response.status, result: { ok: true, data: body as T } };

    const error = (body as { error?: ApiError }).error;
    return {
      status: response.status,
      result: {
        ok: false,
        error: error ?? { code: 'UNKNOWN', message: `HTTP ${String(response.status)}` },
      },
    };
  }

  /** Learn the server/device offset from the response's own `Date` header. */
  #sampleClock(response: Response): void {
    const serverMs = parseDateHeader(response.headers.get('date'));
    if (serverMs === null) return;
    this.clock.sample({
      serverMs,
      deviceMs: this.#deps.now(),
      monotonicMs: this.#deps.monotonic(),
    });
  }

  /**
   * Refresh, but only ever once at a time.
   *
   * The promise is stored BEFORE it is awaited, so a caller arriving one tick
   * later sees it and joins. Cleared in `finally` so a later 401 can refresh
   * again — this de-duplicates concurrent refreshes, it does not cache one.
   */
  #refreshOnce(): Promise<ApiResult<Session>> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<ApiResult<Session>> {
    const current = this.#session;
    if (!current) {
      return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'No session' } };
    }

    let response: Response;
    try {
      response = await this.#deps.fetch(`${this.#deps.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch (err) {
      // A NETWORK failure is not a revoked session. Keep the tokens: the
      // driver is in a basement, not signed out.
      return {
        ok: false,
        error: {
          code: 'NETWORK',
          message: err instanceof Error ? err.message : 'Could not reach the server',
        },
      };
    }

    this.#sampleClock(response);

    if (response.ok) {
      const session = (await response.json()) as Session;
      await this.setSession(session);
      return { ok: true, data: session };
    }

    /*
     * THE REFRESH TOKEN IS GONE — revoked, rotated away, or expired.
     *
     * This is the only path that signs the driver out, and it is deliberate:
     * the session genuinely cannot continue. Tokens are cleared from secure
     * storage so a restart does not retry them, and the UI is told once.
     */
    await this.setSession(null);
    this.#deps.onSignedOut();
    return {
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Your session has ended. Sign in again.' },
    };
  }
}
