import { z } from 'zod';
import { SHORT_CODE_PATTERN } from './constants.js';
import { bookingSourceSchema, bookingStatusSchema, userRoleSchema } from './enums.js';
import { PAYMENT_NOTICES } from './payments.js';

/**
 * Request and response schemas, shared by the API and both clients so a
 * contract change breaks compilation on every side at once.
 */

/** E.164: a leading +, then 8-15 digits. Ethiopian numbers are +251... */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, 'must be an E.164 phone number, for example +251911234567');

export const uuidSchema = z.uuid();

export const latitudeSchema = z.coerce.number().min(-90).max(90);
export const longitudeSchema = z.coerce.number().min(-180).max(180);

// ─── Auth ─────────────────────────────────────────────────────────────────

/**
 * Who a code is for.
 *
 * Absent (or 'driver'): the app. A first sign-in creates a driver account.
 *
 * 'staff': the attendant dashboard. Only a number whose account holds a
 * STAFF_ROLES role gets an SMS or a session; for any other number no code is
 * sent, no account is created, and every response is exactly what a staff
 * number would get — so the dashboard's sign-in cannot be used to discover
 * who is staff, or to create accounts by mistyping.
 */
export const OTP_AUDIENCES = ['driver', 'staff'] as const;
export type OtpAudience = (typeof OTP_AUDIENCES)[number];

export const otpRequestSchema = z.object({
  phone: phoneSchema,
  audience: z.enum(OTP_AUDIENCES).optional(),
});
export type OtpRequest = z.infer<typeof otpRequestSchema>;
export type OtpRequestInput = z.input<typeof otpRequestSchema>;

export const otpRequestResponseSchema = z.object({ expiresAt: z.iso.datetime() });
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

/**
 * Dev login. Phone only — there is no credential, which is precisely why the
 * endpoint is registered only when DEV_AUTH_ENABLED.
 */
export const devLoginSchema = z.object({
  phone: phoneSchema,
});
export type DevLogin = z.infer<typeof devLoginSchema>;

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/u, 'must be six digits'),
  audience: z.enum(OTP_AUDIENCES).optional(),
});
export type OtpVerify = z.infer<typeof otpVerifySchema>;
export type OtpVerifyInput = z.input<typeof otpVerifySchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshSchema>;
export type RefreshInput = z.input<typeof refreshSchema>;

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAt: z.iso.datetime(),
  refreshExpiresAt: z.iso.datetime(),
  user: z.object({
    id: uuidSchema,
    phone: phoneSchema,
    role: userRoleSchema,
    fullName: z.string().nullable(),
  }),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// ─── Lots ─────────────────────────────────────────────────────────────────

export const nearbyQuerySchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
  radius_m: z.coerce.number().int().positive().max(100_000).default(5_000),
});
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;

/*
 * RESPONSES. The API's lot service returns these types and the mobile client
 * parses with these schemas, so the two cannot describe a lot differently.
 * Before they existed the app hand-wrote its own lot type, typed GET
 * /lots/:id as a NearbyLot it is not (no distanceM, no withinBookingRange),
 * and the Book screen cast the camelCase response into computeBill's
 * snake_case BillableLot — a render crash on the device test.
 *
 * Plain z.object, which drops unknown keys: an older app must keep working
 * when the API adds a field. The API's contract test parses its real
 * responses STRICTLY (z.strictObject over the same shape) so an addition
 * the schema does not describe fails there instead.
 *
 * No coerce, unlike the query schemas: a number arriving as a string IS the
 * drift these exist to catch.
 */
const santim = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

export const lotSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  address: z.string().nullable(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  contactPhone: z.string(),
  blockMinutes: z.number().int().positive(),
  ratePerBlockSantim: santim,
  overstayRatePerBlockSantim: santim,
  depositAmountSantim: santim,
  holdMinutes: z.number().int().positive(),
  paymentWindowMinutes: z.number().int().positive(),
  maxBookingDistanceM: z.number().int().positive(),
  /** App-bookable, in-service slots with no live booking. */
  freeSlots: count,
  totalAppBookableSlots: count,
});
/** GET /v1/lots/:id */
export type LotSummary = z.infer<typeof lotSummarySchema>;

export const nearbyLotSchema = lotSummarySchema.extend({
  distanceM: count,
  /** False when the driver is outside maxBookingDistanceM. */
  withinBookingRange: z.boolean(),
});
export type NearbyLot = z.infer<typeof nearbyLotSchema>;

/** GET /v1/lots/nearby */
export const nearbyLotsResponseSchema = z.object({ lots: z.array(nearbyLotSchema) });
export type NearbyLotsResponse = z.infer<typeof nearbyLotsResponseSchema>;

// ─── Bookings ─────────────────────────────────────────────────────────────

/*
 * REQUEST BODIES the mobile app sends. The app builds each one as the
 * schema's *Input type, so a field it names wrongly fails to compile. On
 * the device test the app sent latitude/longitude where this schema wants
 * lat/lng, and additionalMinutes where extend wants additionalBlocks: both
 * came back as a bare "Request validation failed".
 *
 * NO z.coerce in a JSON body. JSON is already typed, and coerce turned the
 * MISSING lat into Number(undefined) — reported as "expected number,
 * received NaN" rather than as missing — and made the input type `unknown`,
 * so a wrong field could not fail to compile. Query strings, which arrive as
 * text, keep latitudeSchema's coerce.
 *
 * An optional field left blank is sent ABSENT: vehiclePlate rejects "".
 */
const latitudeValue = z.number().min(-90).max(90);
const longitudeValue = z.number().min(-180).max(180);

export const createBookingSchema = z.object({
  lotId: uuidSchema,
  plannedMinutes: z.number().int().positive(),
  vehiclePlate: z.string().trim().min(1).max(32).optional(),
  lat: latitudeValue,
  lng: longitudeValue,
});
export type CreateBookingRequest = z.infer<typeof createBookingSchema>;
export type CreateBookingInput = z.input<typeof createBookingSchema>;

export const extendBookingSchema = z.object({
  additionalBlocks: z.number().int().positive().max(48),
});
export type ExtendBookingRequest = z.infer<typeof extendBookingSchema>;
export type ExtendBookingInput = z.input<typeof extendBookingSchema>;

/** Timestamps go out as ISO-8601 UTC strings (Date.toISOString). */
const isoOrNull = z.iso.datetime().nullable();

/**
 * The OWNER's view of a booking, with the QR token and short code — both
 * credentials, never in anyone else's response. The attendant's view omits
 * qrToken (toStaffBookingDto).
 */
export const bookingSchema = z.object({
  id: uuidSchema,
  lotId: uuidSchema,
  slotId: uuidSchema,
  status: bookingStatusSchema,
  source: bookingSourceSchema,
  vehiclePlate: z.string().nullable(),
  plannedMinutes: z.number().int().positive().nullable(),
  qrToken: z.string().nullable(),
  shortCode: z.string().nullable(),
  holdExpiresAt: isoOrNull,
  checkedInAt: isoOrNull,
  plannedEndAt: isoOrNull,
  checkedOutAt: isoOrNull,
  amountDueSantim: santim.nullable(),
  createdAt: z.iso.datetime(),
  /** Clients drop events older than the snapshot they hold. */
  updatedAt: z.iso.datetime(),
});
export type Booking = z.infer<typeof bookingSchema>;

const paymentNoticeSchema = z.enum(PAYMENT_NOTICES).nullable();

/** POST /v1/bookings */
export const createBookingResponseSchema = z.object({
  booking: bookingSchema,
  paymentRequired: z.boolean(),
  depositAmountSantim: santim,
  /**
   * The deposit checkout, when one is owed and the provider started it. Null
   * when no deposit is owed, AND when the provider could not be reached: the
   * booking still exists in PENDING_PAYMENT, and the driver retries with
   * POST /bookings/:id/deposit before the payment window lapses.
   */
  checkoutUrl: z.string().nullable(),
});
export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;

/**
 * The lot version a driver's booking was read at. The app applies a
 * booking.updated event only when its lotVersion is higher (realtime.ts has
 * the rule); the row and this version come from one statement.
 */
const bookingLotVersion = z.int().nonnegative();

/** GET /v1/bookings/:id, and POST /v1/bookings/:id/deposit/verify */
export const bookingResponseSchema = z.object({
  booking: bookingSchema,
  paymentNotice: paymentNoticeSchema,
  lotVersion: bookingLotVersion,
});
export type BookingResponse = z.infer<typeof bookingResponseSchema>;

/** GET /v1/bookings/current: 200 with null, not 404, when there is none. */
export const currentBookingResponseSchema = z.object({
  booking: bookingSchema.nullable(),
  paymentNotice: paymentNoticeSchema,
  /** Null exactly when booking is. */
  lotVersion: bookingLotVersion.nullable(),
});
export type CurrentBookingResponse = z.infer<typeof currentBookingResponseSchema>;

/** POST /v1/bookings/:id/cancel */
export const cancelBookingResponseSchema = z.object({ booking: bookingSchema });
export type CancelBookingResponse = z.infer<typeof cancelBookingResponseSchema>;

/** POST /v1/bookings/:id/extend */
export const extendBookingResponseSchema = z.object({
  booking: bookingSchema,
  addedMinutes: z.number().int().positive(),
});
export type ExtendBookingResponse = z.infer<typeof extendBookingResponseSchema>;

/** POST /v1/bookings/:id/pay */
export const payBookingResponseSchema = z.object({
  checkoutUrl: z.string(),
  txRef: z.string().nullable(),
  amountSantim: z.number().int().positive(),
});
export type PayBookingResponse = z.infer<typeof payBookingResponseSchema>;

/**
 * POST /v1/bookings/:id/deposit: the deposit checkout, reopened if one is
 * still payable, otherwise started. 200 when reopened, 201 when started.
 */
export const payDepositResponseSchema = payBookingResponseSchema;
export type PayDepositResponse = PayBookingResponse;

// ─── Push ─────────────────────────────────────────────────────────────────

/** Expo's token format; anything else is not a token Expo will accept. */
export const expoPushTokenSchema = z
  .string()
  .trim()
  .regex(
    /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/u,
    'must be an Expo push token, for example ExponentPushToken[xxxxxxxx]',
  );

/** POST /v1/push/tokens — answered 204, no body. */
export const registerPushTokenSchema = z.object({ expoPushToken: expoPushTokenSchema });
export type RegisterPushTokenInput = z.input<typeof registerPushTokenSchema>;

// ─── Staff ────────────────────────────────────────────────────────────────

export const walkInSchema = z.object({
  slotId: uuidSchema,
  vehiclePlate: z.string().trim().min(1).max(32).optional(),
});
export type WalkInRequest = z.infer<typeof walkInSchema>;

/**
 * One field for both credentials: a scan yields a QR token, a manual entry
 * yields a short code. They are told apart by shape, not by a separate
 * endpoint, because the attendant is doing the same thing either way.
 */
export const checkInSchema = z.object({
  code: z.string().trim().min(1),
});
export type CheckInRequest = z.infer<typeof checkInSchema>;

export function looksLikeShortCode(code: string): boolean {
  return SHORT_CODE_PATTERN.test(code.trim().toUpperCase());
}

export const cashPaymentSchema = z.object({
  amountSantim: z.int().positive(),
  /**
   * Settle in cash even though an in-app payment is still pending. A
   * deliberate act: the driver may still complete that checkout, in which case
   * the duplicate lands in the operator refund queue.
   */
  overridePending: z.boolean().default(false),
});
export type CashPaymentRequest = z.infer<typeof cashPaymentSchema>;

export const slotServiceSchema = z.object({
  inService: z.boolean(),
});
export type SlotServiceRequest = z.infer<typeof slotServiceSchema>;

/** What the dashboard builds its request bodies as (defaults still optional). */
export type WalkInInput = z.input<typeof walkInSchema>;
export type CheckInInput = z.input<typeof checkInSchema>;
export type CashPaymentInput = z.input<typeof cashPaymentSchema>;
export type SlotServiceInput = z.input<typeof slotServiceSchema>;

/**
 * The staff responses, as sent. The dashboard parses every one with these
 * (apps/dashboard/src/api/client.ts), and the API's routes are typed
 * against them, so the two cannot drift: the dashboard had described the
 * check-out bill with fields the API never sent.
 */

/** The attendant's view of a booking: the owner's, without the QR token. */
export const staffBookingSchema = bookingSchema.omit({ qrToken: true });
export type StaffBooking = z.infer<typeof staffBookingSchema>;

/** POST /staff/lots/:id/walk-ins (201), POST /staff/check-in, POST /staff/bookings/:id/cash */
export const staffBookingResponseSchema = z.object({ booking: staffBookingSchema });
export type StaffBookingResponse = z.infer<typeof staffBookingResponseSchema>;

/**
 * GET /staff/lots. In snake_case, unlike every other response: it is sent
 * straight from the lots row. Described as sent, not as intended.
 */
export const staffedLotSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  address: z.string().nullable(),
  block_minutes: z.int().positive(),
  rate_per_block_santim: santim,
  overstay_rate_per_block_santim: santim,
  deposit_amount_santim: santim,
});
export type StaffedLot = z.infer<typeof staffedLotSchema>;
export const staffedLotsResponseSchema = z.object({ lots: z.array(staffedLotSchema) });
export type StaffedLotsResponse = z.infer<typeof staffedLotsResponseSchema>;

/** One line of computeBill's breakdown (billing.ts). */
export const billLineSchema = z.object({
  kind: z.enum(['planned', 'overstay', 'walk_in', 'deposit_credit']),
  minutes: z.int().nonnegative(),
  blocks: z.int().nonnegative(),
  unitSantim: santim,
  /** Signed: the deposit credit is negative. */
  amountSantim: z.int(),
});
export const billBreakdownSchema = z.object({
  lines: z.array(billLineSchema),
  subtotalSantim: santim,
  depositCreditSantim: santim,
  depositUnusedSantim: santim,
  amountDueSantim: santim,
});

/** POST /staff/bookings/:id/check-out */
export const checkOutResponseSchema = z.object({
  booking: staffBookingSchema,
  bill: billBreakdownSchema,
  /** True when nothing was due and the booking went straight to PAID. */
  settled: z.boolean(),
});
export type CheckOutResponse = z.infer<typeof checkOutResponseSchema>;

/** PATCH /staff/slots/:id */
export const slotServiceResponseSchema = z.object({ slotId: uuidSchema, inService: z.boolean() });
export type SlotServiceResponse = z.infer<typeof slotServiceResponseSchema>;

// ─── Admin ────────────────────────────────────────────────────────────────

export const createLotSchema = z.object({
  operatorId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  contactPhone: phoneSchema,
  blockMinutes: z.int().positive().default(30),
  ratePerBlockSantim: z.int().nonnegative(),
  overstayRatePerBlockSantim: z.int().nonnegative(),
  depositAmountSantim: z.int().nonnegative().default(0),
  paymentWindowMinutes: z.int().positive().default(3),
  holdMinutes: z.int().positive().default(15),
  maxBookingDistanceM: z.int().positive().default(10_000),
});
export type CreateLotRequest = z.infer<typeof createLotSchema>;

/**
 * Spelled out rather than derived from createLotSchema with .partial().
 *
 * .partial() makes a field optional but does NOT remove its .default(), so
 * parsing `{}` would yield every defaulted field populated — and a PATCH with
 * an empty body would silently RESET blockMinutes, holdMinutes,
 * paymentWindowMinutes, depositAmountSantim and maxBookingDistanceM to their
 * defaults. Every field here is optional with no default, so an absent field
 * means "leave it alone".
 */
export const updateLotSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(500).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    contactPhone: phoneSchema.optional(),
    blockMinutes: z.int().positive().optional(),
    ratePerBlockSantim: z.int().nonnegative().optional(),
    overstayRatePerBlockSantim: z.int().nonnegative().optional(),
    depositAmountSantim: z.int().nonnegative().optional(),
    paymentWindowMinutes: z.int().positive().optional(),
    holdMinutes: z.int().positive().optional(),
    maxBookingDistanceM: z.int().positive().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be provided');
export type UpdateLotRequest = z.infer<typeof updateLotSchema>;

export const bulkSlotsSchema = z.object({
  zone: z.string().trim().min(1).max(50).default('main'),
  rows: z.int().positive().max(50),
  cols: z.int().positive().max(50),
  labelPrefix: z
    .string()
    .trim()
    .regex(/^[A-Z]$/u, 'must be a single uppercase letter')
    .default('A'),
  appBookable: z.boolean().default(true),
});
export type BulkSlotsRequest = z.infer<typeof bulkSlotsSchema>;
