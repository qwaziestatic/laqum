import type { Database } from '@laqum/db';
import {
  AppError,
  type LotSummary,
  type NearbyLot,
  type PublicSnapshot,
  haversineMeters,
} from '@laqum/shared';
import type { Kysely, Selectable } from 'kysely';
import { publicSnapshot } from '../realtime/slots.js';

/**
 * Lot browsing for drivers.
 *
 * Distance is computed in Node rather than SQL. At MVP scale (a handful of
 * Addis lots) the difference is nothing, the haversine stays a pure, unit-
 * tested function, and there is no PostGIS dependency. If the lot count ever
 * reaches the thousands this becomes a bounding-box query plus an index.
 */

type LotRow = Selectable<Database['lots']>;

// The response types are SHARED (lotSummarySchema, nearbyLotSchema), so the
// mobile client parses exactly what toSummary builds. See apps/api/test/lots.test.ts.

function toSummary(lot: LotRow, freeSlots: number, totalAppBookable: number): LotSummary {
  return {
    id: lot.id,
    name: lot.name,
    address: lot.address,
    latitude: lot.latitude,
    longitude: lot.longitude,
    contactPhone: lot.contact_phone,
    blockMinutes: lot.block_minutes,
    ratePerBlockSantim: lot.rate_per_block_santim,
    overstayRatePerBlockSantim: lot.overstay_rate_per_block_santim,
    depositAmountSantim: lot.deposit_amount_santim,
    holdMinutes: lot.hold_minutes,
    paymentWindowMinutes: lot.payment_window_minutes,
    maxBookingDistanceM: lot.max_booking_distance_m,
    freeSlots,
    totalAppBookableSlots: totalAppBookable,
  };
}

interface Counts {
  free: number;
  total: number;
}

/**
 * Free and total counts per lot, app-bookable only.
 *
 * Read through slot_status so "free" has exactly one definition — the view's,
 * which is derived from live bookings rather than any stored slot state.
 */
async function countsByLot(db: Kysely<Database>, lotIds: string[]): Promise<Map<string, Counts>> {
  const counts = new Map<string, Counts>(lotIds.map((id) => [id, { free: 0, total: 0 }]));
  if (lotIds.length === 0) return counts;

  const rows = await db
    .selectFrom('slot_status')
    .select(({ fn, eb }) => [
      'lot_id',
      fn.countAll<string>().as('total'),
      fn
        .count<string>(
          eb.case().when('display_status', '=', 'free').then(eb.ref('slot_id')).else(null).end(),
        )
        .as('free'),
    ])
    .where('lot_id', 'in', lotIds)
    .where('app_bookable', '=', true)
    .groupBy('lot_id')
    .execute();

  for (const row of rows) {
    if (row.lot_id === null) continue;
    counts.set(row.lot_id, { free: Number(row.free), total: Number(row.total) });
  }
  return counts;
}

export async function findNearbyLots(
  db: Kysely<Database>,
  query: { lat: number; lng: number; radius_m: number },
): Promise<NearbyLot[]> {
  const lots = await db.selectFrom('lots').selectAll().where('is_active', '=', true).execute();
  const counts = await countsByLot(
    db,
    lots.map((l) => l.id),
  );

  return lots
    .map((lot) => {
      const distanceM = Math.round(
        haversineMeters(
          { latitude: query.lat, longitude: query.lng },
          { latitude: lot.latitude, longitude: lot.longitude },
        ),
      );
      const c = counts.get(lot.id) ?? { free: 0, total: 0 };
      return {
        ...toSummary(lot, c.free, c.total),
        distanceM,
        withinBookingRange: distanceM <= lot.max_booking_distance_m,
      };
    })
    .filter((lot) => lot.distanceM <= query.radius_m)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export async function getLot(db: Kysely<Database>, lotId: string): Promise<LotSummary> {
  const lot = await db
    .selectFrom('lots')
    .selectAll()
    .where('id', '=', lotId)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!lot) throw new AppError('NOT_FOUND', 'No such lot');

  const counts = (await countsByLot(db, [lot.id])).get(lot.id) ?? { free: 0, total: 0 };
  return toSummary(lot, counts.free, counts.total);
}

/**
 * The slot grid as a DRIVER may see it, with the lot version it was read at.
 *
 * The payload omits booking_id, vehicle_plate, hold_expires_at and
 * planned_end_at: a driver may see that a slot is occupied, never by whom or
 * until when. That omission is structural — publicSnapshot selects only the
 * public columns, so there is nothing to forget to strip.
 */
export async function getLotLayout(db: Kysely<Database>, lotId: string): Promise<PublicSnapshot> {
  const lot = await db
    .selectFrom('lots')
    .select('id')
    .where('id', '=', lotId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!lot) throw new AppError('NOT_FOUND', 'No such lot');

  return publicSnapshot(db, lotId);
}
