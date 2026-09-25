import type { OtpRequestInput, OtpVerifyInput, StaffSnapshot } from '@laqum/shared';

/**
 * The REST client.
 *
 * Every call returns a typed result rather than throwing, because the
 * dashboard has to DO something specific with the failures — a STATE_CONFLICT
 * means refetch and show what really happened, not "something went wrong".
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
  user: { id: string; phone: string; role: string; fullName: string | null };
}

/** A failure that never reached the server, shaped like one that did. */
function networkError(err: unknown): ApiError {
  return {
    code: 'NETWORK',
    message: err instanceof Error ? err.message : 'The request could not be sent',
  };
}

async function parse<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, data: undefined as T };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { code: 'BAD_RESPONSE', message: `HTTP ${String(res.status)}` } };
  }

  if (res.ok) return { ok: true, data: body as T };

  const error = (body as { error?: ApiError }).error;
  return {
    ok: false,
    error: error ?? { code: 'UNKNOWN', message: `HTTP ${String(res.status)}` },
  };
}

export class ApiClient {
  #session: Session | null = null;
  readonly #base: string;

  /**
   * `baseUrl` is '/v1' in the browser, where the dev proxy (or the serving
   * origin) forwards it. Tests pass an absolute URL: the API's contract test
   * drives THIS client against the real API.
   */
  constructor(options: { baseUrl?: string } = {}) {
    this.#base = options.baseUrl ?? '/v1';
  }

  get session(): Session | null {
    return this.#session;
  }

  setSession(session: Session | null): void {
    this.#session = session;
  }

  get token(): string | null {
    return this.#session?.accessToken ?? null;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const headers = new Headers(init.headers);
    if (this.#session) headers.set('Authorization', `Bearer ${this.#session.accessToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, { ...init, headers });
    } catch (err) {
      return { ok: false, error: networkError(err) };
    }

    /*
     * A 401 means the access token died mid-session. Refresh ONCE and retry.
     *
     * Once, not in a loop: if the refresh itself is rejected the session is
     * genuinely over, and retrying would spin. The socket handles its own
     * expiry separately (it is disconnected by the server at exp), so both
     * halves recover from the same underlying cause independently.
     */
    if (res.status === 401 && this.#session) {
      const refreshed = await this.refresh();
      if (!refreshed.ok) return { ok: false, error: refreshed.error };

      headers.set('Authorization', `Bearer ${refreshed.data.accessToken}`);
      try {
        res = await fetch(`${this.#base}${path}`, { ...init, headers });
      } catch (err) {
        return { ok: false, error: networkError(err) };
      }
    }

    return parse<T>(res);
  }

  async refresh(): Promise<ApiResult<Session>> {
    const current = this.#session;
    if (!current) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'No session' } };

    let res: Response;
    try {
      res = await fetch(`${this.#base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch (err) {
      return { ok: false, error: networkError(err) };
    }

    const result = await parse<Session>(res);
    if (result.ok) this.#session = result.data;
    else this.#session = null;
    return result;
  }

  // ── Endpoints ───────────────────────────────────────────────────────────

  /**
   * Staff sign-in, step 1. The STAFF audience: a number that is not staff
   * gets no SMS and the same answer, so the screen must not claim a code was
   * sent — only that one is on its way IF the number is a staff account.
   */
  requestOtp(phone: string): Promise<ApiResult<{ expiresAt: string }>> {
    const body: OtpRequestInput = { phone, audience: 'staff' };
    return this.request('/auth/otp/request', { method: 'POST', body: JSON.stringify(body) });
  }

  /** Staff sign-in, step 2. Every failure is one answer in staff mode. */
  verifyOtp(phone: string, code: string): Promise<ApiResult<Session>> {
    const body: OtpVerifyInput = { phone, code, audience: 'staff' };
    return this.request<Session>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Whether this API offers dev sign-in. The route exists only with DEV_AUTH,
   * so anything but 204 — a 404, a network error — means no.
   */
  async devLoginAvailable(): Promise<boolean> {
    try {
      return (await fetch(`${this.#base}/auth/dev-login`)).status === 204;
    } catch {
      return false;
    }
  }

  devLogin(phone: string): Promise<ApiResult<Session>> {
    return this.request<Session>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  }

  staffedLots(): Promise<ApiResult<{ lots: StaffedLot[] }>> {
    return this.request('/staff/lots');
  }

  /** The snapshot, carrying the lot version its rows were read at. */
  lotSlots(lotId: string): Promise<ApiResult<StaffSnapshot>> {
    return this.request(`/staff/lots/${lotId}/slots`);
  }

  parkWalkIn(
    lotId: string,
    input: { slotId: string; vehiclePlate?: string },
  ): Promise<ApiResult<unknown>> {
    return this.request(`/staff/lots/${lotId}/walk-ins`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  checkIn(code: string): Promise<ApiResult<{ booking: StaffBooking }>> {
    return this.request('/staff/check-in', { method: 'POST', body: JSON.stringify({ code }) });
  }

  checkOut(bookingId: string): Promise<ApiResult<CheckOutResponse>> {
    return this.request(`/staff/bookings/${bookingId}/check-out`, { method: 'POST' });
  }

  recordCash(
    bookingId: string,
    amountSantim: number,
    overridePending = false,
  ): Promise<ApiResult<{ booking: StaffBooking }>> {
    return this.request(`/staff/bookings/${bookingId}/cash`, {
      method: 'POST',
      body: JSON.stringify({ amountSantim, overridePending }),
    });
  }

  setSlotService(slotId: string, inService: boolean): Promise<ApiResult<unknown>> {
    return this.request(`/staff/slots/${slotId}`, {
      method: 'PATCH',
      body: JSON.stringify({ inService }),
    });
  }
}

export interface StaffedLot {
  id: string;
  name: string;
  address: string | null;
  block_minutes: number;
  rate_per_block_santim: number;
  overstay_rate_per_block_santim: number;
  deposit_amount_santim: number;
}

export interface StaffBooking {
  id: string;
  status: string;
  slotId: string;
  vehiclePlate: string | null;
  shortCode: string | null;
  amountDueSantim: number | null;
}

export interface CheckOutResponse {
  booking: StaffBooking;
  bill: {
    amountDueSantim: number;
    blocks: number;
    overstayBlocks: number;
    depositAppliedSantim: number;
  };
  settled: boolean;
}
