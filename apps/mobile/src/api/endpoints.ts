import {
  type BookingResponse,
  type CancelBookingResponse,
  type CreateBookingInput,
  type CreateBookingResponse,
  type CurrentBookingResponse,
  type ExtendBookingInput,
  type ExtendBookingResponse,
  type LotSummary,
  type NearbyLotsResponse,
  type OtpRequestInput,
  type OtpRequestResponse,
  type OtpVerifyInput,
  type PayBookingResponse,
  type PayDepositResponse,
  type PublicSnapshot,
  type RegisterPushTokenInput,
  bookingResponseSchema,
  cancelBookingResponseSchema,
  createBookingResponseSchema,
  currentBookingResponseSchema,
  extendBookingResponseSchema,
  lotSummarySchema,
  nearbyLotsResponseSchema,
  otpRequestResponseSchema,
  payBookingResponseSchema,
  payDepositResponseSchema,
  publicSnapshotSchema,
  sessionResponseSchema,
} from '@laqum/shared';
import type { ApiClient, ApiResult, Session } from './client.js';

/**
 * The driver-facing API surface, typed.
 *
 * Every path here exists in apps/api; see apps/api/src/app.ts for the mounts.
 * Kept in one file so the app's whole dependency on the server is visible at
 * a glance rather than scattered through screens.
 */

export type { Booking as DriverBooking, LotSummary, NearbyLot } from '@laqum/shared';

/** Anything with zod's safeParse. Structural, so this app need not depend on zod. */
interface ResponseSchema<T> {
  safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: unknown };
}

/**
 * Checks a response against the SHARED schema the API's own types come from.
 *
 * A mismatch becomes an ordinary error result the screen can show, rather
 * than a field that reads undefined somewhere deep in a render — which is how
 * the device test's Book-screen crash surfaced. apps/api/test/lots.test.ts
 * parses the API's REAL responses with the same schemas.
 */
export function parsed<T>(result: ApiResult<unknown>, schema: ResponseSchema<T>): ApiResult<T> {
  if (!result.ok) return result;
  const check = schema.safeParse(result.data);
  if (check.success) return { ok: true, data: check.data };
  return {
    ok: false,
    error: {
      code: 'BAD_RESPONSE',
      message: 'The server sent a response this version of the app does not understand.',
      details: check.error,
    },
  };
}

/**
 * Every request body is built as the SHARED schema's input type, and every
 * response is parsed with the shared response schema. The device test found
 * both directions broken by hand-written shapes: the Book screen crashed on a
 * response, then "Hold this slot" sent latitude/longitude where the API wants
 * lat/lng. apps/api/test/mobile-contract.test.ts drives THIS class against the
 * real API, so a mismatch on either side fails in CI.
 */
export class Api {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  #post(path: string, body?: unknown): Promise<ApiResult<unknown>> {
    return this.#client.request<unknown>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async requestOtp(input: OtpRequestInput): Promise<ApiResult<OtpRequestResponse>> {
    return parsed(await this.#post('/auth/otp/request', input), otpRequestResponseSchema);
  }

  async verifyOtp(input: OtpVerifyInput): Promise<ApiResult<Session>> {
    return parsed(await this.#post('/auth/otp/verify', input), sessionResponseSchema);
  }

  async nearbyLots(
    lat: number,
    lng: number,
    radiusM = 5000,
  ): Promise<ApiResult<NearbyLotsResponse>> {
    const query = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      radius_m: String(radiusM),
    });
    return parsed(
      await this.#client.request<unknown>(`/lots/nearby?${query.toString()}`),
      nearbyLotsResponseSchema,
    );
  }

  /** A LotSummary: unlike the nearby list, no distanceM or withinBookingRange. */
  async lot(id: string): Promise<ApiResult<LotSummary>> {
    return parsed(await this.#client.request<unknown>(`/lots/${id}`), lotSummarySchema);
  }

  async lotLayout(id: string): Promise<ApiResult<PublicSnapshot>> {
    return parsed(await this.#client.request<unknown>(`/lots/${id}/layout`), publicSnapshotSchema);
  }

  /** `vehiclePlate` must be ABSENT when blank: the schema rejects "". */
  async createBooking(input: CreateBookingInput): Promise<ApiResult<CreateBookingResponse>> {
    return parsed(await this.#post('/bookings', input), createBookingResponseSchema);
  }

  async currentBooking(): Promise<ApiResult<CurrentBookingResponse>> {
    return parsed(
      await this.#client.request<unknown>('/bookings/current'),
      currentBookingResponseSchema,
    );
  }

  async booking(id: string): Promise<ApiResult<BookingResponse>> {
    return parsed(await this.#client.request<unknown>(`/bookings/${id}`), bookingResponseSchema);
  }

  async cancel(id: string): Promise<ApiResult<CancelBookingResponse>> {
    return parsed(await this.#post(`/bookings/${id}/cancel`), cancelBookingResponseSchema);
  }

  /** BLOCKS, not minutes: the API multiplies by the lot's block length. */
  async extend(id: string, input: ExtendBookingInput): Promise<ApiResult<ExtendBookingResponse>> {
    return parsed(await this.#post(`/bookings/${id}/extend`, input), extendBookingResponseSchema);
  }

  async pay(id: string): Promise<ApiResult<PayBookingResponse>> {
    return parsed(await this.#post(`/bookings/${id}/pay`), payBookingResponseSchema);
  }

  /** Reopen the payable deposit checkout, or start one: also the retry. */
  async payDeposit(id: string): Promise<ApiResult<PayDepositResponse>> {
    return parsed(await this.#post(`/bookings/${id}/deposit`), payDepositResponseSchema);
  }

  /** Ask the provider now, on return from the checkout. Never starts a payment. */
  async verifyDeposit(id: string): Promise<ApiResult<BookingResponse>> {
    return parsed(await this.#post(`/bookings/${id}/deposit/verify`), bookingResponseSchema);
  }

  /** Answered 204 with no body. */
  registerPushToken(input: RegisterPushTokenInput): Promise<ApiResult<void>> {
    return this.#client.request('/push/tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}
