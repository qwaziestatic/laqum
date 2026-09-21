/**
 * Distance for the booking proximity check. No paid routing API in the MVP:
 * this is straight-line distance, which is what max_booking_distance_m means.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** IUGG mean Earth radius. */
const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in metres.
 *
 * Uses haversine rather than the simpler equirectangular approximation: over
 * Addis-scale distances the difference is small, but haversine has no
 * latitude-dependent error term to reason about.
 */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
