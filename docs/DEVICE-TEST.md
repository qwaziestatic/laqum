# Phase 4 device test — Android

Everything in this document needs your phone. Nothing here is covered by the
automated suite. Where I expect something to work, I say "should"; where I
genuinely do not know, I say so.

**The first pass is done** (2026-09-24/25, Samsung Galaxy A15 5G, Android 16):
every numbered test passed once the bugs it found were fixed. The results,
those bugs and their commits, and what was not device-tested are in
[Part 6](#part-6--results-of-the-first-pass). The steps below are kept as
they have to be run, including what the first pass taught.

Things checkable without the phone (how the build loads its code, where the
API URL comes from, what the dev launcher shows, the syntax of every command)
were checked against the installed packages and are marked **verified**.

**Your device is Android, so iOS is untested.** The iOS configuration is
present and valid (bundle identifier, usage strings, plugins) but has never
been built or run. Do not treat it as working.

---

## Part 0 — What I need from you, and when

| #   | I need                                                                                                          | At step |
| --- | --------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `PORT=18000` in your `.env`: Windows has reserved 3000 on this machine                                          | 1       |
| 2   | The native PostgreSQL service stopped while you test. It holds port 5432                                        | 1       |
| 3   | A Wi-Fi network you control, in Windows' **Private** profile                                                    | 2       |
| 4   | `eas login` as **dagi-dev**. I cannot do this: it needs your password, which I must never hold                  | 4       |
| 5   | The project ID of the existing project **@dagisha-dev-works/laqum**. I write it into `app.config.ts` and commit | 5       |

Nothing in this document creates an Expo account or an Expo project.

## Shells and terminals

Every command block is labelled with the shell it needs and the folder to run
it in.

- **Git Bash**: anything using `VAR=value command`, `set -a`, a `\` line
  continuation, `curl` or `grep`. PowerShell rejects the first three, and in
  Windows PowerShell 5.1 `curl` is a different program.
- **PowerShell**: the `Get-Net…` queries and every `eas` command. `eas` asks
  interactive questions (password, keystore), so it gets a real Windows
  console.
- **PowerShell (Administrator)**: the PostgreSQL service, the network profile
  and the firewall rule. Start menu → type PowerShell → right-click → **Run as
  administrator**.

Three Git Bash windows stay open for the whole pass. Use a fourth one at the
repo root for one-off commands.

| Window | Folder        | Runs          | From step |
| ------ | ------------- | ------------- | --------- |
| A      | repo root     | the API       | 1         |
| B      | `apps/mobile` | Metro         | 8a        |
| C      | repo root     | the dashboard | 16        |

**Nothing in the repo reads `.env` by itself.** A Git Bash window that runs
the API or a `db:` script must load it first. Without it, they stop with
`DATABASE_URL is not set` (verified). **Git Bash**, repo root:

```bash
set -a; . ./.env; set +a
```

Metro does not need this. It reads its own file (step 3).

---

## Part 1 — Before you touch the phone

### 1. Ports, then start the backend

#### Ports Windows can take away

**Windows can reserve ports out from under the dev stack, and on this machine
that includes 3000 and 8081.** Hyper-V/WinNAT reserves blocks of ports from
the TCP _dynamic_ range, and the blocks move on every boot. Here that range
starts at **1024** (the Windows default is 49152), so any port from 1024 to
15000 can be reserved. On 2026-09-24 the block 2983–3082 covered the API's
3000, and binding it failed with `EACCES` (verified).

So this pass uses ports **above 15000**, which Windows cannot reserve:

|           | Port      | Set in                                                |
| --------- | --------- | ----------------------------------------------------- |
| API       | **18000** | `PORT` in the repo-root `.env`                        |
| Metro     | **18081** | `RCT_METRO_PORT` in `apps/mobile/.env.local` (step 3) |
| Dashboard | 5173      | its Vite config; only checked here                    |

Set the API port. **Git Bash**, repo root:

```bash
sed -i 's/^PORT=.*/PORT=18000/' .env
grep '^PORT=' .env
```

Check the ports are free and not reserved. Do this **after every reboot**,
since the reserved blocks move. **PowerShell**:

```powershell
$ranges = netsh interface ipv4 show excludedportrange protocol=tcp |
  Select-String '^\s*(\d+)\s+(\d+)' |
  ForEach-Object { ,@([int]$_.Matches[0].Groups[1].Value, [int]$_.Matches[0].Groups[2].Value) }
foreach ($p in 18000, 18081, 5173) {
  $hit = $ranges | Where-Object { $p -ge $_[0] -and $p -le $_[1] }
  $busy = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  "{0,5}: {1}, {2}" -f $p, $(if ($hit) { "RESERVED ($($hit[0])-$($hit[1]))" } else { 'not reserved' }), $(if ($busy) { 'in use' } else { 'free' })
}
```

_Should:_ `not reserved, free` for all three. The dashboard's 5173 is inside
the reservable range. If it ever shows `RESERVED`, tell me before step 16.

#### Port 5432

**A native PostgreSQL 18 is installed on this machine and holds port 5432.**
Docker publishes the dev database on 5432 too. But connections to
`localhost`, `127.0.0.1` and `::1` all reach the native server and fail with
`password authentication failed for user "laqum"` (verified). The automated
tests use port 55432, which is why they never noticed.

See what is listening. **PowerShell**:

```powershell
Get-NetTCPConnection -LocalPort 5432 -State Listen |
  Select-Object LocalAddress, @{n='Process';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```

Only `com.docker.backend` should be listed. A `postgres` line is the
`postgresql-x64-18` Windows service. Stop it for the pass. **PowerShell
(Administrator)**:

```powershell
Stop-Service postgresql-x64-18
```

It starts automatically, so stop it again after a reboot. The "Afterwards"
section turns it back on.

#### Start the backend

In window A. **Git Bash**, repo root:

```bash
set -a; . ./.env; set +a
pnpm infra:up
pnpm db:migrate status
pnpm db:migrate up
pnpm db:seed
pnpm --filter @laqum/api dev
```

`db:migrate status` is the port check. It should list migrations, each marked
`pending` or `applied`. If it still says `password authentication failed`,
the native server still has the port: stop and tell me. On the first pass,
with the service stopped, the Docker database answered on `localhost:5432`.

_Should:_ window A shows the line below, then `job workers started`. It
appears only once the port is really bound, and shows the address actually
bound (verified). `::` means every interface, IPv4 included.

```
INFO (…): ላቁም? API listening
    address: "::"
    family: "IPv6"
    port: 18000
```

If the port cannot be bound, the API exits at once, and window A shows
`ላቁም? API failed to start: Cannot listen on port …` with the reason and what
to do. `tsx watch` then waits for a file change instead of returning the
prompt, so that line is your signal. Fix `PORT`, then Ctrl+C and start it
again.

Leave the API running. It listens on **:18000**, on every interface.

### 1a. Seed a test lot where YOU are

The seeded lots are in Addis. If you are not, arrival, live distance, the
location gate and the countdowns cannot be tested at all. Seed a lot at your
own coordinates instead.

Get your coordinates from any maps app (long-press your location and it shows
`lat, lng`). Then, in a window other than A, since A is running the API.
**Git Bash**, repo root:

```bash
set -a; . ./.env; set +a
SEED_TEST_LOT_LAT=51.5072 SEED_TEST_LOT_LNG=-0.1276 pnpm db:seed
```

The `VAR=value command` form is bash syntax, and PowerShell rejects it.
Re-seeding is safe: the seed deletes and recreates every lot and booking.

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
| Booking radius     | **150 m** (override with `SEED_TEST_LOT_RADIUS_M`) | 5 km                     |
| Deposit            | none                                               | Bole 20 ETB, Piassa none |

Pick the radius so that **walking one block flips the gate**. 80–150 m is
usually right. That is what makes test 11 possible.

> **It cannot run in production.** `testLotFromEnv` throws if `NODE_ENV` is
> production, independently of the seed script's own guard. It also refuses a
> coordinate that is empty, unparseable, or out of range rather than silently
> placing the lot at 0,0. Eleven tests cover those refusals.

Where the script below says "a seeded lot", use **TEST LOT (device testing)**
if you seeded one.

### 2. Find your machine's LAN address, and open the firewall

**This is the single most common reason a device build looks "offline".**
`localhost` on the phone means _the phone_, not your laptop.

**PowerShell**:

```powershell
Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" | Select-Object IPAddress
```

Call that address `<LAN-IP>`. It is not always `192.168.x.x`; some networks
hand out `10.x.x.x`.

The firewall rule below applies to **Private** networks only. Check which
profile Windows gave this network. **PowerShell**:

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias, Name, NetworkCategory
```

If the Wi-Fi shows `Public` and it is a network you control (your home Wi-Fi,
or your own phone's hotspot), switch it. **PowerShell (Administrator)**:

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

**Do not do this on a campus, office or café network.** Test on one you
control instead. Shared networks usually isolate clients as well (step 8), so
they would not work anyway.

Allow inbound TCP **18000 (the API) and 18081 (Metro)**, the ports from step

1. **PowerShell (Administrator)**:

```powershell
New-NetFirewallRule -DisplayName "Laqum dev: API 18000, Metro 18081" -Direction Inbound `
  -LocalPort 18000,18081 -Protocol TCP -Action Allow -Profile Private
```

Metro's port is needed because the APK contains no JavaScript. The phone
downloads the app from Metro (step 6 explains why).

Rules from earlier versions of this document open ports this pass no longer
uses. If you created either, remove it. **PowerShell (Administrator)**:

```powershell
Remove-NetFirewallRule -DisplayName "Laqum dev: API 3000, Metro 8081" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "Laqum API dev" -ErrorAction SilentlyContinue
```

Check the API answers on that address **from your machine first**. **Git
Bash**:

```bash
curl http://<LAN-IP>:18000/health
```

_Should:_ `{"status":"ok",…}`.

If that fails, the phone has no chance.

### 3. Tell Metro that address

The development APK contains no JavaScript (step 6). The app's code **and its
config**, including the API URL, come from Metro each time the app connects.
So `EXPO_PUBLIC_API_URL` is read from **Metro's environment at the moment
Metro starts**. It is not read from `eas.json`, and not at build time.

Put it in `apps/mobile/.env.local`, which is gitignored, together with
Metro's own port from step 1. **Git Bash**, repo root:

```bash
printf 'EXPO_PUBLIC_API_URL=http://<LAN-IP>:18000/v1\nRCT_METRO_PORT=18081\n' > apps/mobile/.env.local
cat apps/mobile/.env.local
```

Write the file from Git Bash. In Windows PowerShell 5.1, `>` can write
UTF-16, which Expo's env loader reads as a garbage key (verified).

`RCT_METRO_PORT` is Expo CLI's default-port setting. Expo loads this file
before it picks the port, so Metro starts on 18081 with no flag, and the QR
code and every bundle URL carry that port (verified).

How Metro resolves it. Each row was verified by starting Metro that way and
reading what it serves to the phone:

| Setup                                           | The app gets                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/mobile/.env.local`                        | the file's value                                                        |
| also exported in the Git Bash that starts Metro | the **shell's** value, which wins                                       |
| neither                                         | `http://localhost:3000/v1`, which is the phone itself: every call fails |
| only the repo-root `.env`                       | nothing. Metro reads `.env*` files from `apps/mobile` only              |

Metro reads it **once, at start**. After changing it, restart Metro: Ctrl+C in
window B, then step 8a again.

`build.development.env.EXPO_PUBLIC_API_URL` in `eas.json` is **not what the
app uses**. It only reaches the EAS build machine, which puts no JavaScript
into a development APK. Leave it alone.

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

There is no `networkSecurityConfig` in the manifest; the attribute alone
carries it. **Production is explicitly false**, so the allowance cannot reach
a shipped build.

You can confirm it yourself before building. **Git Bash**, repo root:

```bash
cd apps/mobile
EAS_BUILD_PROFILE=development pnpm exec expo prebuild --platform android --no-install --clean
grep -o 'android:usesCleartextTraffic="[a-z]*"' android/app/src/main/AndroidManifest.xml
grep -o 'android:scheme="exp+laqum"' android/app/src/main/AndroidManifest.xml
rm -rf android   # prebuild output is disposable and gitignored
cd ../..
```

The second `grep` shows the dev launcher is in the build. `exp+laqum` is the
URL scheme `expo-dev-client` registers, and the QR code in step 8a opens it.

> iOS gets the equivalent `NSAllowsLocalNetworking`, also excluded from
> production. **iOS is untested.**

---

## Part 2 — Build the APK

### 4. Install eas-cli and log in ← **I am blocked until this is done**

`eas` is not a dependency of this repo, so `pnpm exec eas` finds nothing.
Install it globally, at the version this document was checked against.
**PowerShell**:

```powershell
npm install -g eas-cli@24.7.0
eas login
eas whoami
```

`eas login` asks for **Email or username**. Enter `dagi-dev`, then your
password, then a one-time code if your account has two-factor sign-in.

_Should:_ `eas whoami` prints `dagi-dev`, then an `Accounts:` list that
includes `• dagisha-dev-works (Role: …)`. If `dagisha-dev-works` is missing,
stop: the project belongs to that organisation, and this login cannot build
it.

### 5. Link to the EXISTING project, @dagisha-dev-works/laqum

**Do not run `eas init` without `--id`. Answer no to anything that offers to
create a project.** The project already exists:

|                      | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| owner (organisation) | `dagisha-dev-works`                                     |
| slug                 | `laqum`, which matches `slug` in `app.config.ts`        |
| your login           | `dagi-dev`, a member of the organisation, not its owner |

1. **Send me the project ID.** It is on the project's page:
   <https://expo.dev/accounts/dagisha-dev-works/projects/laqum>.

2. **I edit `apps/mobile/app.config.ts` and commit:**
   - `owner: 'dagisha-dev-works'`
   - `extra.eas.projectId: '<the ID>'`, written literally. It replaces
     today's `process.env.EAS_PROJECT_ID`, and the `EAS_PROJECT_ID` line
     leaves `.env.example`.

   The ID is written literally, by decision, for three reasons:
   - `eas init --id` cannot write into a dynamic `app.config.ts`. It prints
     "Your project uses dynamic app configuration, and cannot be
     automatically modified" and stops (verified in eas-cli 24.7.0).
   - The ID is not a secret. It ships inside every APK.
   - A literal is the only form that reaches all three readers: eas-cli on
     this machine, the EAS build machine (which never sees your shell), and
     Metro, which serves it to the app for push registration.

3. **Verify.** **PowerShell**, repo root:

   ```powershell
   cd apps\mobile
   eas init --id <the ID>
   eas project:info
   ```

   _Should:_ `eas init --id` prints `Project already linked (ID: …)` and exits
   without an error. It has checked the ID's owner and slug against Expo's
   servers. `eas project:info` shows a `fullName` of
   `@dagisha-dev-works/laqum` and the same `ID`.

If `eas init` says `Project owner (…) does not match` or
`Project slug (…) does not match`, answer **no** and send me the message. It
cannot edit `app.config.ts` anyway.

If **any** `eas` command prints `EAS project not configured.`, press
**Ctrl+C**. That message means it found no ID in the config and is about to
look for, or create, a project.

### 6. Build

**PowerShell**, in `apps\mobile`:

```powershell
eas build --profile development --platform android
```

On the first build it asks **Generate a new Android Keystore?** Answer yes.
EAS creates and keeps the signing key.

It should **not** stop to ask about `expo-dev-client`. That was a real
blocker, fixed in commit `80329ae`. If it asks, stop and tell me.

It takes roughly 10–20 minutes on Expo's free tier, and ends with a URL and a
QR code.

**What this produces** (verified from the build tools' source, not assumed):

- `developmentClient: true` makes the EAS machine run `:app:assembleDebug`.
- React Native 0.86 does not bundle debug variants: "the bundle file will not
  be created". **The APK contains no JavaScript.**
- So launching it opens the **Expo dev launcher**, not ላቁም?. The launcher
  downloads the app from Metro on your machine (steps 8a and 8b). There is no
  "Load embedded bundle" button, because nothing is embedded.
- The payoff: when I fix JavaScript during the pass, you reload. Only native
  changes need a new build.

---

## Part 3 — Install and connect

### 7. Allow installs from unknown sources

Android blocks this by default, per-app rather than globally since Android 8:

1. Open the EAS build link in **Chrome** on the phone and download the APK.
2. Tap the downloaded file. Android will say _"For your security, your phone
   isn't allowed to install unknown apps from this source."_
3. Tap **Settings** on that prompt → enable **Allow from this source**.
4. Press back. Tap the APK again → **Install**.

If Play Protect warns about an unrecognised app, choose **Install anyway**.
This is an internal build, so the warning is expected.

### 8. Connect the phone to the SAME Wi-Fi as your machine

Not mobile data. Not a guest network: guest networks usually have client
isolation on, which blocks phone→laptop traffic entirely and looks exactly
like the app being broken.

**Check from the phone before launching the app.** Open Chrome and visit:

```
http://<LAN-IP>:18000/health
```

You should see JSON. If you do not, fix that before going further:

| Symptom                                                                         | Likely cause                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Times out                                                                       | Firewall rule or network profile (step 2), or client isolation on the Wi-Fi                                                                                                                                                                                                                                                                 |
| "Connection refused"                                                            | Nothing listening there: the API (step 1) or Metro (step 8a) is not running                                                                                                                                                                                                                                                                 |
| Window A shows `ላቁም? API failed to start: Cannot listen on port …`              | The API could not bind its port, and the line says why. Usually a port Windows has reserved since the last reboot: re-run the port check in step 1                                                                                                                                                                                          |
| Works on laptop, not phone                                                      | Different networks, or a VPN active on either                                                                                                                                                                                                                                                                                               |
| Launcher says "There was a problem loading the project." or "Error loading app" | The phone cannot reach Metro: Metro is not running, 18081 is missing from the firewall rule (step 2), or the `Metro:` URL has the wrong address or port (step 8a)                                                                                                                                                                           |
| The app loads, but every call fails with "Network request failed"               | Run the `apiUrl` check in step 8a first. `localhost` means step 3 did not take effect: fix it and restart Metro                                                                                                                                                                                                                             |
| **Same, but `apiUrl` is right AND Chrome on the phone reaches `/health`**       | **Cleartext HTTP blocked.** Chrome has its own policy and will happily load `http://`; the app is governed by `usesCleartextTraffic`. Means the APK was built from the `preview` or `production` profile, or `EAS_BUILD_PROFILE` was unset in a way that resolved to production. Rebuild with `--profile development` and re-check step 3a. |

### 8a. Start Metro

In window B. **Git Bash**, repo root:

```bash
cd apps/mobile
pnpm exec expo start
```

Run it in `apps/mobile`. That folder is the Expo project, and the only place
its `.env.local` from step 3 is read. Leave Metro running for the whole pass.

_Should_ (verified against Expo CLI 57.0.26):

- `env: export EXPO_PUBLIC_API_URL RCT_METRO_PORT`: it read `.env.local`.
- `Using development build`, **not** `Using Expo Go`. Expo picks this
  automatically because `expo-dev-client` is a dependency.
- A QR code, with `Scan the QR code above to open in a development build.`
- `Metro: exp+laqum://expo-development-client/?url=http%3A%2F%2F<LAN-IP>%3A18081`

**Check the address and port inside that `Metro:` line.** `%3A18081` is
`:18081`; `%3A8081` means `RCT_METRO_PORT` was not read, so fix `.env.local`
and restart. If the address is not your `<LAN-IP>` (for example a `172.x`
address belonging to the WSL/Docker adapter), press Ctrl+C and restart with
the address forced. **Git Bash**, in `apps/mobile`:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=<LAN-IP> pnpm exec expo start
```

Check what Metro will hand the app. **Git Bash**, any folder:

```bash
curl -s -H "expo-platform: android" -H "accept: application/expo+json,application/json" \
  http://localhost:18081/ | grep -oE '"(apiUrl|projectId)":"[^"]*"'
```

_Should:_ `"apiUrl":"http://<LAN-IP>:18000/v1"`, and after step 5 a non-empty
`"projectId"`. If `apiUrl` shows `localhost`, step 3 did not take effect: fix
`.env.local` and restart Metro.

Then check from **Chrome on the phone**: `http://<LAN-IP>:18081/status` should
show `packager-status:running`.

The first time it starts, Expo CLI creates `apps/mobile/expo-env.d.ts` and
`apps/mobile/.gitignore`. They are its typed-routes bookkeeping and harmless.
Leave them out of any commit during the pass.

### 8b. Connect the app to Metro

Open **ላቁም?** on the phone. It shows the **Expo dev launcher**, not the app.

The **DEVELOPMENT SERVERS** list will stay empty on a real phone. The
launcher discovers servers over mDNS, and Expo CLI only advertises itself
there when `EXPO_UNSTABLE_BONJOUR` is set (verified in both sources). What you
see instead, verified from expo-dev-launcher 57.0.20:

- "Start a local development server with: `npx expo start`. Then, select the
  local server when it appears here." Ignore the command: Metro is already
  running from step 8a.
- A URL field that starts with `http://`, and a **Connect** button
- **Fetch development servers**
- **Scan QR Code**

Connect with either:

- **Scan QR Code**, pointed at the QR in window B. The phone's own camera app
  works too, because the QR opens `exp+laqum://…`.
- Or type `<LAN-IP>:18081` after the `http://` and tap **Connect**.

_Should:_ the first load takes a while, because Metro is bundling the whole
app. Then a one-time overlay appears: "This is the developer menu. It gives
you access to useful tools in your development builds." Dismiss it, and the
sign-in screen appears.

After that:

- The server is listed under **RECENTLY OPENED**, so reconnecting is one tap.
- If a relaunch lands on the launcher, that is the dev client, not a sign-out.
  Tap the server under RECENTLY OPENED.
- To pick up a JavaScript fix from me, **shake the phone** (or long-press
  anywhere with three fingers) and choose **Reload**.

If the launcher shows **"There was a problem loading the project."** or
**"Error loading app"**, the phone cannot reach Metro. See the table in
step 8.

---

## Part 4 — The tests

For each: **what to do**, then **what should happen**. Report anything that
differs, including wording that reads badly.

### 9. Sign in

1. Launch **ላቁም?** and connect it to Metro (step 8b).
2. Enter `+251911000002` (the seeded driver). Tap **Send code**.
3. Read the 6-digit code from the **API terminal** (window A). The console SMS
   provider prints it as a `warn` line. There is no real SMS.
4. Enter it. Tap **Sign in**.

_Should:_ the map home appears.
_Also check:_ force-quit and relaunch. You should land on the map, **not** the
login screen. That proves the token survived in the Keystore. If the dev
launcher appears first, reconnect through it (step 8b). That is the dev
client, not a sign-out.

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

**Confirmed on the first pass.** MapLibre 11.4.0 compiled on EAS under the new
architecture (build `5dc39e40`, only Kotlin deprecation warnings in Expo's own
code) and rendered OpenFreeMap tiles with streets and Amharic place labels,
pins with free counts, the location dot, the attribution line, and both the
light and dark styles. Repeat it after any change to the map or its native
dependencies: a bundle check cannot see native rendering.

1. Look at the map area on the home screen.

_Should:_ real streets, water and place labels, not a plain grey rectangle.

2. Pinch to zoom and drag to pan.

_Should:_ smooth, and more detail appears as you zoom in.

3. Find the lot pins.

_Should:_ a coloured circle per lot showing its **free count**: green when
slots are free, red when full. Tapping one opens that lot.

4. Check the credit line directly under the map.

_Should:_ **`OpenFreeMap © OpenMapTiles Data from OpenStreetMap`**, always
visible. This is a licence requirement, not decoration. Tapping it should open
openstreetmap.org/copyright.

5. Switch the phone to dark mode (Settings → Display) and return.

_Should:_ the map switches to a dark tile style (genuinely different tiles,
not the light map dimmed) and stays legible. The credit line stays visible.

6. Turn mobile data and Wi-Fi WAN off, or put the phone on a network with no
   internet, while keeping the API reachable.

_Should:_ the map goes blank, and **everything else keeps working**: the lot
list, booking, the countdown. The map is never allowed to block the app.

> If the map is blank at step 1 with working internet, check
> `https://tiles.openfreemap.org/styles/positron` in the phone's browser
> first. That separates "OpenFreeMap is down" from "our map code is broken",
> and they need completely different fixes.

### 11. The three location gate branches

This is the amendment you asked for, and it is the hardest thing to test:
you need to physically move.

With the test lot from step 1a this becomes practical: stand at the
coordinates you seeded, then walk.

| Where to stand                                                          | Should show                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| At the test lot's coordinates                                           | **Hold this slot** enabled                                                                       |
| Well outside the radius: walk 300 m, or use an Addis lot from elsewhere | "You are about _N_ m away. This lot only holds slots within _R_ m."                              |
| Just past the radius edge, indoors, poor GPS                            | "Your position is accurate to about _N_ m, which is not precise enough this close to the limit." |

If you did not seed a test lot, the Addis lots are **Bole Medhanialem**
(9.0092, 38.7869) and **Piassa Central** (9.0348, 38.7508), 200 m radius.

_The middle branch is the one I most want confirmed._ The third may be hard to
produce deliberately. If you cannot trigger it, say so rather than guessing;
the logic is unit-tested but the real-accuracy behaviour is not.

A quick way to force the third branch: seed with a very small radius and stand
indoors about 30–40 m away, where a phone's accuracy is typically 20–50 m and
therefore straddles the limit. **Git Bash**, repo root, with `.env` loaded:

```bash
SEED_TEST_LOT_LAT=<lat> SEED_TEST_LOT_LNG=<lng> SEED_TEST_LOT_RADIUS_M=30 pnpm db:seed
```

### 12. Book, and the push prompt

1. From a lot page tap **Book a slot**.
2. Pick a duration. Tap **Hold this slot**.

_Should:_ you land on the booking screen with a countdown and a QR code.
_Should:_ **only now** does Android ask about notifications, not at launch.
That timing is deliberate.

> Changed after the first pass: the ask waits for a slot that is actually
> held. On a lot with a deposit (step 19) it comes once the deposit is
> confirmed, never while the payment page is open; opening an expired or
> cancelled booking never asks. On this phone notifications are already
> allowed, so the prompt cannot appear until the permission is reset (see
> CLAUDE.md's open item on how it came to be allowed; read its evidence
> BEFORE resetting).

3. Allow notifications.

_Should:_ nothing visible happens. Then look at the dev database. **Git
Bash**, any folder:

```bash
docker exec laqum-postgres-1 psql -U laqum -d laqum \
  -c "select user_id, expo_push_token from push_tokens;"
```

`laqum-postgres-1` is the **dev** database, the one the phone's API uses
(container name verified with `docker ps`). `laqum-postgres-test-1` is the
test database, which the phone never touches.

**Expect NO row on this build.** On Android, a push token comes from Firebase
Cloud Messaging, and the app has no Firebase configuration yet: there is no
`googleServicesFile` in `app.config.ts`. expo-notifications then fails with
"Unable to get Firebase Messaging instance. Did you configure
`googleServicesFile`…", and the app deliberately swallows that failure, so
nothing is shown (verified in both sources). What this step CAN still verify
is the prompt timing above. If a row does appear, my reading is wrong: tell
me.

**Phase 4 only registers the token. No notification is ever sent.** Delivery
is Phase 5.

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

_Should:_ the countdown shows the correct _lower_ value immediately. It
refetches on foreground rather than resuming from where it paused.

### 15. Navigate

1. Tap **Navigate** on the booking screen.

_Should:_ Google Maps opens with directions to the lot's coordinates.

2. If you can, test without Google Maps: disable it in Android Settings →
   Apps → Google Maps → Disable, then tap **Navigate** again.

_Should:_ either another maps app offers to open, or Chrome opens the Maps
website. If **nothing** opens you should see the coordinates on screen with a
message. _I have not verified which of the three happens on your device._
The ordering is unit-tested; the device behaviour is not.

3. Re-enable Google Maps.

### 16. The QR at the gate — the real loop

This needs the dashboard open too.

1. Start the dashboard in window C. **Git Bash**, repo root:

   ```bash
   VITE_API_TARGET=http://localhost:18000 pnpm --filter @laqum/dashboard dev
   ```

   The dashboard reaches the API through its own dev proxy, which targets
   port 3000 unless told otherwise. Without `VITE_API_TARGET` every request
   fails, because 3000 is the port Windows took (step 1). Verified: through
   the proxy, `/v1` answers exactly as the API on 18000 does.

   Open `http://localhost:5173` and sign in as the attendant
   (`+251911000001`), who is on TEST LOT's staff: enter the number, **Send
   code**, then type the code. SMS is console-only, so the code is not texted:
   it is printed in **window A**, the API's log, on a line reading
   `ConsoleSmsProvider: SMS not actually sent`. Open TEST LOT **before**
   booking: TEST LOT holds a slot for only 3 minutes.

   _(The first pass ran before the dashboard had code sign-in, and used
   dev-login with `DEV_AUTH=true` on the API. That still works, and the
   dashboard offers it below the code form only while the API has it on.
   Don't use it here: anyone who can reach port 18000 can then sign in as any
   seeded number.)_

2. On the phone, book, and keep your held booking open to show the QR.
3. On the dashboard, tap **Scan** and point the tablet/laptop camera at the
   phone. **The first pass used a laptop with no camera at all** (no imaging
   device of any class), so it went straight to step 4. The camera scan is
   still untested: see Part 6.

_Should:_ the booking checks in, and the slot turns **occupied** on the
dashboard within a second.
_Should:_ the phone's screen moves to the parked state ("You are parked."
with **Time remaining**, QR gone) without you touching it. The app POLLS
every 20 s rather than listening to the realtime channel (a P1 open item),
so allow up to 20 s.

4. If the camera cannot read it, use **Type code** and the 6-character code
   under the QR. That is a supported path, not a failure.

### 17. Extend, check out, pay

1. On the phone, tap **Extend**.

_Should:_ the remaining time grows by one block.

2. On the dashboard, check the car out.

_Should:_ the phone shows an amount due and a **Pay** button.

3. Tap **Pay**.

_Should, with the default fake provider:_ the in-app browser opens
`https://checkout.test/pay/…`, which **cannot load**: `.test` is a reserved
domain and the fake provider has no checkout page. Close it; the booking is
still unpaid. Tap **Pay** again: the API verifies the pending payment first,
the fake provider reports success, and the phone shows "Paid. Thank you for
parking." Recording cash on the dashboard settles it the same way. This is
what the first pass did.

> The API uses `PAYMENT_PROVIDER=fake` by default, so this does not reach
> Chapa at all. For the real sandbox, stop the API in window A (Ctrl+C) and restart
> it with the provider set. **Git Bash**, repo root, with `.env` loaded:
>
> ```bash
> PAYMENT_PROVIDER=chapa CHAPA_SECRET_KEY=<your sandbox key> pnpm --filter @laqum/api dev
> ```
>
> **The Chapa sandbox has never been run. It is still an open item from
> Phase 2.**

### 18. Session revocation

1. While signed in on the phone, revoke every refresh token in the dev
   database. **Git Bash**, any folder:

   ```bash
   docker exec laqum-postgres-1 psql -U laqum -d laqum \
     -c "update refresh_tokens set revoked_at = now();"
   ```

2. On the phone, pull to refresh or navigate between screens until the access
   token expires (15 minutes), or restart the app.

_Should:_ you are returned to sign-in with "Your session has ended. Sign in
again." Not a crash, and not a silent blank screen.

### 19. Deposit at booking time

Added after the first pass. The app change is JavaScript only: reload the
app, no new build. The API needs migration 004 in the dev database first. In
the fourth window. **Git Bash**, repo root:

```bash
set -a; . ./.env; set +a
pnpm db:migrate up
```

_Should:_ `004_payment_checkout_url: applied`.

TEST LOT has no deposit, so give it one. **Git Bash**, any folder:

```bash
docker exec laqum-postgres-1 psql -U laqum -d laqum \
  -c "update lots set deposit_amount_santim = 2000 where name like 'TEST LOT%';"
```

**a. Paying.** The fake provider confirms a payment as soon as it is asked,
so the deposit would settle before you could see it pending. Make it wait
two minutes. Stop the API in window A (Ctrl+C) and restart it:

```bash
FAKE_PAYMENT_DELAY_SECONDS=120 pnpm --filter @laqum/api dev
```

1. Book TEST LOT.

   _Should:_ the in-app browser opens `https://checkout.test/pay/laqum-dep-…`,
   which cannot load (see step 17). Close it. The booking screen says "Pay
   the deposit to hold your slot.", counts down **Time left to pay** from
   3:00, and shows **Pay deposit 20.00 ETB**. No QR and no **Cancel**: the
   gate cannot check in an unpaid booking, and an unpaid hold cannot be
   cancelled, only left to lapse.

2. Tap **Pay deposit**.

   _Should:_ the same page opens again (the same `laqum-dep-…` reference, not
   a new one). Close it.

3. Once two minutes have passed since booking, and before **Time left to
   pay** runs out, leave the app and come back.

   _Should:_ "Your slot is held. Drive to the lot.", with the QR and the
   **Slot held for** countdown. The app asked the provider on return; no
   webhook is involved.

**b. The payment service is down.** Point the API at a port nothing listens
on, so every call to "Chapa" is refused, as in an outage. Ctrl+C in window A,
then:

```bash
PAYMENT_PROVIDER=chapa CHAPA_SECRET_KEY=outage-test CHAPA_BASE_URL=http://127.0.0.1:9 \
  pnpm --filter @laqum/api dev
```

1. Book TEST LOT.

   _Should:_ no browser opens. The booking screen says the payment service
   could not be reached, and shows **Pay deposit** and **Time left to pay**.

2. Tap **Pay deposit**.

   _Should:_ "The payment service could not be reached. Your slot is held
   until the timer runs out. Try again in a moment."

3. Wait for the timer.

   _Should:_ at 0:00, within the 20-second refresh, "This hold expired and
   the slot was released." **Not 15 minutes later**: a payment that never
   started does not hold the slot while the provider is down.

**c. The return page.** Where Chapa sends the driver after its checkout. The
fake provider never gets there, so open it directly: in the phone's browser,
go to `http://<your LAN address>:18000/payment-complete`.

_Should:_ Amharic first, then English, telling you to close the page and go
back to the app. Ethiopic letters render as letters, not empty boxes. It
does **not** say the payment succeeded: only the app, by asking the payment
service, can say that. Adding `?status=success` to the address changes
nothing on the page.

Afterwards, restart the API without the extra variables, and remove the
deposit if you want TEST LOT as it was:

```bash
docker exec laqum-postgres-1 psql -U laqum -d laqum \
  -c "update lots set deposit_amount_santim = 0 where name like 'TEST LOT%';"
```

### 20. Realtime: changes arrive without a refresh

Added after the first pass. JavaScript only: reload the app, no new build.
The API runs normally, without step 19's extra variables. Use TEST LOT
without a deposit (step 19's "Afterwards" removes it).

The first pass saw dashboard changes on the phone only through a 20-second
poll. Now the API pushes each change to the driver's phone over the same
Socket.io server the dashboard uses, and the phone polls only while that
connection is down. So the test here is **timing**: a change should appear
within about a second, without touching the phone.

1. Book TEST LOT and stay on the booking screen. Do not touch the phone
   from here on.
2. On the dashboard, check the car in with **Type code**.

   _Should:_ within about a second the phone says "You are parked." with
   **Time remaining**. Not after up to 20 seconds.

3. On the dashboard, check the car out.

   _Should:_ within about a second, "You have left the lot. Pay to finish."
   and a **Pay** button with the amount.

4. Tap **Pay** to open the bill. Then record the cash on the dashboard.

   _Should:_ within about a second the bill screen says **Paid**, without
   a tap.

**a. After the API restarts.** Book again. Stop the API in window A
(Ctrl+C), wait 30 seconds, start it again, and wait for its "API
listening" line. Then check the car in on the dashboard.

_Should:_ the phone updates within about 10 seconds of the check-in, the
longest the app waits between reconnect attempts. It reconnected by itself
and refetched the booking.

**b. After the sign-in token expires (optional, 15 minutes).** Book, and
leave the booking screen open for 16 minutes, screen on. Then check the car
in on the dashboard.

_Should:_ the phone updates within about a second. The server closed the
socket when the 15-minute access token expired, and the app refreshed its
sign-in and reconnected. You stay signed in.

---

## Part 5 — Report back

For each numbered test: pass, fail, or could-not-test. Screenshots help most
for anything that looks wrong rather than broken.

What a pass cannot settle without the right hardware is listed in Part 6
under "Not device-tested"; look there before planning the next one.

## Afterwards

Stop windows A, B and C with Ctrl+C. Ctrl+C in Git Bash does not always
stop every node process, so make sure nothing still holds the ports, then
stop the dev database and Redis (the data volume is kept). **Git Bash**, repo
root:

```bash
pnpm dev:stop
pnpm infra:down
```

_Should:_ `pnpm dev:stop` lists 18000, 18081, 5173 and 5174, each `free` or
`<name> (pid …): stopped`. Use it too whenever a start fails with
`EADDRINUSE`.

Give port 5432 back to your own PostgreSQL. **PowerShell (Administrator)**:

```powershell
Start-Service postgresql-x64-18
```

The firewall rule only applies to Private networks, so it can stay. To remove
it: `Remove-NetFirewallRule -DisplayName "Laqum dev: API 18000, Metro 18081"`,
in **PowerShell (Administrator)**.

---

## Part 6 — Results of the first pass

**When and where.** 2026-09-24/25. Samsung Galaxy A15 5G (SM-A156L), Android
16 (SDK 36), acting as the Wi-Fi hotspot with the laptop joined to it. adb
over USB: Samsung offers wireless debugging only to a phone that is a Wi-Fi
client, not a hotspot host. EAS development build
`5dc39e40-7a1b-4fea-b6ed-a3e9f1ef4327`; API on 18000, Metro on 18081.

| Test      | Result | Notes                                                                                                                                                                                   |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8, 8a, 8b | Pass   | Connected through the dev launcher.                                                                                                                                                     |
| 9         | Pass   | Signed in; still signed in after force-quit and relaunch.                                                                                                                               |
| 10        | Pass   | Location denied: lot list with the banner, no vanishing, Book blocked with "Location needed to book"; restored through Open settings.                                                   |
| 10a       | Pass   | Tiles with Amharic labels, pins with free counts, location dot, attribution, pinch and drag, light and dark styles.                                                                     |
| 11        | Pass   | All three gate branches. need_better_fix arose naturally at 117 m with ±197 m accuracy.                                                                                                 |
| 12        | Pass   | Booking, QR, short code, hold countdown, server-side expiry shown by the app, slot released (Home back to 6 of 6). No `push_tokens` row, as expected without FCM. No prompt: see below. |
| 13        | Pass   | Countdown unchanged with the phone clock one hour forward.                                                                                                                              |
| 14        | Pass   | Backgrounded about 60 s; the countdown was right at once on return.                                                                                                                     |
| 15        | Pass   | Navigate opened Google Maps with driving directions. The fallbacks without Google Maps were not tried.                                                                                  |
| 16        | Pass   | Checked in by Type code; the slot turned occupied on the dashboard; the phone showed "You are parked." with the QR gone.                                                                |
| 17        | Pass   | Extend added 5 minutes; checked out at 15.00 ETB; paid through the fake provider.                                                                                                       |
| 18        | Pass   | Revoking the refresh tokens returned the app to sign-in with "Your session has ended". A re-seed that deleted the session did the same.                                                 |

### Bugs the pass found, all fixed

| Found at         | Symptom                                                                                                                                       | Cause                                                                                                                                  | Commit               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Preparing step 6 | `eas build` would stop; a development build could not have connected to Metro                                                                 | `expo-dev-client` was not a dependency                                                                                                 | `80329ae`            |
| Step 1           | The API logged "API listening" while nothing listened                                                                                         | Windows had reserved :3000 (`EACCES`), and Express 5's `app.listen` passes a bind error to its "listening" callback                    | `8f4cae7`, `2953d0d` |
| Idle on Home     | The app vanished, with no crash dialog                                                                                                        | Location permission re-requested on every return to the foreground; Android 16 removed the task for `rapid-activity-launch`            | `f9043e6`            |
| Home             | Refresh sat under the navigation bar                                                                                                          | Edge-to-edge is mandatory on Android 16, and no screen applied the bottom inset                                                        | `29ac8d9`            |
| Home             | The first lot list took up to 17.7 s                                                                                                          | The list waited for a fresh GPS fix; the last-known fix was there in under 0.3 s                                                       | `b91e592`            |
| Book             | Render crash: "blockMinutes must be a positive safe integer, received undefined"                                                              | The API's camelCase lot was cast into `computeBill`'s snake_case `BillableLot`                                                         | `b3f9850`            |
| Book             | "Request validation failed", with or without a plate                                                                                          | The app sent `latitude`/`longitude` where the API wants `lat`/`lng`; Extend sent `additionalMinutes` where it wants `additionalBlocks` | `305e2f7`            |
| Book             | The disabled button said "Checking your location…" with nothing running; Retry asked for the same Balanced fix                                | One label for every state that was not "proceed"                                                                                       | `a311da7`            |
| Home             | Refresh gave no visible feedback                                                                                                              | A busy button hid its label; nothing showed that new data had arrived                                                                  | `7acadfb`            |
| Booking          | An expired hold kept its countdown under "Time remaining"; raw enum status; Navigate on a finished booking; overstay stuck at "Over by 00:00" | Per-status decisions scattered through the screen; `remainingMs` clamps at zero                                                        | `0e7987b`            |

The pass also exposed gaps that were **not** fixed during it, tracked as open
items in CLAUDE.md: deposits are never initiated, the dashboard can only sign
in with dev-login (since fixed: it signs in by SMS code), the driver app polls
instead of using realtime, and it has no Amharic.

### Not device-tested

- **The camera QR scan.** The laptop has no camera, so check-in used Type
  code. Next: a tablet or phone browser on the dashboard over the mkcert HTTPS
  setup (README, "Camera access in development").
- **The Chapa sandbox.** Payment went through the fake provider only.
- **iOS.** No build has been produced.
- **Push.** Registration needs FCM credentials; delivery is Phase 5.
- **The notification prompt's timing.** No prompt appeared after the first
  booking, and Settings already showed notifications allowed. Under
  investigation: the app asks in one place only, on the booking screen, and
  only while the permission is undetermined.
- **Navigate's fallbacks** without Google Maps installed.
