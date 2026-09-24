import {
  type LotSummary,
  type NearbyLotsResponse,
  lotSummarySchema,
  nearbyLotsResponseSchema,
} from '@laqum/shared';
import type { ApiClient, ApiResult, Session } from './client.js';

/**
 * The driver-facing API surface, typed.
 *
 * Every path here exists in apps/api; see apps/api/src/app.ts for the mounts.
 * Kept in one file so the app's whole dependency on the server is visible at
 * a glance rather than scattered through screens.
 */

export type { LotSummary, NearbyLot } from '@laqum/shared';

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

export interface DriverBooking {
  id: string;
  lotId: string;
  slotId: string;
  slotLabel?: string | null;
  status: string;
  vehiclePlate: string | null;
  shortCode: string | null;
  qrToken: string | null;
  plannedMinutes: number | null;
  holdExpiresAt: string | null;
  plannedEndAt: string | null;
  checkedInAt: string | null;
  amountDueSantim: number | null;
}

export interface PublicSlot {
  slotId: string;
  label: string;
  zone: string;
  gridRow: number;
  gridCol: number;
  appBookable: boolean;
  inService: boolean;
  displayStatus: string;
}

export class Api {
  readonly #client: ApiClient;

  constructor(client: ApiClient) {
    this.#client = client;
  }

  requestOtp(phone: string): Promise<ApiResult<{ expiresAt: string }>> {
    return this.#client.request('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  }

  verifyOtp(phone: string, code: string): Promise<ApiResult<Session>> {
    return this.#client.request('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
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

  lotLayout(
    id: string,
  ): Promise<ApiResult<{ lotId: string; lotVersion: number; slots: PublicSlot[] }>> {
    return this.#client.request(`/lots/${id}/layout`);
  }

  createBooking(input: {
    lotId: string;
    plannedMinutes: number;
    latitude: number;
    longitude: number;
    vehiclePlate?: string;
  }): Promise<
    ApiResult<{ booking: DriverBooking; paymentRequired: boolean; checkoutUrl?: string }>
  > {
    return this.#client.request('/bookings', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  currentBooking(): Promise<ApiResult<{ booking: DriverBooking | null }>> {
    return this.#client.request('/bookings/current');
  }

  booking(id: string): Promise<ApiResult<{ booking: DriverBooking }>> {
    return this.#client.request(`/bookings/${id}`);
  }

  cancel(id: string): Promise<ApiResult<{ booking: DriverBooking }>> {
    return this.#client.request(`/bookings/${id}/cancel`, { method: 'POST' });
  }

  extend(id: string, additionalMinutes: number): Promise<ApiResult<{ booking: DriverBooking }>> {
    return this.#client.request(`/bookings/${id}/extend`, {
      method: 'POST',
      body: JSON.stringify({ additionalMinutes }),
    });
  }

  pay(id: string): Promise<ApiResult<{ checkoutUrl: string }>> {
    return this.#client.request(`/bookings/${id}/pay`, { method: 'POST' });
  }

  registerPushToken(expoPushToken: string): Promise<ApiResult<void>> {
    return this.#client.request('/push/tokens', {
      method: 'POST',
      body: JSON.stringify({ expoPushToken }),
    });
  }
}
