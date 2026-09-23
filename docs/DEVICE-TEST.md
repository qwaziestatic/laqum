# Phase 4 device test — Android

Everything in this document needs your phone. Nothing here is covered by the
automated suite, and I have **not** verified any of it. Where I expect
something to work, I say "should"; where I genuinely do not know, I say so.

**Your device is Android, so iOS is untested.** The iOS configuration is
present and valid (bundle identifier, usage strings, plugins) but has never
been built or run. Do not treat it as working.

---

## Part 0 — What I need from you, and when

| #                                                                        | I need                                                           | When                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1                                                                        | You to create an Expo account                                    | Before step 2                                    |
| 2                                                                        | You to run `eas login` on this machine, or paste an `EXPO_TOKEN` | Step 2 — **this is the only point I am blocked** |
| I cannot create the account or log in for you: it needs your email and a |
| password I must never hold.                                              |

---

## Part 1 — Before you touch the phone

### 1. Start the backend on your machine

```bash
pnpm infra:up
pnpm db:migrate up
pnpm db:seed
pnpm --filter @laqum/api dev
```

Leave it running. It listens on **:3000**.

### 1a. Seed a test lot where YOU are

The seeded lots are in Addis. If you are not, arrival, live distance, the
location gate and the countdowns cannot be tested at all — so seed a lot at
your own coordinates instead.

Get your coordinates from any maps app (long-press your location → it shows
`lat, lng`), then:

```bash
SEED_TEST_LOT_LAT=51.5072 SEED_TEST_LOT_LNG=-0.1276 pnpm db:seed
```

It prints a confirmation line:

```
Seeded 3 lots with 78 slots. Times display in Africa/Addis_Ababa.
TEST LOT at 51.5072, -0.1276 — 150 m radius, 5 min blocks, 3 min hold.
```

The test lot is deliberately **impatient and small**, so a whole cycle fits in
one session rather than half an hour:

|                    | Test lot                                           | Seeded Addis lots        |
| ------------------ | -------------------------------------------------- | ------------------------ |
| Block              | **5 min**                                          | 30 min                   |
| Hold before expiry | **3 min**                                          | 15 min                   |
| Slots              | **6** (T-1…T-3, U-1…U-3)                           | 48 and 24                |
| Booking radius     | **150 m** (override with `SEED_TEST_LOT_RADIUS_M`) | 200 m                    |
| Deposit            | none                                               | Bole 20 ETB, Piassa none |

Pick the radius so that **walking one block flips the gate** — 80–150 m is
usually right. That is what makes test 11 possible.

> **It cannot run in production.** `testLotFromEnv` throws if `NODE_ENV` is
> production, independently of the seed script's own guard, and refuses a
> coordinate that is empty, unparseable, or out of range rather than silently
> placing the lot at 0,0. Eleven tests cover those refusals.

Where the script below says "a seeded lot", use **TEST LOT (device testing)**
if you seeded one.

### 2. Find your machine's LAN address

**This is the single most common reason a device build looks "offline".**
`localhost` on the phone means _the phone_, not your laptop.

```powershell
ipconfig | Select-String "IPv4"
```

Take the `192.168.x.x` address on the adapter your Wi-Fi uses. Call it
`<LAN-IP>`.

Check the API answers on it **from your machine first**:

```bash
curl http://<LAN-IP>:3000/health
```

If that fails, the phone has no chance. Windows Firewall is the usual cause —
allow inbound TCP 3000 for Node on **Private** networks:

```powershell
New-NetFirewallRule -DisplayName "Laqum API dev" -Direction Inbound `
  -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
```

### 3. Put that address into the build

Edit `apps/mobile/eas.json` → `build.development.env.EXPO_PUBLIC_API_URL`:

```json
"EXPO_PUBLIC_API_URL": "http://<LAN-IP>:3000/v1"
```

### 3a. Cleartext HTTP — already handled, and here is the evidence

The dev API is plain `http://` on a LAN address. **Android 9 (API 28) defaults
`usesCleartextTraffic` to false**, so a build that did not opt in would fail
every request with "Network request failed" and look exactly like a firewall
problem.

This does **not** rely on a debug-only default. `app.config.ts` sets it
explicitly via `expo-build-properties`, keyed off `EAS_BUILD_PROFILE`, and I
verified the generated manifest both ways with `expo prebuild`:

| Profile       | Generated `AndroidManifest.xml`        |
| ------------- | -------------------------------------- |
| `development` | `android:usesCleartextTraffic="true"`  |
| `production`  | `android:usesCleartextTraffic="false"` |

There is no `networkSecurityConfig` in the manifest — the attribute alone
carries it. **Production is explicitly false**, so the allowance cannot reach
a shipped build.

You can confirm it yourself before building:

```bash
cd apps/mobile
EAS_BUILD_PROFILE=development pnpm exec expo prebuild --platform android --no-install --clean
grep -o 'android:usesCleartextTraffic="[a-z]*"' android/app/src/main/AndroidManifest.xml
rm -rf android   # prebuild output is disposable and gitignored
```

> iOS gets the equivalent `NSAllowsLocalNetworking`, also excluded from
> production. **iOS is untested.**

---

## Part 2 — Build the APK

### 4. Log in to EAS ← **I am blocked until this is done**

```bash
cd apps/mobile
pnpm exec eas login
```

### 5. Link the project

```bash
pnpm exec eas init
```

This writes a real `projectId` into `app.json`, replacing
`REPLACE_AFTER_EAS_INIT`. **Push notifications cannot register without it** —
`getExpoPushTokenAsync` needs the project id, which is why step 12 depends on
this.

### 6. Build

```bash
pnpm exec eas build --profile development --platform android
```

Takes roughly 10–20 minutes on Expo's free tier. It ends with a URL and a QR
code. The `development` profile produces an **APK** (not an AAB) with
`developmentClient: true`, so it can be installed directly and can talk to a
Metro dev server.

---

## Part 3 — Install on the phone

### 7. Allow installs from unknown sources

Android blocks this by default, per-app rather than globally since Android 8:

1. Open the EAS build link in **Chrome** on the phone and download the APK.
2. Tap the downloaded file. Android will say _"For your security, your phone
   isn't allowed to install unknown apps from this source."_
3. Tap **Settings** on that prompt → enable **Allow from this source**.
4. Press back. Tap the APK again → **Install**.

If Play Protect warns about an unrecognised app, choose **Install anyway** —
this is an unsigned internal build, so the warning is expected.

### 8. Connect the phone to the SAME Wi-Fi as your machine

Not mobile data. Not a guest network — guest networks usually have client
isolation on, which blocks phone→laptop traffic entirely and looks exactly
like the app being broken.

**Check from the phone before launching the app:** open Chrome and visit

```
http://<LAN-IP>:3000/health
```

You should see JSON. If you do not, fix that before going further:

| Symptom                                                                                            | Likely cause                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Times out                                                                                          | Firewall (step 2), or client isolation on the Wi-Fi                                                                                                                                                                                                                                                                                         |
| "Connection refused"                                                                               | API not running, or bound to 127.0.0.1 only                                                                                                                                                                                                                                                                                                 |
| Works on laptop, not phone                                                                         | Different networks, or a VPN active on either                                                                                                                                                                                                                                                                                               |
| **Chrome on the phone reaches `/health`, but the APP says "Network request failed" on every call** | **Cleartext HTTP blocked.** Chrome has its own policy and will happily load `http://`; the app is governed by `usesCleartextTraffic`. Means the APK was built from the `preview` or `production` profile, or `EAS_BUILD_PROFILE` was unset in a way that resolved to production. Rebuild with `--profile development` and re-check step 3a. |
| Map is blank grey, everything else works                                                           | Missing or unrestricted Google Maps key (step 3a/3b) — not a network fault                                                                                                                                                                                                                                                                  |

---

## Part 4 — The tests

For each: **what to do**, then **what should happen**. Report anything that
differs, including wording that reads badly.

### 9. Sign in

1. Launch **ላቁም?**.
2. Enter `+251911000002` (the seeded driver). Tap **Send code**.
3. Read the 6-digit code from the **API terminal** — the console SMS provider
   prints it as a `warn` line. There is no real SMS.
4. Enter it. Tap **Sign in**.

_Should:_ the map home appears.
_Also check:_ force-quit and relaunch — you should land on the map, **not**
the login screen. That proves the token survived in the Keystore.

### 10. Location permission and the map

1. On first launch the app asks for location.
2. **Deny it.**

_Should:_ you still see the lot list, with a banner saying distances are
estimated. The app must not be unusable.

3. Grant it via the banner's **Open settings**, return to the app.

_Should:_ distances appear, and your blue dot is on the map.

### 10a. The map itself — MapLibre + OpenFreeMap

The map no longer uses Google. It is MapLibre drawing OpenFreeMap tiles: **no
API key, no account, no card**. That also means it is a free public service
with **no uptime guarantee**, so a blank map is a state the app has to survive
rather than a fault.

**This is the part I could not verify at all.** MapLibre is native code — it
draws nothing in a bundle check, and there is no Android SDK on this machine,
so the native compile happens for the first time on EAS. Please look carefully.

1. Look at the map area on the home screen.

_Should:_ real streets, water and place labels — not a plain grey rectangle.

2. Pinch to zoom and drag to pan.

_Should:_ smooth, and more detail appears as you zoom in.

3. Find the lot pins.

_Should:_ a coloured circle per lot showing its **free count** — green when
slots are free, red when full. Tapping one opens that lot.

4. Check the credit line directly under the map.

_Should:_ **`OpenFreeMap © OpenMapTiles Data from OpenStreetMap`**, always
visible. This is a licence requirement, not decoration. Tapping it should open
openstreetmap.org/copyright.

5. Switch the phone to dark mode (Settings → Display) and return.

_Should:_ the map switches to a dark tile style — genuinely different tiles,
not the light map dimmed — and stays legible. The credit line stays visible.

6. Turn mobile data and Wi-Fi WAN off, or put the phone on a network with no
   internet, while keeping the API reachable.

_Should:_ the map goes blank, and **everything else keeps working** — the lot
list, booking, the countdown. The map is never allowed to block the app.

> If the map is blank at step 1 with working internet, check
> `https://tiles.openfreemap.org/styles/positron` in the phone's browser
> first: that separates "OpenFreeMap is down" from "our map code is broken",
> and they need completely different fixes.

### 11. The three location gate branches

This is the amendment you asked for, and it is the hardest thing to test —
you need to physically move.

With the test lot from step 1a this becomes practical: stand at the
coordinates you seeded, then walk.

| Where to stand                                                           | Should show                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| At the test lot's coordinates                                            | **Hold this slot** enabled                                                                       |
| Well outside the radius — walk 300 m, or use an Addis lot from elsewhere | "You are about _N_ m away. This lot only holds slots within _R_ m."                              |
| Just past the radius edge, indoors, poor GPS                             | "Your position is accurate to about _N_ m, which is not precise enough this close to the limit." |

If you did not seed a test lot, the Addis lots are **Bole Medhanialem**
(9.0092, 38.7869) and **Piassa Central** (9.0348, 38.7508), 200 m radius.

_The middle branch is the one I most want confirmed_ — the third may be hard
to produce deliberately. If you cannot trigger it, say so rather than
guessing; the logic is unit-tested but the real-accuracy behaviour is not.

A quick way to force the third branch: seed with a very small radius
(`SEED_TEST_LOT_RADIUS_M=30`) and stand indoors about 30–40 m away, where a
phone's accuracy is typically 20–50 m and therefore straddles the limit.

### 12. Book, and the push prompt

1. From a lot page tap **Book a slot**.
2. Pick a duration. Tap **Hold this slot**.

_Should:_ you land on the booking screen with a countdown and a QR code.
_Should:_ **only now** does Android ask about notifications — not at launch.
That timing is deliberate.

3. Allow notifications.

_Should:_ nothing visible happens. Check the API terminal or the database:

```bash
docker exec laqum-postgres-test-1 psql -U laqum -d laqum \
  -c "select user_id, expo_push_token from push_tokens;"
```

A row should exist. **Phase 4 only registers the token — no notification is
ever sent.** Delivery is Phase 5.

> If `push_tokens` is empty, the most likely cause is step 5 not having been
> run, so there is no EAS project id.

> With the test lot the hold is **3 minutes**, so you can watch it run out.
> Let it expire and check the slot is released on the dashboard.

### 13. The countdown against a wrong clock

The interesting one.

1. With a booking held, note the countdown.
2. Android **Settings → System → Date & time** → turn **off** "Set time
   automatically" → move the clock **forward one hour**.
3. Return to the app.

_Should:_ the countdown is **unchanged**. It runs on server time, not the
phone's.

4. Turn automatic time back on.

### 14. Backgrounding

1. With a booking held, switch to another app for two minutes.
2. Return.

_Should:_ the countdown shows the correct _lower_ value immediately — it
refetches on foreground rather than resuming from where it paused.

### 15. Navigate

1. Tap **Navigate** on the booking screen.

_Should:_ Google Maps opens with directions to the lot's coordinates.

2. If you can, test without Google Maps: disable it in Android Settings →
   Apps → Google Maps → Disable, then tap **Navigate** again.

_Should:_ either another maps app offers to open, or Chrome opens the Maps
website. If **nothing** opens you should see the coordinates on screen with a
message. _I have not verified which of the three happens on your device_ —
the ordering is unit-tested, the device behaviour is not.

3. Re-enable Google Maps.

### 16. The QR at the gate — the real loop

This needs the dashboard open too.

1. On your machine: `pnpm --filter @laqum/dashboard dev`, sign in as the
   attendant (`+251911000001`).
2. On the phone, open your held booking to show the QR.
3. On the dashboard, tap **Scan** and point the tablet/laptop camera at the
   phone.

_Should:_ the booking checks in, and the slot turns **occupied** on the
dashboard within a second.
_Should:_ the phone's screen moves to the parked state with a time-remaining
countdown — without you touching it.

4. If the camera cannot read it, use **Type code** and the 6-character code
   under the QR. That is a supported path, not a failure.

### 17. Extend, check out, pay

1. On the phone, tap **Extend**.

_Should:_ the remaining time grows by one block.

2. On the dashboard, check the car out.

_Should:_ the phone shows an amount due and a **Pay** button.

3. Tap **Pay**.

_Should:_ an in-app browser opens Chapa's **test** checkout.

> The seeded lots use `PAYMENT_PROVIDER=fake` by default, so this may not
> reach Chapa at all. If you want the real sandbox, set
> `PAYMENT_PROVIDER=chapa` and `CHAPA_SECRET_KEY` before step 1. **The Chapa
> sandbox has never been run — it is still an open item from Phase 2.**

### 18. Session revocation

1. While signed in on the phone, on your machine revoke the refresh token:

```bash
docker exec laqum-postgres-test-1 psql -U laqum -d laqum \
  -c "update refresh_tokens set revoked_at = now();"
```

2. On the phone, pull to refresh or navigate between screens until the access
   token expires (15 minutes), or restart the app.

_Should:_ you are returned to sign-in with "Your session has ended. Sign in
again." — not a crash, and not a silent blank screen.

---

## Part 5 — Report back

For each numbered test: pass, fail, or could-not-test. Screenshots help most
for anything that looks wrong rather than broken.

I am particularly unsure about:

- **10a** — the whole map. MapLibre's native code has never been compiled or
  run; EAS builds it for the first time. Tiles rendering at all is the single
  biggest unknown in this pass.

- **11** — the middle and third gate branches, on real GPS.
- **15** — which fallback tier actually fires without Google Maps.
- **16** — whether the phone's screen brightness and QR size are enough for a
  camera to read it at arm's length. This is the one I would bet on failing
  first, and it is a size/contrast fix if so.
- **13** — whether Android's clock change behaves as I expect through
  `performance.now()`.
