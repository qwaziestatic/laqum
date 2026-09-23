# Phase 4 device test — Android

Everything in this document needs your phone. Nothing here is covered by the
automated suite, and I have **not** verified any of it. Where I expect
something to work, I say "should"; where I genuinely do not know, I say so.

**Your device is Android, so iOS is untested.** The iOS configuration is
present and valid (bundle identifier, usage strings, plugins) but has never
been built or run. Do not treat it as working.

---

## Part 0 — What I need from you, and when

| #   | I need                                                           | When                                             |
| --- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1   | You to create an Expo account                                    | Before step 2                                    |
| 2   | You to run `eas login` on this machine, or paste an `EXPO_TOKEN` | Step 2 — **this is the only point I am blocked** |
| 3   | A Google Maps Android API key                                    | Step 3 (the map is blank without it)             |

I cannot create the account or log in for you: it needs your email and a
password I must never hold.

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

Also put your Google Maps Android key into `apps/mobile/app.json` →
`android.config.googleMaps.apiKey`. Without it the map renders blank grey —
that is a missing key, not a bug in the app.

> The key is currently the placeholder `REPLACE_WITH_GOOGLE_MAPS_ANDROID_KEY`
> and is committed as such. **Do not commit your real key.** If you would
> rather not hold it in the repo at all, tell me and I will move it to an
> `app.config.ts` reading an env var.

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

| Symptom                    | Likely cause                                        |
| -------------------------- | --------------------------------------------------- |
| Times out                  | Firewall (step 2), or client isolation on the Wi-Fi |
| "Connection refused"       | API not running, or bound to 127.0.0.1 only         |
| Works on laptop, not phone | Different networks, or a VPN active on either       |

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

### 11. The three location gate branches

This is the amendment you asked for, and it is the hardest thing to test —
you need to physically move.

| Where to stand                                | Should show                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Inside or beside a seeded lot                 | **Hold this slot** enabled                                                                       |
| Several km away (e.g. at home)                | "You are about _N_ m away. This lot only holds slots within _R_ m."                              |
| Indoors near the edge of the radius, poor GPS | "Your position is accurate to about _N_ m, which is not precise enough this close to the limit." |

The seeded lots are **Bole Medhanialem** (9.0092, 38.7869) and **Piassa
Central** (9.0348, 38.7508), each with a 200 m radius by default.

_The middle branch is the one I most want confirmed_ — the third may be hard
to produce deliberately. If you cannot trigger it, say so rather than
guessing; the logic is unit-tested but the real-accuracy behaviour is not.

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

- **11** — the middle and third gate branches, on real GPS.
- **15** — which fallback tier actually fires without Google Maps.
- **16** — whether the phone's screen brightness and QR size are enough for a
  camera to read it at arm's length. This is the one I would bet on failing
  first, and it is a size/contrast fix if so.
- **13** — whether Android's clock change behaves as I expect through
  `performance.now()`.
