import type { ApiClient, ApiResult, Session } from './client.js';

/**
 * The driver-facing API surface, typed.
 *
 * Every path here exists in apps/api; see apps/api/src/app.ts for the mounts.
 * Kept in one file so the app's whole dependency on the server is visible at
 * a glance rather than scattered through screens.
 */

export interface NearbyLot {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  contactPhone: string;
  blockMinutes: number;
  ratePerBlockSantim: number;
  overstayRatePerBlockSantim: number;
  depositAmountSantim: number;
  holdMinutes: number;
  paymentWindowMinutes: number;
  maxBookingDistanceM: number;
  freeSlots: number;
  totalAppBookableSlots: number;
  distanceM: number;
  withinBookingRange: boolean;
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

  nearbyLots(lat: number, lng: number, radiusM = 5000): Promise<ApiResult<{ lots: NearbyLot[] }>> {
    const query = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      radius_m: String(radiusM),
    });
    return this.#client.request(`/lots/nearby?${query.toString()}`);
  }

  lot(id: string): Promise<ApiResult<NearbyLot>> {
    return this.#client.request(`/lots/${id}`);
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
