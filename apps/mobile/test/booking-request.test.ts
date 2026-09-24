import { createBookingSchema } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { bookingRequest } from '../src/booking/request.js';

/**
 * The Book screen's request body. apps/api/test/mobile-contract.test.ts posts
 * this function's output to the real API; these pin its own rules.
 */

const BASE = {
  lotId: 'c0911390-4d9f-446d-a29f-3cdd5f6caa5a',
  blocks: 2,
  blockMinutes: 5,
  position: { latitude: 9.040093, longitude: 38.762541 },
};

describe('bookingRequest', () => {
  it('names the fields as createBookingSchema does', () => {
    const body = bookingRequest({ ...BASE, plate: 'AA-12345' });

    expect(body).toEqual({
      lotId: BASE.lotId,
      plannedMinutes: 10,
      lat: 9.040093,
      lng: 38.762541,
      vehiclePlate: 'AA-12345',
    });
    expect(createBookingSchema.safeParse(body).success).toBe(true);
  });

  it('sends a blank plate as ABSENT, not as an empty string', () => {
    for (const plate of ['', '   ', '\t']) {
      const body = bookingRequest({ ...BASE, plate });
      expect('vehiclePlate' in body, JSON.stringify(plate)).toBe(false);
      expect(createBookingSchema.safeParse(body).success).toBe(true);
    }
  });

  it('trims a typed plate', () => {
    expect(bookingRequest({ ...BASE, plate: '  AA-12345 ' }).vehiclePlate).toBe('AA-12345');
  });

  it('is what the API would have rejected on the device, had the fields been renamed', () => {
    // The device-test body: latitude/longitude instead of lat/lng.
    const { lat, lng, ...rest } = bookingRequest({ ...BASE, plate: '' });
    const deviceBody = { ...rest, latitude: lat, longitude: lng };

    expect(createBookingSchema.safeParse(deviceBody).success).toBe(false);
  });
});
