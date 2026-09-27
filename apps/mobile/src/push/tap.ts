/**
 * Where a tapped notification leads: the booking it is about.
 *
 * The API puts only `bookingId` and `kind` in a notification's data
 * (apps/api/src/push/notify.ts). Anything else, or an id that is not a UUID,
 * opens nothing: the data arrives from outside the app, and a route built
 * from it must not be steerable.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function bookingIdFromNotification(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as Record<string, unknown>).bookingId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}
