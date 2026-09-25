# Amharic strings for native-speaker review

Every Amharic string in the product: the attendant dashboard, the driver
app, and the driver's payment return page. All of it was written by a
non-native speaker and needs a review pass before it is put in front of
anyone.

## Register: polite, everywhere (decided)

**All user-facing Amharic uses the POLITE form** (ይመለሱ, ይክፈሉ, ያስገቡ), in the
driver app AND the dashboard, by the product owner's decision. The informal
second person is gendered (ተመለስ / ተመለሺ) and the app cannot know who is
reading; the polite form is gender-neutral and respectful. The dashboard was
drafted in the informal form: every string that changed is in "Dashboard:
changed to the polite form" below, with its old text, for review.

Interpolations in `{{braces}}` are substituted at runtime and must survive
translation. In `conflict.explained`, `{{action}}` and `{{status}}` are
themselves translated strings from this table, so the sentence has to read
correctly with any of them inserted — worth checking specifically, since it was
drafted around English word order.

A key-parity test (`i18n.test.ts`) already guarantees no key is missing from
either bundle and that none is empty. What it cannot check is whether the
Amharic is idiomatic, which is what this list is for.

## Dashboard: Phase 3 strings (55)

| Key                        | English                                                                         | Amharic                                                |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `source.app`               | App booking                                                                     | በአፕ የተያዘ                                               |
| `source.walk_in`           | Walk-in                                                                         | በቦታው የመጣ                                               |
| `connection.live`          | Live                                                                            | በቀጥታ                                                   |
| `connection.connecting`    | Connecting…                                                                     | በመገናኘት ላይ…                                             |
| `connection.reconnecting`  | Reconnecting — this view may be out of date                                     | እንደገና በመገናኘት ላይ — ይህ ገጽ ያልተዘመነ ሊሆን ይችላል                |
| `connection.offline`       | Offline — this view is not updating                                             | ግንኙነት የለም — ይህ ገጽ አይዘመንም                               |
| `connection.retry`         | Retry                                                                           | እንደገና ይሞክሩ                                             |
| `grid.loading`             | Loading the lot…                                                                | ማቆሚያው በመጫን ላይ…                                         |
| `grid.empty`               | This lot has no slots yet                                                       | በዚህ ማቆሚያ ውስጥ ቦታዎች የሉም                                  |
| `drawer.title`             | Slot                                                                            | ቦታ                                                     |
| `drawer.zone`              | Zone {{zone}}                                                                   | ዞን {{zone}}                                            |
| `drawer.plate`             | Plate                                                                           | ታርጋ                                                    |
| `drawer.plateOptional`     | Plate (optional)                                                                | ታርጋ (አማራጭ)                                             |
| `drawer.until`             | Until                                                                           | እስከ                                                    |
| `drawer.holdUntil`         | Held until                                                                      | የተያዘው እስከ                                              |
| `drawer.source`            | Source                                                                          | ምንጭ                                                    |
| `action.scan`              | Scan                                                                            | ይቃኙ                                                    |
| `action.typeCode`          | Type code                                                                       | ኮድ ይተይቡ                                                |
| `action.park`              | Park a walk-in                                                                  | በቦታው የመጣ ያስገቡ                                          |
| `action.checkOut`          | Check out                                                                       | ያስወጡ                                                   |
| `action.checkIn`           | Check in                                                                        | ያስገቡ                                                   |
| `action.cash`              | Record cash                                                                     | ጥሬ ገንዘብ ይመዝግቡ                                          |
| `action.recordCash`        | Record cash {{amount}}                                                          | ጥሬ ገንዘብ ይመዝግቡ {{amount}}                               |
| `action.outOfService`      | Take out of service                                                             | ከአገልግሎት ያውጡ                                            |
| `action.inService`         | Return to service                                                               | ወደ አገልግሎት ይመልሱ                                         |
| `action.close`             | Close                                                                           | ይዝጉ                                                    |
| `action.cancel`            | Cancel                                                                          | ይተዉት                                                   |
| `action.pending`           | Sending…                                                                        | በመላክ ላይ…                                               |
| `action.waitingForServer`  | Waiting for the server to confirm. Nothing has changed yet.                     | ሰርቨሩ እስኪያረጋግጥ በመጠበቅ ላይ። እስካሁን ምንም አልተቀየረም።             |
| `conflict.explained`       | Could not {{action}}: this slot is now {{status}}. The view has been refreshed. | {{action}} አልተቻለም፦ ይህ ቦታ አሁን {{status}} ነው። ገጹ ተዘምኗል።  |
| `conflict.unknown`         | no longer in this lot                                                           | በዚህ ማቆሚያ ውስጥ የለም                                       |
| `scanner.title`            | Scan the driver's QR code                                                       | የሹፌሩን QR ኮድ ይቃኙ                                        |
| `scanner.hint`             | Hold the code inside the frame                                                  | ኮዱን በክፈፉ ውስጥ ይያዙ                                       |
| `scanner.unavailable`      | The camera is not available on this device                                      | በዚህ መሣሪያ ላይ ካሜራ አይገኝም                                  |
| `scanner.insecureContext`  | The camera needs HTTPS. Open this page over https:// or localhost.              | ካሜራው HTTPS ይፈልጋል። ይህን ገጽ በhttps:// ወይም localhost ይክፈቱ። |
| `scanner.permissionDenied` | Camera permission was refused                                                   | የካሜራ ፈቃድ ተከልክሏል                                        |
| `scanner.useShortCode`     | Ask the driver for their 6-character code instead                               | በምትኩ ሹፌሩን የ6 ፊደል ኮዱን ይጠይቁ                              |
| `shortCode.title`          | Enter the 6-character code                                                      | የ6 ፊደል ኮዱን ያስገቡ                                        |
| `signIn.devOnly`           | Development sign-in. Enter a seeded phone number.                               | የልማት መግቢያ። የተመዘገበ ስልክ ቁጥር ያስገቡ።                        |
| `signIn.phone`             | Phone number                                                                    | ስልክ ቁጥር                                                |
| `signIn.submit`            | Sign in                                                                         | ይግቡ                                                    |
| `theme.toggle`             | Change theme                                                                    | ገጽታ ይቀይሩ                                               |
| `theme.light`              | Light                                                                           | ብሩህ                                                    |
| `theme.dark`               | Dark                                                                            | ጨለማ                                                    |
| `theme.system`             | Auto                                                                            | ራስ-ሰር                                                  |
| `error.STATE_CONFLICT`     | That booking has already moved on                                               | ይህ ቦታ ማስያዣ አስቀድሞ ተቀይሯል                                 |
| `error.SLOT_TAKEN`         | That slot already has a car on it                                               | በዚህ ቦታ ላይ አስቀድሞ መኪና አለ                                 |
| `error.SLOT_IN_USE`        | Check the car out first                                                         | መጀመሪያ መኪናውን ያስወጡ                                       |
| `error.NOT_FOUND`          | No booking matches that code                                                    | ከዚህ ኮድ ጋር የሚዛመድ ማስያዣ የለም                               |
| `error.FORBIDDEN`          | You are not assigned to this lot                                                | በዚህ ማቆሚያ ላይ አልተመደቡም                                    |
| `error.ALREADY_PAID`       | This booking was already paid in the app                                        | ይህ ማስያዣ አስቀድሞ በአፑ ተከፍሏል                                |
| `error.PAYMENT_PENDING`    | An in-app payment is still pending. Confirm with the driver.                    | በአፑ ውስጥ ክፍያ በመጠባበቅ ላይ ነው። ከሹፌሩ ጋር ያረጋግጡ።               |
| `error.NETWORK`            | No connection to the server                                                     | ከሰርቨሩ ጋር ግንኙነት የለም                                     |
| `error.UNAUTHENTICATED`    | Your session has ended. Sign in again.                                          | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ።                              |
| `lot.choose`               | Choose a lot                                                                    | ማቆሚያ ይምረጡ                                              |

## Dashboard: changed during Phase 3 (1)

| Key             | English  | Amharic (was) | Amharic (now) |
| --------------- | -------- | ------------- | ------------- |
| `slot.occupied` | Occupied | ተይዞ ነው        | መኪና አለ        |

## Dashboard: staff sign-in by code (12)

Added after Phase 4, when the dashboard gained its real sign-in. Same author,
same caveat.

| Key                         | English                                                                       | Amharic                                             |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `signIn.otpIntro`           | Enter your staff phone number. A sign-in code will be sent by SMS.            | የሠራተኛ ስልክ ቁጥርዎን ያስገቡ። የመግቢያ ኮድ በኤስኤምኤስ ይላካል።        |
| `signIn.sendCode`           | Send code                                                                     | ኮድ ይላኩልኝ                                            |
| `signIn.codeOnItsWay`       | If {{phone}} belongs to a staff account, a 6-digit code is on its way by SMS. | {{phone}} የሠራተኛ መለያ ከሆነ፣ ባለ 6 አሃዝ ኮድ በኤስኤምኤስ ይደርሳል። |
| `signIn.code`               | 6-digit code                                                                  | ባለ 6 አሃዝ ኮድ                                         |
| `signIn.verify`             | Sign in                                                                       | ይግቡ                                                 |
| `signIn.changeNumber`       | Use a different number                                                        | ሌላ ቁጥር ይጠቀሙ                                         |
| `signIn.error.codeRejected` | That code is not correct or has expired. Request a new one.                   | ኮዱ ትክክል አይደለም ወይም ጊዜው አልፏል። አዲስ ኮድ ይጠይቁ።            |
| `signIn.error.rateLimited`  | Too many attempts. Wait a few minutes and try again.                          | በጣም ብዙ ሙከራዎች። ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።            |
| `signIn.error.badPhone`     | Enter the number with its country code, for example +251911234567.            | ቁጥሩን ከአገር ኮዱ ጋር ያስገቡ፣ ለምሳሌ +251911234567።           |
| `signIn.error.badCode`      | Enter the 6 digits from the SMS.                                              | በኤስኤምኤስ የመጡትን 6 አሃዞች ያስገቡ።                          |
| `signIn.error.network`      | Cannot reach the server. Check the connection and try again.                  | ከሰርቨሩ ጋር መገናኘት አልተቻለም። ግንኙነቱን አረጋግጠው እንደገና ይሞክሩ።    |
| `signIn.error.failed`       | Sign-in failed. Try again.                                                    | መግባት አልተሳካም። እንደገና ይሞክሩ።                            |

## Dashboard: changed to the polite form (35)

By the product owner's decision (see "Register" above). Every string that
addressed the reader in the informal second person, with the text it had.

| Key                         | English                                                            | Amharic (was)                                         | Amharic (now)                                          |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------ |
| `connection.retry`          | Retry                                                              | እንደገና ሞክር                                             | እንደገና ይሞክሩ                                             |
| `action.scan`               | Scan                                                               | ቃኝ                                                    | ይቃኙ                                                    |
| `action.typeCode`           | Type code                                                          | ኮድ ተይብ                                                | ኮድ ይተይቡ                                                |
| `action.park`               | Park a walk-in                                                     | በቦታው የመጣ አስገባ                                         | በቦታው የመጣ ያስገቡ                                          |
| `action.checkOut`           | Check out                                                          | አስወጣ                                                  | ያስወጡ                                                   |
| `action.checkIn`            | Check in                                                           | አስገባ                                                  | ያስገቡ                                                   |
| `action.cash`               | Record cash                                                        | ጥሬ ገንዘብ መዝግብ                                          | ጥሬ ገንዘብ ይመዝግቡ                                          |
| `action.recordCash`         | Record cash {{amount}}                                             | ጥሬ ገንዘብ መዝግብ {{amount}}                               | ጥሬ ገንዘብ ይመዝግቡ {{amount}}                               |
| `action.outOfService`       | Take out of service                                                | ከአገልግሎት አውጣ                                           | ከአገልግሎት ያውጡ                                            |
| `action.inService`          | Return to service                                                  | ወደ አገልግሎት መልስ                                         | ወደ አገልግሎት ይመልሱ                                         |
| `action.close`              | Close                                                              | ዝጋ                                                    | ይዝጉ                                                    |
| `action.cancel`             | Cancel                                                             | ተወው                                                   | ይተዉት                                                   |
| `scanner.title`             | Scan the driver's QR code                                          | የሹፌሩን QR ኮድ ቃኝ                                        | የሹፌሩን QR ኮድ ይቃኙ                                        |
| `scanner.hint`              | Hold the code inside the frame                                     | ኮዱን በክፈፉ ውስጥ ያዝ                                       | ኮዱን በክፈፉ ውስጥ ይያዙ                                       |
| `scanner.insecureContext`   | The camera needs HTTPS. Open this page over https:// or localhost. | ካሜራው HTTPS ይፈልጋል። ይህን ገጽ በhttps:// ወይም localhost ክፈት። | ካሜራው HTTPS ይፈልጋል። ይህን ገጽ በhttps:// ወይም localhost ይክፈቱ። |
| `scanner.useShortCode`      | Ask the driver for their 6-character code instead                  | በምትኩ ሹፌሩን የ6 ፊደል ኮዱን ጠይቅ                              | በምትኩ ሹፌሩን የ6 ፊደል ኮዱን ይጠይቁ                              |
| `shortCode.title`           | Enter the 6-character code                                         | የ6 ፊደል ኮዱን አስገባ                                       | የ6 ፊደል ኮዱን ያስገቡ                                        |
| `signIn.devOnly`            | Development sign-in. Enter a seeded phone number.                  | የልማት መግቢያ። የተመዘገበ ስልክ ቁጥር አስገባ።                       | የልማት መግቢያ። የተመዘገበ ስልክ ቁጥር ያስገቡ።                        |
| `signIn.submit`             | Sign in                                                            | ግባ                                                    | ይግቡ                                                    |
| `signIn.otpIntro`           | Enter your staff phone number. A sign-in code will be sent by SMS. | የሠራተኛ ስልክ ቁጥር አስገባ። የመግቢያ ኮድ በኤስኤምኤስ ይላካል።            | የሠራተኛ ስልክ ቁጥርዎን ያስገቡ። የመግቢያ ኮድ በኤስኤምኤስ ይላካል።           |
| `signIn.sendCode`           | Send code                                                          | ኮድ ላክ                                                 | ኮድ ይላኩልኝ                                               |
| `signIn.verify`             | Sign in                                                            | ግባ                                                    | ይግቡ                                                    |
| `signIn.changeNumber`       | Use a different number                                             | ሌላ ቁጥር ተጠቀም                                           | ሌላ ቁጥር ይጠቀሙ                                            |
| `signIn.error.codeRejected` | That code is not correct or has expired. Request a new one.        | ኮዱ ትክክል አይደለም ወይም ጊዜው አልፏል። አዲስ ኮድ ጠይቅ።               | ኮዱ ትክክል አይደለም ወይም ጊዜው አልፏል። አዲስ ኮድ ይጠይቁ።               |
| `signIn.error.rateLimited`  | Too many attempts. Wait a few minutes and try again.               | በጣም ብዙ ሙከራዎች። ጥቂት ደቂቃዎች ቆይተህ እንደገና ሞክር።               | በጣም ብዙ ሙከራዎች። ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።               |
| `signIn.error.badPhone`     | Enter the number with its country code, for example +251911234567. | ቁጥሩን ከአገር ኮዱ ጋር አስገባ፣ ለምሳሌ +251911234567።             | ቁጥሩን ከአገር ኮዱ ጋር ያስገቡ፣ ለምሳሌ +251911234567።              |
| `signIn.error.badCode`      | Enter the 6 digits from the SMS.                                   | በኤስኤምኤስ የመጡትን 6 አሃዞች አስገባ።                            | በኤስኤምኤስ የመጡትን 6 አሃዞች ያስገቡ።                             |
| `signIn.error.network`      | Cannot reach the server. Check the connection and try again.       | ከሰርቨሩ ጋር መገናኘት አልተቻለም። ግንኙነቱን አረጋግጠህ እንደገና ሞክር።       | ከሰርቨሩ ጋር መገናኘት አልተቻለም። ግንኙነቱን አረጋግጠው እንደገና ይሞክሩ።       |
| `signIn.error.failed`       | Sign-in failed. Try again.                                         | መግባት አልተሳካም። እንደገና ሞክር።                               | መግባት አልተሳካም። እንደገና ይሞክሩ።                               |
| `theme.toggle`              | Change theme                                                       | ገጽታ ቀይር                                               | ገጽታ ይቀይሩ                                               |
| `error.SLOT_IN_USE`         | Check the car out first                                            | መጀመሪያ መኪናውን አስወጣ                                      | መጀመሪያ መኪናውን ያስወጡ                                       |
| `error.FORBIDDEN`           | You are not assigned to this lot                                   | በዚህ ማቆሚያ ላይ አልተመደብክም                                  | በዚህ ማቆሚያ ላይ አልተመደቡም                                    |
| `error.PAYMENT_PENDING`     | An in-app payment is still pending. Confirm with the driver.       | በአፑ ውስጥ ክፍያ በመጠባበቅ ላይ ነው። ከሹፌሩ ጋር አረጋግጥ።              | በአፑ ውስጥ ክፍያ በመጠባበቅ ላይ ነው። ከሹፌሩ ጋር ያረጋግጡ።               |
| `error.UNAUTHENTICATED`     | Your session has ended. Sign in again.                             | ክፍለ ጊዜህ አብቅቷል። እንደገና ግባ።                              | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ።                              |
| `lot.choose`                | Choose a lot                                                       | ማቆሚያ ምረጥ                                              | ማቆሚያ ይምረጡ                                              |

## Driver app (140)

Every string the driver app shows, grouped by screen (from
`apps/mobile/src/i18n/en.ts` and `am.ts`). `{{name}}` is filled in at
runtime and must survive translation (a test checks both bundles have the
same ones). `money.birr` gives every amount: "20.00 ብር".

### Everywhere (15)

| Key                   | English                                      | Amharic                            |
| --------------------- | -------------------------------------------- | ---------------------------------- |
| `app.name`            | ላቁም?                                         | ላቁም?                               |
| `app.tagline`         | Find and hold a parking slot in Addis Ababa. | በአዲስ አበባ የመኪና ማቆሚያ ቦታ ያግኙ እና ያስይዙ። |
| `language.am`         | አማርኛ                                         | አማርኛ                               |
| `language.en`         | English                                      | English                            |
| `language.switchTo`   | Switch to {{language}}                       | ወደ {{language}} ይቀይሩ               |
| `common.retry`        | Retry                                        | እንደገና ይሞክሩ                         |
| `common.tryAgain`     | Try again                                    | እንደገና ይሞክሩ                         |
| `common.openSettings` | Open settings                                | ቅንብሮችን ይክፈቱ                        |
| `money.birr`          | {{amount}} ETB                               | {{amount}} ብር                      |
| `nav.signIn`          | Sign in                                      | ይግቡ                                |
| `nav.lot`             | Parking lot                                  | የመኪና ማቆሚያ                          |
| `nav.book`            | Book a slot                                  | ቦታ ያስይዙ                            |
| `nav.booking`         | Your booking                                 | የእርስዎ ቦታ ማስያዣ                      |
| `nav.checkout`        | Pay                                          | ክፍያ                                |
| `session.ended`       | Your session has ended. Sign in again.       | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ።          |

### Sign-in (6)

| Key                  | English                              | Amharic                        |
| -------------------- | ------------------------------------ | ------------------------------ |
| `login.phoneLabel`   | Phone number                         | ስልክ ቁጥር                        |
| `login.sendCode`     | Send code                            | ኮድ ይላኩልኝ                       |
| `login.codeSent`     | We sent a 6-digit code to {{phone}}. | ባለ 6 አሃዝ ኮድ ወደ {{phone}} ልከናል። |
| `login.codeLabel`    | Verification code                    | የማረጋገጫ ኮድ                      |
| `login.signIn`       | Sign in                              | ይግቡ                            |
| `login.changeNumber` | Use a different number               | ሌላ ቁጥር ይጠቀሙ                    |

### Home (map and list) (14)

| Key                        | English                                                                   | Amharic                                                |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `home.finding`             | Finding parking near you…                                                 | በአቅራቢያዎ የመኪና ማቆሚያ በመፈለግ ላይ…                            |
| `home.activeBooking`       | You have an active booking.                                               | ንቁ የቦታ ማስያዣ አለዎት።                                      |
| `home.openBooking`         | Open it                                                                   | ይክፈቱት                                                  |
| `home.locationServicesOff` | Location is switched off, so distances are estimated. Turn it on to book. | የአካባቢ አገልግሎት ጠፍቷል፤ ርቀቶቹ ግምታዊ ናቸው። ቦታ ለማስያዝ ያብሩት።       |
| `home.locationDenied`      | ላቁም? needs your location to confirm you are close enough to a lot.        | ላቁም? ለማቆሚያ በቂ ቅርበት ላይ መሆንዎን ለማረጋገጥ አካባቢዎን ይፈልጋል።       |
| `home.locationUnavailable` | Your location could not be found, so distances are estimated.             | አካባቢዎ ሊገኝ አልቻለም፤ ርቀቶቹ ግምታዊ ናቸው።                        |
| `home.nearby`              | Nearby lots                                                               | በአቅራቢያ ያሉ ማቆሚያዎች                                       |
| `home.empty`               | No lots within range.                                                     | በዚህ ክልል ውስጥ ማቆሚያ የለም።                                  |
| `home.lotLine`             | {{free}} of {{total}} free · {{rate}} per {{minutes}} min                 | ከ{{total}} ውስጥ {{free}} ነፃ · {{rate}} በ{{minutes}} ደቂቃ |
| `home.distance`            | {{meters}} m away                                                         | {{meters}} ሜትር ይርቃል                                    |
| `home.distanceUnknown`     | Distance needs your location                                              | ርቀቱን ለማወቅ አካባቢዎ ያስፈልጋል                                 |
| `home.updated`             | Updated {{time}}                                                          | የተዘመነው {{time}}                                        |
| `home.refresh`             | Refresh                                                                   | ያድሱ                                                    |
| `home.refreshing`          | Refreshing…                                                               | በማደስ ላይ…                                               |

### Lot (11)

| Key                | English                                                                 | Amharic                                                  |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `lot.loading`      | Loading lot…                                                            | ማቆሚያው በመጫን ላይ…                                           |
| `lot.free`         | {{count}} free                                                          | {{count}} ነፃ                                             |
| `lot.bookable`     | of {{total}} bookable slots                                             | ሊያዙ ከሚችሉ {{total}} ቦታዎች                                  |
| `lot.rate`         | {{rate}} per {{minutes}} minutes                                        | {{rate}} በ{{minutes}} ደቂቃ                                |
| `lot.overstayRate` | Overstay {{rate}} per {{minutes}} minutes                               | ከተያዘው ጊዜ በላይ፦ {{rate}} በ{{minutes}} ደቂቃ                  |
| `lot.deposit`      | Deposit {{amount}}, held for {{minutes}} minutes                        | ቅድመ ክፍያ {{amount}}፣ ቦታው ለ{{minutes}} ደቂቃ ይያዛል            |
| `lot.noDeposit`    | No deposit. Slot held for {{minutes}} minutes.                          | ቅድመ ክፍያ የለም። ቦታው ለ{{minutes}} ደቂቃ ይያዛል።                  |
| `lot.full`         | This lot is full right now. Counts update live — try again in a moment. | ይህ ማቆሚያ አሁን ሞልቷል። ቁጥሮቹ በቀጥታ ይዘመናሉ — ትንሽ ቆይተው እንደገና ይሞክሩ። |
| `lot.fullButton`   | Lot full                                                                | ማቆሚያው ሞልቷል                                               |
| `lot.book`         | Book a slot                                                             | ቦታ ያስይዙ                                                  |
| `lot.call`         | Call the lot · {{phone}}                                                | ለማቆሚያው ይደውሉ · {{phone}}                                  |

### Book (27)

| Key                               | English                                                                                                                                   | Amharic                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `book.howLong`                    | How long?                                                                                                                                 | ለምን ያህል ጊዜ?                                                                                    |
| `book.minutes`                    | {{count}} min                                                                                                                             | {{count}} ደቂቃ                                                                                  |
| `book.plate`                      | Plate (optional)                                                                                                                          | ታርጋ (አማራጭ)                                                                                     |
| `book.plateLabel`                 | Vehicle plate                                                                                                                             | የተሽከርካሪ ታርጋ                                                                                    |
| `book.totalMinutes`               | {{count}} minutes                                                                                                                         | {{count}} ደቂቃ                                                                                  |
| `book.depositNow`                 | {{amount}} deposit now, the rest on exit                                                                                                  | አሁን {{amount}} ቅድመ ክፍያ፣ ቀሪው ሲወጡ                                                                |
| `book.payOnExit`                  | Pay on exit. No deposit.                                                                                                                  | ሲወጡ ይከፍላሉ። ቅድመ ክፍያ የለም።                                                                        |
| `book.retryPrecisely`             | Retry precisely                                                                                                                           | በትክክል እንደገና ይሞክሩ                                                                               |
| `book.tooFar`                     | You are about {{distance}} m away. This lot only holds slots within {{limit}} m.                                                          | ከዚህ ማቆሚያ {{distance}} ሜትር ያህል ይርቃሉ። ይህ ማቆሚያ ቦታ የሚይዘው በ{{limit}} ሜትር ውስጥ ላሉ ብቻ ነው።              |
| `book.tooFarServer`               | You are {{distance}} m away. This lot only holds slots within {{limit}} m.                                                                | ከዚህ ማቆሚያ {{distance}} ሜትር ይርቃሉ። ይህ ማቆሚያ ቦታ የሚይዘው በ{{limit}} ሜትር ውስጥ ላሉ ብቻ ነው።                  |
| `book.needBetterFix`              | Your position is accurate to about {{accuracy}} m, which is not precise enough this close to the limit. Step into the open and try again. | የአካባቢዎ ትክክለኛነት {{accuracy}} ሜትር ያህል ነው፤ ለገደቡ ይህን ያህል ሲቀርቡ በቂ አይደለም። ወደ ክፍት ቦታ ወጥተው እንደገና ይሞክሩ። |
| `book.stale`                      | Your last position is too old to trust.                                                                                                   | የመጨረሻው አካባቢዎ ለመታመን በጣም የቆየ ነው።                                                                 |
| `book.locationServicesOff`        | Location is switched off. Turn it on to book a slot.                                                                                      | የአካባቢ አገልግሎት ጠፍቷል። ቦታ ለማስያዝ ያብሩት።                                                              |
| `book.locationDenied`             | ላቁም? needs your location to confirm you are close enough to this lot.                                                                     | ላቁም? ከዚህ ማቆሚያ በቂ ቅርበት ላይ መሆንዎን ለማረጋገጥ አካባቢዎን ይፈልጋል።                                            |
| `book.locationBlocked`            | Location permission is blocked. Allow it in Settings to book.                                                                             | የአካባቢ ፈቃድ ታግዷል። ቦታ ለማስያዝ በቅንብሮች ውስጥ ይፍቀዱ።                                                      |
| `book.locationPreciseTimeout`     | A precise position did not arrive in time. Step into the open, away from buildings, and try again.                                        | ትክክለኛ አካባቢ በጊዜ አልደረሰም። ከሕንፃዎች ርቀው ወደ ክፍት ቦታ ይውጡ እና እንደገና ይሞክሩ።                                 |
| `book.locationNotFound`           | Your position could not be found. Step outside and try again.                                                                             | አካባቢዎ ሊገኝ አልቻለም። ወደ ውጭ ወጥተው እንደገና ይሞክሩ።                                                        |
| `book.locationNotConfirmed`       | Your position could not be confirmed. Try again.                                                                                          | አካባቢዎ ሊረጋገጥ አልቻለም። እንደገና ይሞክሩ።                                                                 |
| `book.button.holding`             | Holding your slot…                                                                                                                        | ቦታዎን በመያዝ ላይ…                                                                                  |
| `book.button.precise`             | Getting a more precise location…                                                                                                          | ይበልጥ ትክክለኛ አካባቢ በማግኘት ላይ…                                                                      |
| `book.button.checking`            | Checking your location…                                                                                                                   | አካባቢዎን በማረጋገጥ ላይ…                                                                              |
| `book.button.locationNeeded`      | Location needed to book                                                                                                                   | ለማስያዝ አካባቢዎ ያስፈልጋል                                                                             |
| `book.button.locationUnavailable` | Location unavailable                                                                                                                      | አካባቢ አይገኝም                                                                                     |
| `book.button.hold`                | Hold this slot                                                                                                                            | ይህን ቦታ ያስይዙ                                                                                    |
| `book.button.notPrecise`          | Location not precise enough                                                                                                               | አካባቢው በቂ ትክክለኛ አይደለም                                                                           |
| `book.button.tooFar`              | Too far from this lot                                                                                                                     | ከዚህ ማቆሚያ በጣም ይርቃሉ                                                                              |
| `book.button.tooOld`              | Location too old to use                                                                                                                   | አካባቢው ለመጠቀም በጣም የቆየ ነው                                                                         |

### Booking (30)

| Key                          | English                                                                                                                   | Amharic                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `booking.loading`            | Loading your booking…                                                                                                     | የቦታ ማስያዣዎ በመጫን ላይ…                                                                      |
| `booking.titleFallback`      | Your booking                                                                                                              | የእርስዎ ቦታ ማስያዣ                                                                           |
| `booking.clockUnsynced`      | Times are approximate until the app reaches the server.                                                                   | መተግበሪያው ከሰርቨሩ ጋር እስኪገናኝ ድረስ ሰዓቶቹ ግምታዊ ናቸው።                                              |
| `booking.checking`           | Checking with the server…                                                                                                 | ከሰርቨሩ ጋር በማረጋገጥ ላይ…                                                                     |
| `booking.overstay`           | You are over your booked time. Overstay is charged at a higher rate.                                                      | ከተያዘልዎ ጊዜ አልፈዋል። ከተያዘው ጊዜ በላይ መቆየት በከፍተኛ ዋጋ ይከፈላል።                                      |
| `booking.payDeposit`         | Pay deposit {{amount}}                                                                                                    | ቅድመ ክፍያ {{amount}} ይክፈሉ                                                                 |
| `booking.payDepositNoAmount` | Pay deposit                                                                                                               | ቅድመ ክፍያ ይክፈሉ                                                                            |
| `booking.showAtGate`         | Show this at the gate                                                                                                     | ይህን በመግቢያው ላይ ያሳዩ                                                                       |
| `booking.readCode`           | Or read the code above to the attendant.                                                                                  | ወይም ከላይ ያለውን ኮድ ለማቆሚያው ሠራተኛ ያንብቡ።                                                       |
| `booking.findAnother`        | Find another slot                                                                                                         | ሌላ ቦታ ይፈልጉ                                                                              |
| `booking.navigate`           | Navigate                                                                                                                  | አቅጣጫ ያግኙ                                                                                |
| `booking.noMapsApp`          | No maps app could be opened. The lot is at {{coordinates}}.                                                               | የካርታ መተግበሪያ ሊከፈት አልቻለም። ማቆሚያው የሚገኘው {{coordinates}} ላይ ነው።                              |
| `booking.extend`             | Extend by {{minutes}} minutes                                                                                             | በ{{minutes}} ደቂቃ ያራዝሙ                                                                   |
| `booking.extendBlock`        | Extend by one block                                                                                                       | በአንድ የጊዜ ክፍል ያራዝሙ                                                                       |
| `booking.pay`                | Pay {{amount}}                                                                                                            | {{amount}} ይክፈሉ                                                                         |
| `booking.cancel`             | Cancel booking                                                                                                            | ቦታ ማስያዣውን ይሰርዙ                                                                          |
| `status.PENDING_PAYMENT`     | Pay the deposit to hold your slot.                                                                                        | ቦታዎን ለማስያዝ ቅድመ ክፍያውን ይክፈሉ።                                                              |
| `status.RESERVED`            | Your slot is held. Drive to the lot.                                                                                      | ቦታዎ ተይዟል። ወደ ማቆሚያው ይንዱ።                                                                 |
| `status.CHECKED_IN`          | You are parked.                                                                                                           | መኪናዎን አቁመዋል።                                                                            |
| `status.OVERSTAY`            | Your booked time is up.                                                                                                   | ያስያዙት ጊዜ አልቋል።                                                                          |
| `status.CHECKED_OUT`         | You have left the lot. Pay to finish.                                                                                     | ከማቆሚያው ወጥተዋል። ለመጨረስ ይክፈሉ።                                                               |
| `status.PAID`                | Paid. Thank you for parking.                                                                                              | ተከፍሏል። ስለቆሙ እናመሰግናለን።                                                                   |
| `status.EXPIRED`             | This hold expired and the slot was released.                                                                              | የቦታ ማስያዣው ጊዜ አልፎበታል፤ ቦታው ተለቋል።                                                          |
| `status.CANCELLED`           | You cancelled this booking and the slot was released.                                                                     | ይህን ቦታ ማስያዣ ሰርዘዋል፤ ቦታው ተለቋል።                                                            |
| `timer.timeLeftToPay`        | Time left to pay                                                                                                          | ለመክፈል የቀረው ጊዜ                                                                           |
| `timer.slotHeldFor`          | Slot held for                                                                                                             | ቦታው የሚቆየው                                                                               |
| `timer.timeRemaining`        | Time remaining                                                                                                            | የቀረው ጊዜ                                                                                 |
| `timer.overBy`               | Over by                                                                                                                   | ያለፈው ጊዜ                                                                                 |
| `deposit.notStarted`         | Your slot is held while you pay, but the payment service could not be reached. Tap Pay deposit before the timer runs out. | እስኪከፍሉ ድረስ ቦታዎ ተይዟል፣ ነገር ግን የክፍያ አገልግሎቱን ማግኘት አልተቻለም። ሰዓቱ ከማለቁ በፊት «ቅድመ ክፍያ ይክፈሉ»ን ይጫኑ። |
| `deposit.unavailable`        | The payment service could not be reached. Your slot is held until the timer runs out. Try again in a moment.              | የክፍያ አገልግሎቱን ማግኘት አልተቻለም። ሰዓቱ እስኪያልቅ ድረስ ቦታዎ ተይዟል። ትንሽ ቆይተው እንደገና ይሞክሩ።                 |

### Bill (checkout) (9)

| Key                    | English                                                        | Amharic                                         |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `checkout.loading`     | Loading your bill…                                             | ሂሳብዎ በመጫን ላይ…                                   |
| `checkout.paidTitle`   | Paid                                                           | ተከፍሏል                                           |
| `checkout.paidBody`    | Thank you. Your booking is settled.                            | እናመሰግናለን። ሂሳብዎ ተዘግቷል።                           |
| `checkout.done`        | Done                                                           | እሺ                                              |
| `checkout.amountDue`   | Amount due                                                     | የሚከፈለው መጠን                                      |
| `checkout.parkedFrom`  | Parked from {{time}}                                           | ከ{{time}} ጀምሮ ቆመዋል                              |
| `checkout.bookedUntil` | Booked until {{time}}                                          | እስከ {{time}} ተይዟል                               |
| `checkout.cashHint`    | You can also pay the attendant in cash. Ask them to record it. | ለማቆሚያው ሠራተኛ በጥሬ ገንዘብም መክፈል ይችላሉ። እንዲመዘግቡት ይጠይቁ። |
| `checkout.pay`         | Pay {{amount}}                                                 | {{amount}} ይክፈሉ                                 |

### Errors (every screen) (28)

| Key                                 | English                                                                                                   | Amharic                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `errors.VALIDATION_ERROR`           | The app sent something the server could not accept. Try again, and if it keeps happening, update the app. | መተግበሪያው ሰርቨሩ ሊቀበለው ያልቻለውን ነገር ልኳል። እንደገና ይሞክሩ፤ ችግሩ ከቀጠለ መተግበሪያውን ያዘምኑ። |
| `errors.OTP_INVALID`                | That code is not correct. Check the SMS and try again.                                                    | ኮዱ ትክክል አይደለም። ኤስኤምኤሱን አይተው እንደገና ይሞክሩ።                                |
| `errors.OTP_EXPIRED`                | That code has expired. Request a new one.                                                                 | ኮዱ ጊዜው አልፎበታል። አዲስ ኮድ ይጠይቁ።                                            |
| `errors.UNAUTHENTICATED`            | Your session has ended. Sign in again.                                                                    | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ።                                              |
| `errors.FORBIDDEN`                  | This account cannot do that.                                                                              | ይህ መለያ ይህን ማድረግ አይችልም።                                                 |
| `errors.NOT_FOUND`                  | That could not be found. It may have been removed.                                                        | አልተገኘም። ተወግዶ ሊሆን ይችላል።                                                 |
| `errors.SLOT_TAKEN`                 | That slot was just taken. Try again.                                                                      | ያ ቦታ አሁን ተይዟል። እንደገና ይሞክሩ።                                             |
| `errors.LOT_FULL`                   | This lot is full right now. Try again in a moment.                                                        | ይህ ማቆሚያ አሁን ሞልቷል። ትንሽ ቆይተው እንደገና ይሞክሩ።                                 |
| `errors.STATE_CONFLICT`             | This booking changed in the meantime. The screen shows it as it is now.                                   | ይህ ቦታ ማስያዣ በመሃል ተቀይሯል። ገጹ አሁን ያለበትን ሁኔታ ያሳያል።                          |
| `errors.OUTSTANDING_BALANCE`        | Pay for your previous booking before booking again.                                                       | እንደገና ከማስያዝዎ በፊት የቀደመውን ቦታ ማስያዣ ይክፈሉ።                                  |
| `errors.SLOT_IN_USE`                | That slot is in use.                                                                                      | ያ ቦታ በጥቅም ላይ ነው።                                                       |
| `errors.ILLEGAL_TRANSITION`         | That is not possible for this booking now.                                                                | ይህ አሁን ለዚህ ቦታ ማስያዣ አይቻልም።                                              |
| `errors.ALREADY_HAS_ACTIVE_BOOKING` | You already have an active booking.                                                                       | ንቁ የቦታ ማስያዣ አለዎት።                                                      |
| `errors.ALREADY_PAID`               | This is already paid.                                                                                     | ይህ አስቀድሞ ተከፍሏል።                                                        |
| `errors.PAYMENT_AMOUNT_MISMATCH`    | The payment did not match the amount due. Ask the attendant for help.                                     | ክፍያው ከሚከፈለው መጠን ጋር አልተዛመደም። የማቆሚያውን ሠራተኛ ይጠይቁ።                         |
| `errors.PAYMENT_NOT_CONFIRMED`      | The payment has not been confirmed yet.                                                                   | ክፍያው ገና አልተረጋገጠም።                                                      |
| `errors.PAYMENT_PENDING`            | A payment is still in progress. Wait a moment and check again.                                            | ክፍያ በሂደት ላይ ነው። ትንሽ ቆይተው እንደገና ያረጋግጡ።                                  |
| `errors.TOO_FAR`                    | You are too far from this lot to book a slot.                                                             | ቦታ ለማስያዝ ከዚህ ማቆሚያ በጣም ይርቃሉ።                                            |
| `errors.RATE_LIMITED`               | Too many attempts. Wait a few minutes and try again.                                                      | በጣም ብዙ ሙከራዎች። ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።                               |
| `errors.OTP_TOO_MANY_ATTEMPTS`      | Too many wrong codes. Request a new code.                                                                 | በጣም ብዙ የተሳሳቱ ኮዶች። አዲስ ኮድ ይጠይቁ።                                         |
| `errors.INTERNAL`                   | Something went wrong on the server. Try again.                                                            | በሰርቨሩ ላይ ችግር ተፈጥሯል። እንደገና ይሞክሩ።                                        |
| `errors.PROVIDER_UNAVAILABLE`       | The payment service could not be reached. Try again in a moment.                                          | የክፍያ አገልግሎቱን ማግኘት አልተቻለም። ትንሽ ቆይተው እንደገና ይሞክሩ።                         |
| `errors.NETWORK`                    | Cannot reach the server. Check your connection and try again.                                             | ሰርቨሩን ማግኘት አልተቻለም። ግንኙነትዎን አረጋግጠው እንደገና ይሞክሩ።                          |
| `errors.BAD_RESPONSE`               | The server sent a response this version of the app does not understand. Update the app.                   | ሰርቨሩ ይህ የመተግበሪያ ስሪት የማይረዳውን ምላሽ ልኳል። መተግበሪያውን ያዘምኑ።                    |
| `errors.UNKNOWN`                    | Something went wrong. Try again.                                                                          | ችግር ተፈጥሯል። እንደገና ይሞክሩ።                                                 |
| `errors.field.vehiclePlate`         | Check the plate number: up to 32 letters, digits and dashes.                                              | የታርጋ ቁጥሩን ያረጋግጡ፦ እስከ 32 ፊደሎች፣ ቁጥሮች እና ሰረዞች።                            |
| `errors.field.phone`                | Enter your phone number with the country code, for example +251911234567.                                 | ስልክ ቁጥርዎን ከአገር ኮድ ጋር ያስገቡ፤ ለምሳሌ +251911234567።                         |
| `errors.field.code`                 | Enter the 6-digit code from the SMS.                                                                      | በኤስኤምኤስ የደረሰዎትን ባለ 6 አሃዝ ኮድ ያስገቡ።                                      |

## Payment return page (2)

The page Chapa sends a driver to after its checkout, served by the API from
`apps/api/src/payments/returnPage.ts` (not a locale file: the API has no
i18n bundles). Both languages are always shown, Amharic first.

| Key     | English                                                                                                          | Amharic                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `title` | Return to the ላቁም? app                                                                                           | ወደ ላቁም? መተግበሪያው ይመለሱ                                                                |
| `body`  | You can close this page. The app checks your payment with the payment service and shows whether it went through. | ይህን ገጽ መዝጋት ይችላሉ። መተግበሪያው ክፍያዎን ከክፍያ አገልግሎቱ ጋር አረጋግጦ ክፍያው መፈጸሙን ወይም አለመፈጸሙን ያሳይዎታል። |

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
- **The return page must not say the payment succeeded.** Anyone can open
  it, so it only sends the driver back to the app, which checks. A
  translation reading "your payment was received" would be wrong.
- **Register: DECIDED, polite everywhere.** Please check the converted
  dashboard strings read naturally, especially the short button labels
  (ይቃኙ, ያስገቡ, ያስወጡ), where the informal form may be what attendants
  expect to see on a button.
- **Driver app, "deposit"** is **ቅድመ ክፍያ** ("advance payment") throughout.
  If drivers know it by another word, it changes in six places.
- **Driver app, "overstay"** is **ከተያዘው ጊዜ በላይ** ("beyond the reserved
  time"). The dashboard's slot label says **ጊዜ አልፏል**; check they read as
  the same idea.
- **Times are 24-hour international time in both languages** (e.g. 14:05).
  The Ethiopian clock counts from 6 a.m., so "8:05" could be read two ways.
  Whether Amharic screens should show Ethiopian time is a product decision,
  not a translation one.
- **`errors.*` in the driver app** are written for a driver, not an
  attendant; the dashboard has its own `error.*` for staff.
- Technical terms deliberately left in English: **QR**, **HTTPS**,
  **localhost**. Confirm that is right rather than transliterating.
- Verb forms: see "Register" at the top. The informal forms this list
  used to describe (አስገባ, አስወጣ, ቃኝ) are gone from both apps.
