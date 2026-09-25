import {
  type CashPaymentInput,
  type CheckInInput,
  type CheckOutResponse,
  type OtpRequestInput,
  type OtpRequestResponse,
  type OtpVerifyInput,
  type RefreshInput,
  type SessionResponse,
  type SlotServiceInput,
  type SlotServiceResponse,
  type StaffBookingResponse,
  type StaffSnapshot,
  type StaffedLotsResponse,
  type WalkInInput,
  checkOutResponseSchema,
  otpRequestResponseSchema,
  sessionResponseSchema,
  slotServiceResponseSchema,
  staffBookingResponseSchema,
  staffSnapshotSchema,
  staffedLotsResponseSchema,
} from '@laqum/shared';

/**
 * The REST client.
 *
 * Every call returns a typed result rather than throwing, because the
 * dashboard has to DO something specific with the failures — a STATE_CONFLICT
 * means refetch and show what really happened, not "something went wrong".
 *
 * SHAPES COME FROM packages/shared, in both directions: request bodies are
 * built as the shared schemas' input types, and every response is parsed with
 * the shared response schema the API's own routes are typed against. The
 * hand-written types this replaced described the check-out bill with fields
 * the API never sent. apps/api/test/dashboard-contract.test.ts drives THIS
 * class against the real API.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type Session = SessionResponse;
export type { CheckOutResponse, StaffBooking, StaffedLot } from '@laqum/shared';

/** Anything with zod's safeParse. */
interface ResponseSchema<T> {
  safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: unknown };
}

/** A failure that never reached the server, shaped like one that did. */
function networkError(err: unknown): ApiError {
  return {
    code: 'NETWORK',
    message: err instanceof Error ? err.message : 'The request could not be sent',
  };
}

async function readBody(res: Response): Promise<ApiResult<unknown>> {
  if (res.status === 204) return { ok: true, data: undefined };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { code: 'BAD_RESPONSE', message: `HTTP ${String(res.status)}` } };
  }

  if (res.ok) return { ok: true, data: body };

  const error = (body as { error?: ApiError }).error;
  return {
    ok: false,
    error: error ?? { code: 'UNKNOWN', message: `HTTP ${String(res.status)}` },
  };
}

/** A response the shared schema does not describe is a BAD_RESPONSE, not a crash later. */
function parsed<T>(result: ApiResult<unknown>, schema: ResponseSchema<T>): ApiResult<T> {
  if (!result.ok) return result;
  const check = schema.safeParse(result.data);
  if (check.success) return { ok: true, data: check.data };
  return {
    ok: false,
    error: {
      code: 'BAD_RESPONSE',
      message: 'The server sent a response this version of the dashboard does not understand.',
      details: check.error,
    },
  };
}

export class ApiClient {
  #session: Session | null = null;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  /**
   * `baseUrl` is '/v1' in the browser, where the dev proxy (or the serving
   * origin) forwards it. Tests pass an absolute URL, and a `fetch` that
   * records what came back raw.
   */
  constructor(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.#base = options.baseUrl ?? '/v1';
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
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

  async request(path: string, init: RequestInit = {}): Promise<ApiResult<unknown>> {
    const headers = new Headers(init.headers);
    if (this.#session) headers.set('Authorization', `Bearer ${this.#session.accessToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, { ...init, headers });
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
        res = await this.#fetch(`${this.#base}${path}`, { ...init, headers });
      } catch (err) {
        return { ok: false, error: networkError(err) };
      }
    }

    return readBody(res);
  }

  #post(path: string, body?: unknown): Promise<ApiResult<unknown>> {
    return this.request(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async refresh(): Promise<ApiResult<Session>> {
    const current = this.#session;
    if (!current) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'No session' } };

    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken } satisfies RefreshInput),
      });
    } catch (err) {
      return { ok: false, error: networkError(err) };
    }

    const result = parsed(await readBody(res), sessionResponseSchema);
    this.#session = result.ok ? result.data : null;
    return result;
  }

  // ── Endpoints ───────────────────────────────────────────────────────────

  /**
   * Staff sign-in, step 1. The STAFF audience: a number that is not staff
   * gets no SMS and the same answer, so the screen must not claim a code was
   * sent — only that one is on its way IF the number is a staff account.
   */
  async requestOtp(phone: string): Promise<ApiResult<OtpRequestResponse>> {
    const body: OtpRequestInput = { phone, audience: 'staff' };
    return parsed(await this.#post('/auth/otp/request', body), otpRequestResponseSchema);
  }

  /** Staff sign-in, step 2. Every failure is one answer in staff mode. */
  async verifyOtp(phone: string, code: string): Promise<ApiResult<Session>> {
    const body: OtpVerifyInput = { phone, code, audience: 'staff' };
    return parsed(await this.#post('/auth/otp/verify', body), sessionResponseSchema);
  }

  /**
   * Whether this API offers dev sign-in. The route exists only with DEV_AUTH,
   * so anything but 204 — a 404, a network error — means no.
   */
  async devLoginAvailable(): Promise<boolean> {
    try {
      return (await this.#fetch(`${this.#base}/auth/dev-login`)).status === 204;
    } catch {
      return false;
    }
  }

  async devLogin(phone: string): Promise<ApiResult<Session>> {
    return parsed(await this.#post('/auth/dev-login', { phone }), sessionResponseSchema);
  }

  async staffedLots(): Promise<ApiResult<StaffedLotsResponse>> {
    return parsed(await this.request('/staff/lots'), staffedLotsResponseSchema);
  }

  /** The snapshot, carrying the lot version its rows were read at. */
  async lotSlots(lotId: string): Promise<ApiResult<StaffSnapshot>> {
    return parsed(await this.request(`/staff/lots/${lotId}/slots`), staffSnapshotSchema);
  }

  /** `vehiclePlate` must be ABSENT when blank: the schema rejects "". */
  async parkWalkIn(lotId: string, input: WalkInInput): Promise<ApiResult<StaffBookingResponse>> {
    return parsed(
      await this.#post(`/staff/lots/${lotId}/walk-ins`, input),
      staffBookingResponseSchema,
    );
  }

  async checkIn(code: string): Promise<ApiResult<StaffBookingResponse>> {
    const body: CheckInInput = { code };
    return parsed(await this.#post('/staff/check-in', body), staffBookingResponseSchema);
  }

  async checkOut(bookingId: string): Promise<ApiResult<CheckOutResponse>> {
    return parsed(
      await this.#post(`/staff/bookings/${bookingId}/check-out`),
      checkOutResponseSchema,
    );
  }

  async recordCash(
    bookingId: string,
    amountSantim: number,
    overridePending = false,
  ): Promise<ApiResult<StaffBookingResponse>> {
    const body: CashPaymentInput = { amountSantim, overridePending };
    return parsed(
      await this.#post(`/staff/bookings/${bookingId}/cash`, body),
      staffBookingResponseSchema,
    );
  }

  async setSlotService(
    slotId: string,
    inService: boolean,
  ): Promise<ApiResult<SlotServiceResponse>> {
    const body: SlotServiceInput = { inService };
    return parsed(
      await this.request(`/staff/slots/${slotId}`, { method: 'PATCH', body: JSON.stringify(body) }),
      slotServiceResponseSchema,
    );
  }
}
