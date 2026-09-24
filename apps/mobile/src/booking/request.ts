import type { CreateBookingInput } from '@laqum/shared';

/**
 * The Book screen's POST /v1/bookings body, built in ONE place.
 *
 * apps/api/test/mobile-contract.test.ts calls this same function, so the
 * API's tests post exactly what the app posts. On the device test the screen
 * built the body inline, as latitude/longitude, and every booking came back
 * "Request validation failed".
 */
export function bookingRequest(input: {
  lotId: string;
  blocks: number;
  blockMinutes: number;
  position: { latitude: number; longitude: number };
  /** As typed. Blank or whitespace means no plate. */
  plate: string;
}): CreateBookingInput {
  const plate = input.plate.trim();
  return {
    lotId: input.lotId,
    plannedMinutes: input.blocks * input.blockMinutes,
    lat: input.position.latitude,
    lng: input.position.longitude,
    // ABSENT when blank, never "": createBookingSchema rejects an empty plate.
    ...(plate ? { vehiclePlate: plate } : {}),
  };
}
