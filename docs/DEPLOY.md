# Deploying ላቁም?

How to put Laqum on a server in Ethiopia, keep it backed up, and update it.
Written for whoever runs the server: SSH and basic Docker are enough.

The whole stack is one Compose file, `docker-compose.prod.yml`, on one
server. What runs where:

| Piece                  | Where                                | Reachable from outside                                       |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Caddy (`web`)          | the server                           | yes: 80 and 443 only                                         |
| Attendant dashboard    | built into the Caddy image           | yes, through Caddy                                           |
| API (`api`)            | the server                           | only `/v1`, `/socket.io`, `/payment-complete`, through Caddy |
| Migrations (`migrate`) | the server, once per start           | no                                                           |
| Redis                  | the server                           | no                                                           |
| Nightly backups        | the server, copied to a second place | no                                                           |
| PostgreSQL 16          | AletCloud's managed database         | no (the server connects to it)                               |
| Driver app             | phones, built by Expo EAS            | —                                                            |

Before a real deploy, `bash deploy/smoke.sh` (on a laptop, or CI on every
push) brings this exact stack up from the production images, checks it,
backs it up, restores it, and tears it down.

## Contents

1. [Before going live](#1-before-going-live)
2. [The one-hour trial](#2-the-one-hour-trial)
3. [The server](#3-the-server)
4. [Domain and DNS](#4-domain-and-dns)
5. [Settings](#5-settings)
6. [First deploy](#6-first-deploy)
7. [The first operator, lots and attendants](#7-the-first-operator-lots-and-attendants)
8. [Chapa](#8-chapa)
9. [Push](#9-push)
10. [The driver app](#10-the-driver-app)
11. [Backups](#11-backups)
12. [Updating and rolling back](#12-updating-and-rolling-back)
13. [Logs](#13-logs)
14. [Data protection](#14-data-protection)

## 1. Before going live

These block a real launch. None of them blocks the trial or a staging
deploy.

- [ ] **SMS.** Sign-in codes are only written to the API's log
      (`ConsoleSmsProvider`); no SMS is sent. Drivers cannot sign in until a
      local SMS aggregator billed in birr is integrated (international
      gateways need a card). Until then, codes are readable by anyone who
      can read the server's logs (section 13).
- [ ] **Chapa sandbox result.** `pnpm chapa:sandbox` must be run and its
      `amount`/`charge` verdict recorded in CLAUDE.md ("Chapa integration").
      If Chapa reports amounts net of its fee, every payment is rejected.
- [ ] **Amharic strings awaiting review** (docs/AMHARIC-REVIEW.md,
      "Awaiting review"), the push notification texts among them.
- [ ] **The production app build** (section 10), with the production
      `EXPO_PUBLIC_API_URL` set on expo.dev.
- [ ] **The brand illustration's licence**, to be confirmed by the product
      owner (docs/BRAND.md).
- [ ] **Registration with the Ethiopian Communications Authority** before
      processing personal data (section 14).

## 2. The one-hour trial

Decision D1: AletCloud is the host **if** a one-hour trial shows acceptable
latency from a phone on Ethio telecom mobile data. It needs no domain and no
managed database, and AletCloud bills by the minute.

1. Create a VPS (section 3), open ports 22, 80 and 443, install Docker.
2. On the server:

   ```bash
   git clone <the repository> laqum && cd laqum
   cp deploy/.env.production.example deploy/.env.production
   ```

   In `deploy/.env.production`, for the trial only:
   - `DOMAIN=` the server's **public IP address**. Caddy then serves HTTPS
     with its own self-signed certificate (Caddy's docs: IP addresses get
     "self-signed certificates that are automatically trusted locally"),
     so browsers warn. That is expected for the trial.
   - `POSTGRES_PASSWORD=` a random value, and
     `DATABASE_URL=postgres://laqum:<that password>@postgres:5432/laqum`.
   - `PAYMENT_PROVIDER=fake`, the JWT secrets (section 5), everything else
     empty.

3. Start it with the local database:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file deploy/.env.production \
     --profile local-db up -d --build --wait
   ```

4. **Measure from Ethio telecom mobile data.** Turn Wi-Fi off on the phone
   and share its mobile data with a laptop, then from the laptop, ten times:

   ```bash
   curl -sk -o /dev/null \
     -w 'connect %{time_connect}s  tls %{time_appconnect}s  first byte %{time_starttransfer}s\n' \
     https://<server IP>/payment-complete
   ```

   `/payment-complete` is a small public page the API itself serves, so
   the time covers the phone network, Caddy and the API. Also open
   `https://<server IP>/` in Chrome on the phone (accept the warning) and
   note how long the dashboard takes to appear.

5. **Record** the ten results, the time of day, and the phone's signal
   (4G or 3G, bars) in the Phase 5 notes in CLAUDE.md. Whether they are
   acceptable is the product owner's decision.
6. Tear down, and delete the VPS if AletCloud is not chosen:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file deploy/.env.production \
     --profile local-db down -v
   ```

## 3. The server

**AletCloud** (aletcloud.com), chosen by the product owner. From the Phase 5
research on 2026-09-26; check the prices again when ordering:

- The servers are in **Ethio Telecom's Bole data centre, Addis Ababa**, which
  satisfies the storage rule in section 14.
- **Payment:** a prepaid ETB wallet, topped up by telebirr, bank transfer or
  card through Chapa; 15% VAT is added at top-up. Sign-up needs a phone
  number and no card.
- **Billing** by the minute, capped at the monthly price.
- **Pilot size:** VPS "Pro", 2 vCPU / 4 GB / 30 GB, 4,500 ETB a month; a
  public IPv4, 300; managed PostgreSQL, 150. About **4,950 ETB a month,
  5,690 with VAT**.
- **Managed PostgreSQL: choose version 16**, the version every test runs on.
- **Risk:** a young provider with no track record found; this is why the
  backups also go somewhere AletCloud does not control (section 11).

On the VPS:

- Any current Linux image with **Docker Engine and Compose v2**. If Docker is
  not preinstalled, install it from docs.docker.com for that distribution,
  then check `docker compose version`.
- Firewall: allow **22/tcp** (SSH), **80/tcp** (certificates), **443/tcp and
  443/udp** (HTTPS and HTTP/3). Nothing else. Redis and the API are never
  published.
- SSH with a key; turn off password logins.

## 4. Domain and DNS

A `.com.et` name from Ethio telecom (550 birr a year in the research above).
Before the first start, create an **A record** pointing the name at the
server's public IPv4. Caddy obtains a Let's Encrypt certificate on its own
the first time it starts, if the name resolves to the server and ports 80
and 443 are open. Let's Encrypt is free and needs no account.

The same name serves the dashboard (`https://<domain>/`), the API the app
calls (`https://<domain>/v1`), Chapa's webhook and its return page.

## 5. Settings

Everything the server needs is in **`deploy/.env.production`**, which is
never committed. Start from the example:

```bash
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
```

| Setting                                    | Value                                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| `DOMAIN`                                   | the name from section 4                                    |
| `DATABASE_URL`                             | the managed PostgreSQL 16 connection string from AletCloud |
| `POSTGRES_PASSWORD`                        | empty (only for `--profile local-db`)                      |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`  | two **different** random values (below)                    |
| `PAYMENT_PROVIDER`                         | `chapa`                                                    |
| `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET` | the LIVE keys (section 8)                                  |
| `EXPO_ACCESS_TOKEN`                        | section 9                                                  |
| `BACKUP_REMOTE`                            | section 11                                                 |

A random secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# or, without Node:
openssl rand -base64 48 | tr -d '\n=+/' ; echo
```

The Compose file sets the rest itself: `NODE_ENV=production`, `REDIS_URL`,
`TRUST_PROXY_HOPS=1` (Caddy is exactly one proxy), `PUBLIC_BASE_URL`
(`https://<DOMAIN>`) and the shutdown timeout. The API refuses to start with
a missing or malformed setting and says which one. The rate limits keep
their defaults unless set (the root `.env.example` lists every variable).

## 6. First deploy

To save typing, on the server:

```bash
alias dc='docker compose -f docker-compose.prod.yml --env-file deploy/.env.production'
```

Then:

```bash
export LAQUM_VERSION=$(git rev-parse --short HEAD)
dc up -d --build --wait
dc logs migrate          # every migration "applied"
dc ps                    # web, api, redis, backup running; api "healthy"
```

The order is enforced by Compose: `migrate` runs and must succeed; the API
starts and must answer `/ready` (it reaches PostgreSQL and Redis); only then
does Caddy start. If the migration fails, nothing new starts.

**Check it from outside** (a laptop):

| Request                                | Expect                                             |
| -------------------------------------- | -------------------------------------------------- |
| `https://<domain>/`                    | the dashboard, with a valid certificate            |
| `https://<domain>/v1/bookings/current` | 401, `UNAUTHENTICATED` (the API answers)           |
| `https://<domain>/payment-complete`    | 200, the return page                               |
| `https://<domain>/ready`               | the dashboard's page, **not** JSON with `"checks"` |

## 7. The first operator, lots and attendants

A new database is empty, and the development seed refuses to run in
production. The first admin is created in SQL. `psql` is in the backup
image, and it already has `DATABASE_URL`:

```bash
dc run --rm --entrypoint sh backup -c 'psql "$DATABASE_URL"'
```

```sql
INSERT INTO operators (name, phone) VALUES ('<operator name>', '+2519XXXXXXXX') RETURNING id;
INSERT INTO users (phone, role, full_name) VALUES ('+2519XXXXXXXX', 'operator_admin', '<name>');
```

**Sign in as that admin.** While SMS is not integrated, the code is in the
log:

```bash
curl -s -X POST https://<domain>/v1/auth/otp/request -H 'Content-Type: application/json' \
  -d '{"phone":"+2519XXXXXXXX","audience":"staff"}'
dc logs --since 5m api | grep 'code is'
curl -s -X POST https://<domain>/v1/auth/otp/verify -H 'Content-Type: application/json' \
  -d '{"phone":"+2519XXXXXXXX","code":"<code>","audience":"staff"}'
```

The last reply holds `accessToken` (valid 15 minutes). With it, **create a
lot** (the admin who creates it becomes its staff):

```bash
curl -s -X POST https://<domain>/v1/admin/lots -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' -d '{
    "operatorId": "<operators.id>",
    "name": "<lot name>", "address": "<address>",
    "latitude": 9.0100, "longitude": 38.7600,
    "contactPhone": "+2519XXXXXXXX",
    "blockMinutes": 30, "ratePerBlockSantim": 2000, "overstayRatePerBlockSantim": 4000,
    "depositAmountSantim": 2000
  }'
```

Money is in **santim** (2000 = 20.00 ETB). Omitted fields take their
defaults: a 3-minute payment window, a 15-minute hold, a 5 km booking radius
(never under 1 km). Then **its slots**, for example 3 rows of 8 labelled
A-1 onwards:

```bash
curl -s -X POST https://<domain>/v1/admin/lots/<lot id>/slots/bulk \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"zone":"main","rows":3,"cols":8,"labelPrefix":"A"}'
```

**Attendants**, added by the lot's admin (then they sign in to the dashboard
with their number):

```bash
# add (201; 200 if already there). A new number becomes an attendant.
curl -s -X POST https://<domain>/v1/admin/lots/<lot id>/attendants \
  -H "Authorization: Bearer <accessToken>" -H 'Content-Type: application/json' \
  -d '{"phone":"+2519XXXXXXXX","fullName":"<name>"}'
# list them, with their ids
curl -s https://<domain>/v1/admin/lots/<lot id>/attendants -H "Authorization: Bearer <accessToken>"
# remove one from this lot (204), by id
curl -s -X DELETE https://<domain>/v1/admin/lots/<lot id>/attendants/<userId> \
  -H "Authorization: Bearer <accessToken>"
```

A driver's or an admin's number is refused (409): the account is not
changed into an attendant. Removal is immediate: the attendant's next action
on the lot is refused, and an open dashboard stops receiving the lot's
changes. Only an admin who staffs the lot can do either.

## 8. Chapa

- **Run the sandbox check first** (section 1).
- In `deploy/.env.production`: `PAYMENT_PROVIDER=chapa`, the **live** secret
  key as `CHAPA_SECRET_KEY`, and a webhook secret as `CHAPA_WEBHOOK_SECRET`.
- In Chapa's dashboard, set the webhook URL to
  **`https://<domain>/v1/webhooks/chapa`** and its secret to the same value
  as `CHAPA_WEBHOOK_SECRET`. The API also sends that URL with every payment.
  It accepts only the `x-chapa-signature` header, an HMAC of the body
  (CLAUDE.md, "Chapa integration").
- Nothing to set for the return page: every payment sends
  `https://<domain>/payment-complete`.
- Refunds the operator owes (a double payment, a payment that landed after
  expiry) are listed at `GET /v1/admin/refunds`.

## 9. Push

Push goes from the API to **Expo's push service**, which hands it to
**Firebase Cloud Messaging** for Android. Firebase's free Spark plan needs no
card. No `google-services.json` is ever committed: EAS gets it as a file
variable.

1. **Firebase project.** At console.firebase.google.com, create a project
   (Analytics can be off). It stays on the Spark plan.
2. **Android app.** Add an Android app with package name exactly
   **`et.laqum.driver`** and download its `google-services.json`. Keep it
   out of the repository (`.gitignore` excludes it).
3. **Service account key.** Firebase → Project settings → Service accounts →
   Generate New Private Key → Generate Key. This file is a real secret.
4. **Give the key to Expo.** On expo.dev: Project settings → Credentials →
   Android → `et.laqum.driver` (or Add Application Identifier) → Service
   Credentials → FCM V1 service account key → Add a service account key →
   Save. Or `eas credentials` → Android → Google Service Account → "Manage
   your Google Service Account Key for Push Notifications (FCM V1)" →
   upload.
5. **`google-services.json` for the build.** On expo.dev, add a **File**
   environment variable named exactly **`GOOGLE_SERVICES_JSON`** holding the
   file from step 2, in the **development** environment, and in
   **production** when that build is made. Use "Sensitive" visibility, not
   "Secret" (Expo: secret variables are not readable during some config
   resolution). During the build Expo writes the file outside the project
   and puts its path in the variable; `app.config.ts` reads it. Without it a
   build has no FCM, and the app reports push as unavailable.
6. **Push security.** On expo.dev/settings/access-tokens, turn on enhanced
   push security and create an access token. Put it in
   `deploy/.env.production` as `EXPO_ACCESS_TOKEN` (and in a developer's
   `.env` to test). Once it is on, Expo refuses every send without it
   (`UNAUTHORIZED`), so a leaked device token cannot be used to message a
   driver.
7. **Build** the app (section 10). That build also carries the icon, the
   splash and the notification icon. On the phone: DEVICE-TEST step 23.

What the API sends and when is in CLAUDE.md, "Push: the code". Only a
sentence, the lot's name, a time or amount, and a booking id leave the
country (section 14).

## 10. The driver app

Built by **Expo EAS** (free tier, no card), from `apps/mobile`:

```bash
eas build --profile <profile> --platform android
```

**The production build** is `eas build --profile production --platform
android`. It is an **APK with internal distribution**: EAS gives a link to
install it from, and drivers install it directly, because Google Play
registration needs a card.

Before it, on expo.dev, set **`EXPO_PUBLIC_API_URL`** to
`https://<domain>/v1` in the **production** environment, with "Plain text"
or "Sensitive" visibility (a "Secret" variable is not readable when the
config is resolved). The profile names that environment explicitly: without
it, EAS would use "preview" for an internal build. **A production build
without the variable, or with an `http://` address, is refused** with a
message saying so (`apiUrlFor` in `app.config.ts`): production allows no
cleartext HTTP, and the development fallback, `localhost`, would reach
nothing.

The `development` profile is for device testing against a laptop
(docs/DEVICE-TEST.md) and must not be distributed.

iOS is out while the App Store needs a card.

## 11. Backups

Every night at 02:00 Addis Ababa time (`BACKUP_AT_UTC=23:00`), the `backup`
service writes a `pg_dump` into the `backups` volume on the server, keeps
`BACKUP_KEEP_DAYS` (14) days of them, and **copies each one to
`BACKUP_REMOTE`**, the second location in Ethiopia that does not depend on
AletCloud (decision D1). Without `BACKUP_REMOTE` it warns in its log every
night and the dump exists on the server only.

**The second location:** any machine in Ethiopia reachable over SSH with
`rsync` installed, for example a small machine at the operator's office or
another Ethiopian host. On it, create a user and a directory for the dumps.
Then, on the server:

```bash
ssh-keygen -t ed25519 -N '' -f deploy/secrets/backup_key
# put deploy/secrets/backup_key.pub in that user's ~/.ssh/authorized_keys there
ssh-keyscan -t ed25519 <host> > deploy/secrets/backup_known_hosts
# compare that fingerprint with the one the machine itself shows:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   (on the machine)
```

and set `BACKUP_REMOTE=<user>@<host>:<directory>`. The host key is pinned: a
changed key stops the copy rather than sending the data somewhere else.

**A dump is not a backup until it has been restored.** After the first
deploy, and then every month:

```bash
dc run --rm backup now                                  # a dump now
mkdir -p restore
dc run --rm --entrypoint sh -v "$PWD/restore:/out" backup \
  -c 'cp "$(ls -1t /backups/laqum-*.dump | head -1)" /out/'
bash deploy/restore-check.sh restore/laqum-*.dump       # needs Docker
rm -rf restore
```

`restore-check.sh` restores into a throwaway PostgreSQL 16 and checks the
migrations, the row counts and the index that forbids double bookings. It
touches nothing else. Once a month, run it on a dump **from the second
location** too: that is the copy that matters if the provider goes.

**A real restore** (the database is lost):

1. Create a new, empty PostgreSQL 16 database.
2. Restore the newest dump into it, from the server or the second location:

   ```bash
   docker run --rm -v "$PWD/restore:/in" postgres:16.15-alpine \
     pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname='<new DATABASE_URL>' /in/laqum-<stamp>.dump
   ```

3. Set `DATABASE_URL` to the new database and `dc up -d`. The migrations
   find themselves already applied.

Scheduled jobs live in Redis, not in the dump. A lost hold expiry or
overstay is caught within a minute by the sweeper; a lost reminder
notification is not sent.

## 12. Updating and rolling back

```bash
dc run --rm backup now                    # always, before an update
git pull
export LAQUM_VERSION=$(git rev-parse --short HEAD)
dc up -d --build --wait
dc logs migrate
```

The images are tagged with the commit, so the previous ones stay on the
server. The API shuts down gracefully: open requests and running jobs finish,
realtime clients reconnect on their own.

**Migrations are forward-only** (CLAUDE.md): there is no "migrate down".
Rolling back therefore means running the previous images against the
**current** schema:

```bash
export LAQUM_VERSION=<previous commit>
dc up -d --no-build
```

That is safe when the update only added to the schema, which is the rule
for migrations here. When it is not, fix forward with a new release; as a
last resort, restore the pre-update dump into a new database (section 11),
accepting that anything written since is lost.

## 13. Logs

```bash
dc logs -f api                 # follow the API
dc logs --since 1h api         # the last hour
dc logs backup                 # last night's backup
```

Docker keeps them on the server (10 files of 10 MB per service) and sends
them nowhere. Every API line carries the request's id (`reqId`), which the
API also returns in the `X-Request-Id` header, so a complaint about one
request leads to its lines. Phone numbers are masked (`+251******567`);
tokens and payment signatures are removed.

**While SMS is console-only, sign-in codes appear in these logs.** Anyone
who can read them can sign in as anyone. Keep access to the server to the
people who run it.

## 14. Data protection

Ethiopia's **Personal Data Protection Proclamation No. 1321/2024**, in force
since its publication on 24 July 2024 (Art. 70). Laqum stores drivers' and
attendants' phone numbers, names, plates and booking history. This is a
reading for the product owner, not legal advice.

- **Art. 22(1): storage in Ethiopia.** "Every data controller or data
  processor shall ensure the storage, on a server or data center located in
  Ethiopia, of personal data collected or obtained locally." Hence AletCloud
  in Addis Ababa, the managed database there, and the second backup location
  in Ethiopia. Hosts payable in birr whose servers are abroad were ruled out
  for this reason.
- **Art. 20: transfer abroad** needs adequate protection. What crosses the
  border, deliberately kept to a minimum:
  - **push notifications**, through Expo (US) and Google's FCM: a sentence,
    the lot's name, a time or an amount, a booking id and the device's push
    token; never a phone number, a name or a plate (tested);
  - **map tiles**, fetched by the phone from OpenFreeMap: the phone's
    address and the area it views, no account;
  - **app builds** on EAS: source code only, no user data.
- **Art. 33(1): registration.** A data controller must be registered with the
  Authority, which Art. 2 defines as the **Ethiopian Communications
  Authority**, before processing personal data.
- **Art. 43: breaches** must be reported to the Authority within **72
  hours**.

Sources consulted (2026-09-26): the proclamation's text,
metaappz.com/References/ethiopian_laws/federal/pr_1321_2024; summaries by
Dablo Law Firm, Legal500, Mondaq, BELEX and CIPIT (Strathmore University).
