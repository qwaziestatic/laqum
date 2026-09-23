import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, type Session, type TokenStore } from '../src/api/client.js';

/**
 * The refresh is the part that breaks in the field, not in the lab: it only
 * misbehaves when several requests are in the air as the token dies. So the
 * tests drive exactly that.
 */

const SESSION: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresAt: '2026-03-01T08:15:00.000Z',
  refreshExpiresAt: '2026-03-31T08:00:00.000Z',
  user: { id: 'u1', phone: '+251911000002', role: 'driver', fullName: 'Dawit' },
};

const REFRESHED: Session = {
  ...SESSION,
  accessToken: 'access-2',
  refreshToken: 'refresh-2',
};

function memoryStore(initial: Session | null = null): TokenStore & { current: Session | null } {
  const store = {
    current: initial,
    read: () => Promise.resolve(store.current),
    write: (session: Session | null) => {
      store.current = session;
      return Promise.resolve();
    },
  };
  return store;
}

/** fetch's first argument can be a Request; read its URL properly. */
function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function json(body: unknown, status = 200, date = 'Sun, 01 Mar 2026 08:00:00 GMT'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', date },
  });
}

let onSignedOut: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onSignedOut = vi.fn<() => void>();
});

function make(fetchImpl: typeof fetch, store = memoryStore(SESSION)) {
  const client = new ApiClient({
    baseUrl: 'http://api.test/v1',
    tokens: store,
    fetch: fetchImpl,
    monotonic: () => 1_000,
    now: () => Date.parse('2026-03-01T08:00:00.000Z'),
    onSignedOut,
  });
  return { client, store };
}

describe('concurrent 401s trigger exactly ONE refresh', () => {
  it('de-duplicates three simultaneous refreshes', async () => {
    let refreshCalls = 0;
    const seen: string[] = [];

    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = hrefOf(url);
      if (href.endsWith('/auth/refresh')) {
        refreshCalls++;
        // A real refresh takes a moment; that window is where the race lives.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(REFRESHED);
      }
      const auth = new Headers(init?.headers).get('authorization');
      seen.push(auth ?? '');
      return auth === 'Bearer access-2'
        ? json({ ok: true })
        : json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401);
    }) as unknown as typeof fetch;

    const { client } = make(fetchImpl);
    await client.restore();

    // Three requests hit 401 at once — the map, the booking, and the lot list.
    const results = await Promise.all([
      client.request('/lots/nearby'),
      client.request('/bookings/active'),
      client.request('/lots/abc'),
    ]);

    /*
     * THE ASSERTION. Refresh tokens rotate, so a second concurrent refresh
     * would present a token the first already consumed, the server would
     * reject it, and the driver would be signed out mid-booking.
     */
    expect(refreshCalls, 'exactly one refresh for three concurrent 401s').toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
    // All three retried with the NEW token.
    expect(seen.filter((a) => a === 'Bearer access-2')).toHaveLength(3);
  });

  it('allows a LATER 401 to refresh again', async () => {
    // The promise de-duplicates concurrent refreshes; it does not cache one.
    let refreshCalls = 0;
    // Starts DIFFERENT from the session's token, so the first request 401s.
    let accessToken = 'access-already-rotated';

    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = hrefOf(url);
      if (href.endsWith('/auth/refresh')) {
        refreshCalls++;
        accessToken = `access-${String(refreshCalls + 1)}`;
        return Promise.resolve(json({ ...REFRESHED, accessToken }));
      }
      const auth = new Headers(init?.headers).get('authorization');
      return Promise.resolve(
        auth === `Bearer ${accessToken}`
          ? json({ ok: true })
          : json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401),
      );
    }) as unknown as typeof fetch;

    const { client } = make(fetchImpl);
    await client.restore();

    await client.request('/first');
    expect(refreshCalls).toBe(1);

    // Force another expiry.
    accessToken = 'access-rotated-again';
    await client.request('/second');
    expect(refreshCalls).toBe(2);
  });
});

describe('when the refresh token is revoked mid-session', () => {
  it('signs out ONCE, clears secure storage, and says why', async () => {
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.endsWith('/auth/refresh')) {
        return Promise.resolve(
          json({ error: { code: 'UNAUTHENTICATED', message: 'revoked' } }, 401),
        );
      }
      return Promise.resolve(json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401));
    }) as unknown as typeof fetch;

    const { client, store } = make(fetchImpl);
    await client.restore();

    const results = await Promise.all([client.request('/a'), client.request('/b')]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    }
    // Cleared, so a restart does not retry a dead token.
    expect(store.current).toBeNull();
    expect(client.session).toBeNull();
    // Told once, not once per in-flight request.
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('does NOT sign out on a network failure during refresh', async () => {
    /*
     * A basement is not a revocation. Clearing tokens here would sign the
     * driver out for driving into a car park — which is precisely when they
     * need the app.
     */
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      if (hrefOf(url).endsWith('/auth/refresh')) {
        return Promise.reject(new Error('Network request failed'));
      }
      return Promise.resolve(json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401));
    }) as unknown as typeof fetch;

    const { client, store } = make(fetchImpl);
    await client.restore();

    const result = await client.request('/a');
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
    expect(store.current, 'tokens survive an unreachable server').not.toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe('the clock is re-synced from every response', () => {
  it('learns the offset from the Date header', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ ok: true }, 200, 'Sun, 01 Mar 2026 08:05:00 GMT')),
    ) as unknown as typeof fetch;

    const { client } = make(fetchImpl);
    expect(client.clock.synced).toBe(false);

    await client.request('/anything');

    expect(client.clock.synced).toBe(true);
    // Device says 08:00, server says 08:05 → the phone is five minutes slow.
    expect(client.clock.offsetMs).toBe(5 * 60_000);
  });

  it('leaves the offset alone when the header is missing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;

    const { client } = make(fetchImpl);
    await client.request('/anything');
    expect(client.clock.synced).toBe(false);
  });
});

describe('ordinary failures', () => {
  it('surfaces a typed error rather than throwing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ error: { code: 'TOO_FAR', message: 'too far' } }, 422)),
    ) as unknown as typeof fetch;

    const { client } = make(fetchImpl);
    const result = await client.request('/bookings');
    expect(result).toMatchObject({ ok: false, error: { code: 'TOO_FAR' } });
  });

  it('does not attempt a refresh when there is no session', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401)),
    ) as unknown as typeof fetch;

    const { client } = make(fetchImpl, memoryStore(null));
    await client.restore();
    await client.request('/anything');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
