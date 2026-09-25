# Amharic strings for native-speaker review

Every string added or changed in the attendant dashboard: Phase 3, and the
staff sign-in added after Phase 4. These were written by a non-native speaker
and need a review pass before the dashboard is put in front of an attendant.

Interpolations in `{{braces}}` are substituted at runtime and must survive
translation. In `conflict.explained`, `{{action}}` and `{{status}}` are
themselves translated strings from this table, so the sentence has to read
correctly with any of them inserted — worth checking specifically, since it was
drafted around English word order.

A key-parity test (`i18n.test.ts`) already guarantees no key is missing from
either bundle and that none is empty. What it cannot check is whether the
Amharic is idiomatic, which is what this list is for.

## New strings (55)

| Key                        | English                                                                         | Amharic                                               |
| -------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `source.app`               | App booking                                                                     | በአፕ የተያዘ                                              |
| `source.walk_in`           | Walk-in                                                                         | በቦታው የመጣ                                              |
| `connection.live`          | Live                                                                            | በቀጥታ                                                  |
| `connection.connecting`    | Connecting…                                                                     | በመገናኘት ላይ…                                            |
| `connection.reconnecting`  | Reconnecting — this view may be out of date                                     | እንደገና በመገናኘት ላይ — ይህ ገጽ ያልተዘመነ ሊሆን ይችላል               |
| `connection.offline`       | Offline — this view is not updating                                             | ግንኙነት የለም — ይህ ገጽ አይዘመንም                              |
| `connection.retry`         | Retry                                                                           | እንደገና ሞክር                                             |
| `grid.loading`             | Loading the lot…                                                                | ማቆሚያው በመጫን ላይ…                                        |
| `grid.empty`               | This lot has no slots yet                                                       | በዚህ ማቆሚያ ውስጥ ቦታዎች የሉም                                 |
| `drawer.title`             | Slot                                                                            | ቦታ                                                    |
| `drawer.zone`              | Zone {{zone}}                                                                   | ዞን {{zone}}                                           |
| `drawer.plate`             | Plate                                                                           | ታርጋ                                                   |
| `drawer.plateOptional`     | Plate (optional)                                                                | ታርጋ (አማራጭ)                                            |
| `drawer.until`             | Until                                                                           | እስከ                                                   |
| `drawer.holdUntil`         | Held until                                                                      | የተያዘው እስከ                                             |
| `drawer.source`            | Source                                                                          | ምንጭ                                                   |
| `action.scan`              | Scan                                                                            | ቃኝ                                                    |
| `action.typeCode`          | Type code                                                                       | ኮድ ተይብ                                                |
| `action.park`              | Park a walk-in                                                                  | በቦታው የመጣ አስገባ                                         |
| `action.checkOut`          | Check out                                                                       | አስወጣ                                                  |
| `action.checkIn`           | Check in                                                                        | አስገባ                                                  |
| `action.cash`              | Record cash                                                                     | ጥሬ ገንዘብ መዝግብ                                          |
| `action.recordCash`        | Record cash {{amount}}                                                          | ጥሬ ገንዘብ መዝግብ {{amount}}                               |
| `action.outOfService`      | Take out of service                                                             | ከአገልግሎት አውጣ                                           |
| `action.inService`         | Return to service                                                               | ወደ አገልግሎት መልስ                                         |
| `action.close`             | Close                                                                           | ዝጋ                                                    |
| `action.cancel`            | Cancel                                                                          | ተወው                                                   |
| `action.pending`           | Sending…                                                                        | በመላክ ላይ…                                              |
| `action.waitingForServer`  | Waiting for the server to confirm. Nothing has changed yet.                     | ሰርቨሩ እስኪያረጋግጥ በመጠበቅ ላይ። እስካሁን ምንም አልተቀየረም።            |
| `conflict.explained`       | Could not {{action}}: this slot is now {{status}}. The view has been refreshed. | {{action}} አልተቻለም፦ ይህ ቦታ አሁን {{status}} ነው። ገጹ ተዘምኗል። |
| `conflict.unknown`         | no longer in this lot                                                           | በዚህ ማቆሚያ ውስጥ የለም                                      |
| `scanner.title`            | Scan the driver's QR code                                                       | የሹፌሩን QR ኮድ ቃኝ                                        |
| `scanner.hint`             | Hold the code inside the frame                                                  | ኮዱን በክፈፉ ውስጥ ያዝ                                       |
| `scanner.unavailable`      | The camera is not available on this device                                      | በዚህ መሣሪያ ላይ ካሜራ አይገኝም                                 |
| `scanner.insecureContext`  | The camera needs HTTPS. Open this page over https:// or localhost.              | ካሜራው HTTPS ይፈልጋል። ይህን ገጽ በhttps:// ወይም localhost ክፈት። |
| `scanner.permissionDenied` | Camera permission was refused                                                   | የካሜራ ፈቃድ ተከልክሏል                                       |
| `scanner.useShortCode`     | Ask the driver for their 6-character code instead                               | በምትኩ ሹፌሩን የ6 ፊደል ኮዱን ጠይቅ                              |
| `shortCode.title`          | Enter the 6-character code                                                      | የ6 ፊደል ኮዱን አስገባ                                       |
| `signIn.devOnly`           | Development sign-in. Enter a seeded phone number.                               | የልማት መግቢያ። የተመዘገበ ስልክ ቁጥር አስገባ።                       |
| `signIn.phone`             | Phone number                                                                    | ስልክ ቁጥር                                               |
| `signIn.submit`            | Sign in                                                                         | ግባ                                                    |
| `theme.toggle`             | Change theme                                                                    | ገጽታ ቀይር                                               |
| `theme.light`              | Light                                                                           | ብሩህ                                                   |
| `theme.dark`               | Dark                                                                            | ጨለማ                                                   |
| `theme.system`             | Auto                                                                            | ራስ-ሰር                                                 |
| `error.STATE_CONFLICT`     | That booking has already moved on                                               | ይህ ቦታ ማስያዣ አስቀድሞ ተቀይሯል                                |
| `error.SLOT_TAKEN`         | That slot already has a car on it                                               | በዚህ ቦታ ላይ አስቀድሞ መኪና አለ                                |
| `error.SLOT_IN_USE`        | Check the car out first                                                         | መጀመሪያ መኪናውን አስወጣ                                      |
| `error.NOT_FOUND`          | No booking matches that code                                                    | ከዚህ ኮድ ጋር የሚዛመድ ማስያዣ የለም                              |
| `error.FORBIDDEN`          | You are not assigned to this lot                                                | በዚህ ማቆሚያ ላይ አልተመደብክም                                  |
| `error.ALREADY_PAID`       | This booking was already paid in the app                                        | ይህ ማስያዣ አስቀድሞ በአፑ ተከፍሏል                               |
| `error.PAYMENT_PENDING`    | An in-app payment is still pending. Confirm with the driver.                    | በአፑ ውስጥ ክፍያ በመጠባበቅ ላይ ነው። ከሹፌሩ ጋር አረጋግጥ።              |
| `error.NETWORK`            | No connection to the server                                                     | ከሰርቨሩ ጋር ግንኙነት የለም                                    |
| `error.UNAUTHENTICATED`    | Your session has ended. Sign in again.                                          | ክፍለ ጊዜህ አብቅቷል። እንደገና ግባ።                              |
| `lot.choose`               | Choose a lot                                                                    | ማቆሚያ ምረጥ                                              |

## Changed strings (1)

| Key             | English  | Amharic (was) | Amharic (now) |
| --------------- | -------- | ------------- | ------------- |
| `slot.occupied` | Occupied | ተይዞ ነው        | መኪና አለ        |

## Staff sign-in by code (12)

Added after Phase 4, when the dashboard gained its real sign-in. Same author,
same caveat.

| Key                         | English                                                                       | Amharic                                             |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `signIn.otpIntro`           | Enter your staff phone number. A sign-in code will be sent by SMS.            | የሠራተኛ ስልክ ቁጥር አስገባ። የመግቢያ ኮድ በኤስኤምኤስ ይላካል።          |
| `signIn.sendCode`           | Send code                                                                     | ኮድ ላክ                                               |
| `signIn.codeOnItsWay`       | If {{phone}} belongs to a staff account, a 6-digit code is on its way by SMS. | {{phone}} የሠራተኛ መለያ ከሆነ፣ ባለ 6 አሃዝ ኮድ በኤስኤምኤስ ይደርሳል። |
| `signIn.code`               | 6-digit code                                                                  | ባለ 6 አሃዝ ኮድ                                         |
| `signIn.verify`             | Sign in                                                                       | ግባ                                                  |
| `signIn.changeNumber`       | Use a different number                                                        | ሌላ ቁጥር ተጠቀም                                         |
| `signIn.error.codeRejected` | That code is not correct or has expired. Request a new one.                   | ኮዱ ትክክል አይደለም ወይም ጊዜው አልፏል። አዲስ ኮድ ጠይቅ።             |
| `signIn.error.rateLimited`  | Too many attempts. Wait a few minutes and try again.                          | በጣም ብዙ ሙከራዎች። ጥቂት ደቂቃዎች ቆይተህ እንደገና ሞክር።             |
| `signIn.error.badPhone`     | Enter the number with its country code, for example +251911234567.            | ቁጥሩን ከአገር ኮዱ ጋር አስገባ፣ ለምሳሌ +251911234567።           |
| `signIn.error.badCode`      | Enter the 6 digits from the SMS.                                              | በኤስኤምኤስ የመጡትን 6 አሃዞች አስገባ።                          |
| `signIn.error.network`      | Cannot reach the server. Check the connection and try again.                  | ከሰርቨሩ ጋር መገናኘት አልተቻለም። ግንኙነቱን አረጋግጠህ እንደገና ሞክር።     |
| `signIn.error.failed`       | Sign-in failed. Try again.                                                    | መግባት አልተሳካም። እንደገና ሞክር።                             |

## Specific doubts

- **`slot.occupied`** — changed from **ተይዞ ነው** to **መኪና አለ** ("there is a
  car") to separate it from `slot.reserved` (**ተይዟል**, "it is taken"). Both
  previously read as "taken", which is exactly the distinction an attendant
  must make at a glance. Please confirm the pair is now unambiguous.
- **`action.park`** — **በቦታው የመጣ አስገባ** is literal ("admit the one who came
  to the place"). There is probably an ordinary word attendants actually use.
- **`connection.reconnecting` / `connection.offline`** — these warn that the
  screen may be wrong. Tone matters more than literal accuracy: the attendant
  must not keep trusting the grid.
- **`action.waitingForServer`** — must not read as though the action already
  succeeded. That is the entire purpose of the string.
- **`drawer.plateOptional`** — "(አማራጭ)" for "(optional)"; check this is the
  usual way to mark an optional field.
- **`signIn.codeOnItsWay`** — must stay CONDITIONAL: "if this number is a
  staff account, a code is on its way". The screen deliberately does not
  reveal whether a number is staff, so a translation that reads as "a code
  has been sent" would be wrong for every number that is not.
- Technical terms deliberately left in English: **QR**, **HTTPS**,
  **localhost**. Confirm that is right rather than transliterating.
- Verb forms are informal/imperative singular (አስገባ, አስወጣ, ቃኝ) on the
  assumption that a tool speaks plainly to its operator. If a workplace tool
  should use the polite form, every action string changes together.
