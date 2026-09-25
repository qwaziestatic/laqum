/**
 * Every English string the driver app shows, grouped by screen.
 *
 * The SHAPE of this object is the key set: am.ts is typed against it, so a
 * key added here does not compile until it has Amharic too, and a key only
 * in Amharic is an excess-property error. i18next interpolates {{name}}.
 * docs/AMHARIC-REVIEW.md lists every key with both texts.
 */
export const en = {
  app: {
    name: 'ላቁም?',
    tagline: 'Find and hold a parking slot in Addis Ababa.',
  },
  language: {
    // Each language is named in itself, in both bundles: the switch offers
    // the OTHER language, so it must be readable by someone who needs it.
    am: 'አማርኛ',
    en: 'English',
    switchTo: 'Switch to {{language}}',
  },
  common: {
    retry: 'Retry',
    tryAgain: 'Try again',
    openSettings: 'Open settings',
  },
  money: {
    birr: '{{amount}} ETB',
  },
  nav: {
    signIn: 'Sign in',
    lot: 'Parking lot',
    book: 'Book a slot',
    booking: 'Your booking',
    checkout: 'Pay',
  },
  session: {
    ended: 'Your session has ended. Sign in again.',
  },
  login: {
    phoneLabel: 'Phone number',
    sendCode: 'Send code',
    codeSent: 'We sent a 6-digit code to {{phone}}.',
    codeLabel: 'Verification code',
    signIn: 'Sign in',
    changeNumber: 'Use a different number',
  },
  home: {
    finding: 'Finding parking near you…',
    activeBooking: 'You have an active booking.',
    openBooking: 'Open it',
    locationServicesOff:
      'Location is switched off, so distances are estimated. Turn it on to book.',
    locationDenied: 'ላቁም? needs your location to confirm you are close enough to a lot.',
    locationUnavailable: 'Your location could not be found, so distances are estimated.',
    nearby: 'Nearby lots',
    empty: 'No lots within range.',
    lotLine: '{{free}} of {{total}} free · {{rate}} per {{minutes}} min',
    distance: '{{meters}} m away',
    distanceUnknown: 'Distance needs your location',
    updated: 'Updated {{time}}',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
  },
  lot: {
    loading: 'Loading lot…',
    free: '{{count}} free',
    bookable: 'of {{total}} bookable slots',
    rate: '{{rate}} per {{minutes}} minutes',
    overstayRate: 'Overstay {{rate}} per {{minutes}} minutes',
    deposit: 'Deposit {{amount}}, held for {{minutes}} minutes',
    noDeposit: 'No deposit. Slot held for {{minutes}} minutes.',
    full: 'This lot is full right now. Counts update live — try again in a moment.',
    fullButton: 'Lot full',
    book: 'Book a slot',
    call: 'Call the lot · {{phone}}',
  },
  book: {
    howLong: 'How long?',
    minutes: '{{count}} min',
    plate: 'Plate (optional)',
    plateLabel: 'Vehicle plate',
    totalMinutes: '{{count}} minutes',
    depositNow: '{{amount}} deposit now, the rest on exit',
    payOnExit: 'Pay on exit. No deposit.',
    retryPrecisely: 'Retry precisely',
    tooFar: 'You are about {{distance}} m away. This lot only holds slots within {{limit}} m.',
    tooFarServer: 'You are {{distance}} m away. This lot only holds slots within {{limit}} m.',
    needBetterFix:
      'Your position is accurate to about {{accuracy}} m, which is not precise enough this close to the limit. Step into the open and try again.',
    stale: 'Your last position is too old to trust.',
    locationServicesOff: 'Location is switched off. Turn it on to book a slot.',
    locationDenied: 'ላቁም? needs your location to confirm you are close enough to this lot.',
    locationBlocked: 'Location permission is blocked. Allow it in Settings to book.',
    locationPreciseTimeout:
      'A precise position did not arrive in time. Step into the open, away from buildings, and try again.',
    locationNotFound: 'Your position could not be found. Step outside and try again.',
    locationNotConfirmed: 'Your position could not be confirmed. Try again.',
    button: {
      holding: 'Holding your slot…',
      precise: 'Getting a more precise location…',
      checking: 'Checking your location…',
      locationNeeded: 'Location needed to book',
      locationUnavailable: 'Location unavailable',
      hold: 'Hold this slot',
      notPrecise: 'Location not precise enough',
      tooFar: 'Too far from this lot',
      tooOld: 'Location too old to use',
    },
  },
  booking: {
    loading: 'Loading your booking…',
    titleFallback: 'Your booking',
    clockUnsynced: 'Times are approximate until the app reaches the server.',
    checking: 'Checking with the server…',
    overstay: 'You are over your booked time. Overstay is charged at a higher rate.',
    payDeposit: 'Pay deposit {{amount}}',
    payDepositNoAmount: 'Pay deposit',
    showAtGate: 'Show this at the gate',
    readCode: 'Or read the code above to the attendant.',
    findAnother: 'Find another slot',
    navigate: 'Navigate',
    noMapsApp: 'No maps app could be opened. The lot is at {{coordinates}}.',
    extend: 'Extend by {{minutes}} minutes',
    extendBlock: 'Extend by one block',
    pay: 'Pay {{amount}}',
    cancel: 'Cancel booking',
  },
  /** One sentence per BookingStatus (src/booking/view.ts). */
  status: {
    PENDING_PAYMENT: 'Pay the deposit to hold your slot.',
    RESERVED: 'Your slot is held. Drive to the lot.',
    CHECKED_IN: 'You are parked.',
    OVERSTAY: 'Your booked time is up.',
    CHECKED_OUT: 'You have left the lot. Pay to finish.',
    PAID: 'Paid. Thank you for parking.',
    EXPIRED: 'This hold expired and the slot was released.',
    CANCELLED: 'You cancelled this booking and the slot was released.',
  },
  timer: {
    timeLeftToPay: 'Time left to pay',
    slotHeldFor: 'Slot held for',
    timeRemaining: 'Time remaining',
    overBy: 'Over by',
  },
  deposit: {
    notStarted:
      'Your slot is held while you pay, but the payment service could not be reached. Tap Pay deposit before the timer runs out.',
    unavailable:
      'The payment service could not be reached. Your slot is held until the timer runs out. Try again in a moment.',
  },
  checkout: {
    loading: 'Loading your bill…',
    paidTitle: 'Paid',
    paidBody: 'Thank you. Your booking is settled.',
    done: 'Done',
    amountDue: 'Amount due',
    parkedFrom: 'Parked from {{time}}',
    bookedUntil: 'Booked until {{time}}',
    cashHint: 'You can also pay the attendant in cash. Ask them to record it.',
    pay: 'Pay {{amount}}',
  },
  /**
   * What the driver reads when a request fails, by error code. The API's
   * `message` is developer English and is never shown (shared errors.ts).
   */
  errors: {
    VALIDATION_ERROR:
      'The app sent something the server could not accept. Try again, and if it keeps happening, update the app.',
    OTP_INVALID: 'That code is not correct. Check the SMS and try again.',
    OTP_EXPIRED: 'That code has expired. Request a new one.',
    UNAUTHENTICATED: 'Your session has ended. Sign in again.',
    FORBIDDEN: 'This account cannot do that.',
    NOT_FOUND: 'That could not be found. It may have been removed.',
    SLOT_TAKEN: 'That slot was just taken. Try again.',
    LOT_FULL: 'This lot is full right now. Try again in a moment.',
    STATE_CONFLICT: 'This booking changed in the meantime. The screen shows it as it is now.',
    OUTSTANDING_BALANCE: 'Pay for your previous booking before booking again.',
    SLOT_IN_USE: 'That slot is in use.',
    ILLEGAL_TRANSITION: 'That is not possible for this booking now.',
    ALREADY_HAS_ACTIVE_BOOKING: 'You already have an active booking.',
    ALREADY_PAID: 'This is already paid.',
    PAYMENT_AMOUNT_MISMATCH:
      'The payment did not match the amount due. Ask the attendant for help.',
    PAYMENT_NOT_CONFIRMED: 'The payment has not been confirmed yet.',
    PAYMENT_PENDING: 'A payment is still in progress. Wait a moment and check again.',
    TOO_FAR: 'You are too far from this lot to book a slot.',
    RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
    OTP_TOO_MANY_ATTEMPTS: 'Too many wrong codes. Request a new code.',
    INTERNAL: 'Something went wrong on the server. Try again.',
    PROVIDER_UNAVAILABLE: 'The payment service could not be reached. Try again in a moment.',
    // Failures that never reached the server, or came back unreadable.
    NETWORK: 'Cannot reach the server. Check your connection and try again.',
    BAD_RESPONSE:
      'The server sent a response this version of the app does not understand. Update the app.',
    UNKNOWN: 'Something went wrong. Try again.',
    /** A rejected field the driver typed, and what to do about it. */
    field: {
      vehiclePlate: 'Check the plate number: up to 32 letters, digits and dashes.',
      phone: 'Enter your phone number with the country code, for example +251911234567.',
      code: 'Enter the 6-digit code from the SMS.',
    },
  },
} as const;
