# ላቁም? (Laqum) — Engineering Charter

> **[docs/BRIEF.md](docs/BRIEF.md) is the authoritative specification and must be
> read before any phase.** It is the product owner's brief, stored verbatim.
> Where this file and the brief disagree, the brief wins — except for
> deviations explicitly approved by the product owner, which are recorded here
> and marked as such. This file is the working charter; the brief is the
> contract.

Real-time parking for Addis Ababa. Drivers find nearby lots on a map, see live
free-slot counts, book a slot with a small deposit, navigate there, and check in
and out with a QR code. Attendants run a web dashboard showing each lot as a
grid of top-down car slots, register walk-ins, scan QR codes, and record cash.

**Read this file first.** It is the resume log: architecture, commands,
invariants, conventions, and every decision that is not derivable from the code.

---

## Working rules (non-negotiable)

- **Plan before code.** At the start of each phase, write a short plan (files,
  key decisions, tests) and wait for approval.
- **Stop at every checkpoint (🛑).** Do not start the next phase unsolicited.
- **Do not invent scope.** Build only what the brief specifies. If something is
  ambiguous or looks wrong, ask. Never silently "improve" the design.
- **The booking state machine and the invariants below are fixed.** Never change
  them without asking.
- **Verify, don't recall.** For library APIs, check the installed version's docs
  and types. Do not write code against APIs you are unsure exist. This has
  already paid for itself repeatedly — see "Hard-won facts" below.
- **Nothing is done until it is tested.** Run lint, typecheck and tests, and
  report the actual results, including failures.
- Commit in small logical steps with conventional commit messages.
- Secrets live only in `.env` (gitignored). `.env.example` documents every
  variable.

---

## Stack and pinned versions

Node **24 LTS (Krypton)**, pnpm **12.5.1**, TypeScript **6.0.3**, strict
everywhere. All dependencies are pinned exactly (`save-exact=true`).

| Area      | Choice                                                                                     |
| --------- | ------------------------------------------------------------------------------------------ |
| API       | Express 5.2.1, Socket.io 4.8.3 (Phase 3), BullMQ 6.3.8 (Phase 1), Kysely 0.29.6, pg 8.23.0 |
| Dashboard | Vite 8.3.0, React 19.3.0, Tailwind 4.3.3, i18next 26.4.2                                   |
| Mobile    | Expo SDK 57 (react-native 0.86.3, react 19.2.3 — Expo's pins, not the registry's)          |
| Shared    | zod 4.6.5                                                                                  |
| Testing   | Vitest 5.0.1, supertest 7.2.2, real Postgres 16 + Redis 7                                  |

### Three pins that are deliberately NOT `latest`

1. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint@8.70.0` declares
   `peerDependencies.typescript: ">=4.8.4 <6.1.0"`. TS 7 would silently cost us
   all type-aware lint rules. Revisit when typescript-eslint supports TS 7.
2. **ioredis 5.11.1, not 6.0.0.** `bullmq@6.3.8` declares
   `devDependencies.ioredis: 5.11.1` — that is the version BullMQ is actually
   tested against. Its peer range `>=5.0.0` is permissive but unproven at 6.
3. **Node 24, not the brief's Node 22.** Approved deviation. Node 22 is now
   maintenance LTS; 24 is Active LTS. Both satisfy `vitest@5`
   (`^22.12.0 || ^24 || >=26`) and `kysely@0.29` (`>=22`). Node 20 does not,
   and is end-of-life.

---

## Layout

```
apps/api/         @laqum/api        Express + Socket.io + BullMQ
apps/dashboard/   @laqum/dashboard  Vite + React attendant web app
apps/mobile/      @laqum/mobile     Expo driver app (expo-router); source-bundled by Metro
packages/shared/  @laqum/shared     types, zod schemas, state table, billing, constants
db/               @laqum/db         migrations, seed, Kysely connection + generated types
```

`db/` is a **workspace package**, which the brief's layout does not state
explicitly. It has to be: under pnpm's isolated node-linker, `db/migrations/*.ts`
cannot resolve `kysely` unless the directory owns a `package.json`. The on-disk
layout still follows the brief (`db/migrations/`, `db/seed/`).

---

## Commands

```bash
pnpm install                    # install the workspace

pnpm infra:up                   # dev postgres + redis (5432 / 6379)
pnpm test:infra:up              # test postgres + redis (55432 / 56379)
docker compose up -d --build    # full stack incl. the api container

pnpm db:migrate                 # apply migrations  (also: migrate down | status)
pnpm db:codegen                 # regenerate db/src/generated.ts
pnpm db:seed                    # deterministic dev data

pnpm lint                       # eslint, type-aware
pnpm format:check               # prettier
pnpm typecheck                  # every package, plus e2e/
pnpm build                      # topological: shared -> db/dashboard -> api
pnpm test                       # vitest; db and api tests need test:infra:up

pnpm e2e:install                # once: Playwright's Chromium
pnpm e2e                        # builds, then drives a real browser
```

Development needs **no build**: the tsx scripts resolve workspace packages
from source. `pnpm build` is for e2e, Docker and production — see
"Module resolution" below.

Test ports (55432/56379) deliberately differ from dev ports so a running dev
stack cannot collide with a test run, and a mistyped URL cannot point tests at
the dev database.

---

## THE INVARIANTS

These are the core of the system. Test every one.

1. **No double booking.** Enforced by the partial unique index
   `one_live_booking_per_slot`. Booking creation is a plain `INSERT`; a unique
   violation maps to HTTP 409 `SLOT_TAKEN`. **Never do check-then-insert in
   application code.**
2. **One live booking per driver.** Enforced by `one_live_booking_per_user`.
   Separately, the API refuses new bookings from a driver holding an unpaid
   `CHECKED_OUT` booking (`OUTSTANDING_BALANCE`), using `bookings_unpaid_by_user`.
3. **All status changes go through one function**,
   `transition(bookingId, from, to, actor, patch)`, implemented as a
   compare-and-set: `UPDATE bookings SET status = $to, ... WHERE id = $id AND
status = ANY($allowedFrom) RETURNING *`. Zero rows means someone else won the
   race → 409 `STATE_CONFLICT`. The same transaction inserts the
   `booking_events` row. **No code anywhere else may write `bookings.status`.**
   Enforced by `apps/api/test/guards.test.ts`, which greps the source; only
   `bookings/transition.ts` and `bookings/create.ts` may. Walk-in creation
   lives in create.ts for exactly this reason. `BookingPatch` also excludes
   `status` at the type level.
4. **Slot status is derived** from live bookings via the `slot_status` view.
   There is no status column on `slots`, and there must never be one.
5. **Side effects happen after commit.** Socket emits, push notifications and
   job scheduling run only after the transaction commits.
6. **Jobs are idempotent.** Every job calls `transition()`. If the booking has
   moved on, the job is a no-op.
7. **Realtime is a notification channel, not a source of truth.** Clients
   refetch a REST snapshot on connect and reconnect, then apply events. Every
   event carries the **`lotVersion`** it produced, and every snapshot carries
   the version it was read at, so clients drop stale events.

   > **Amended by the product owner.** The brief says `updated_at`. It cannot
   > work: a free slot's `updated_at` is NULL through the view's LEFT JOIN, and
   > two API instances are two unsynchronised clocks. Replaced with a
   > commit-ordered per-lot version — see "Realtime ordering" below.

### Live statuses

`PENDING_PAYMENT, RESERVED, CHECKED_IN, OVERSTAY`.

Written down in **exactly one place**: `LIVE_STATUSES` in
`packages/shared/src/enums.ts`. Derive everything from it.
`db/test/schema.test.ts` parses the four partial-index predicates out of
`pg_indexes` and asserts they match that constant, so the shared package and the
database cannot drift apart.

---

## Booking state machine (fixed)

| From                     | To                | Trigger                                           | Actor              |
| ------------------------ | ----------------- | ------------------------------------------------- | ------------------ |
| (new, app)               | `PENDING_PAYMENT` | Driver books; deposit > 0                         | driver             |
| (new, app)               | `RESERVED`        | Driver books; deposit = 0                         | driver             |
| `PENDING_PAYMENT`        | `RESERVED`        | Deposit confirmed                                 | system             |
| `PENDING_PAYMENT`        | `EXPIRED`         | Payment window lapses                             | job                |
| `RESERVED`               | `CHECKED_IN`      | Entry QR / short code scanned                     | attendant          |
| `RESERVED`               | `EXPIRED`         | Hold window lapses; deposit kept                  | job                |
| `RESERVED`               | `CANCELLED`       | Driver cancels; deposit kept                      | driver             |
| (new, walk_in)           | `CHECKED_IN`      | "Walk-in park" on a free slot                     | attendant          |
| `CHECKED_IN`             | `OVERSTAY`        | `planned_end_at` passes                           | job                |
| `CHECKED_IN`, `OVERSTAY` | `CHECKED_OUT`     | Exit scan or manual release                       | attendant          |
| `CHECKED_OUT`            | `PAID`            | Final payment succeeds, cash recorded, or due = 0 | system / attendant |

Every other transition is illegal and must be rejected with a typed error.

---

## Conventions

- **Money** is integer **santim** (1 ETB = 100 santim), in the DB and in code.
  Never floats, never numeric strings. Helpers in
  `packages/shared/src/money.ts`; a schema test asserts every `%santim%` column
  is `integer`.
- **Time** is `timestamptz` in UTC everywhere; displayed in
  `Africa/Addis_Ababa` (`DISPLAY_TIMEZONE`). A schema test asserts no naive
  timestamp column exists.
- **i18n**: Amharic and English from day one. No user-facing string is
  hard-coded. A test asserts the two bundles have identical keys, so a string
  added in English cannot ship untranslated.
- **Validation**: zod at every API boundary; request and response schemas live
  in `packages/shared` so all three apps share them.
- **DB naming stays snake_case.** No Kysely `CamelCasePlugin`: the database is
  the source of truth and a translation layer would make the introspection
  tests and the hand-written SQL disagree with the code.
- **`bookings.lot_id` has no standalone FK** to `lots`. It does not need one:
  the composite FK `(slot_id, lot_id) → slots(id, lot_id)` already guarantees a
  booking's lot is its slot's lot. This is intentional; do not "fix" it.
- **`gen_random_uuid()` needs no extension** on Postgres 16 (core since 13).

---

## Architecture decisions worth knowing

### Workspace resolution has two paths, on purpose

`@laqum/shared` and `@laqum/db` expose `"types"` pointing at TypeScript source
and `"import"` pointing at built `dist/`. So:

- **typecheck** resolves types from source — always fresh, never needs a build.
- **tests and `vite dev`** alias the packages to source (see each
  `vitest.config.ts`), so `pnpm test` does not depend on build order.
- **production** (`node dist/server.js`, the Docker image) uses `dist/`.

CI runs `pnpm -r build` _and_ `pnpm -r test`, so both paths are exercised. If
you add a workspace package, add the alias to the consuming test configs or its
imports will fail with "Failed to resolve entry for package".

`@laqum/db` builds to `dist/src/index.js` (not `dist/index.js`) because its
`rootDir` is the package root — `migrations/` and `seed/` sit beside `src/`, per
the brief's layout. Its `exports` reflect that.

### Migrations are registered explicitly

`db/src/migrator.ts` holds a hand-maintained `MIGRATIONS` record instead of
Kysely's `FileMigrationProvider`. FileMigrationProvider `import()`s absolute
paths, which throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows (`C:\...` is
read as a `c:` scheme). Development is on Windows and CI is on Linux; a
discovery mechanism that behaves differently across the two is a liability. The
explicit registry is also typechecked — a broken migration fails the build
instead of being silently skipped.

**Add new migrations to that record, in order. Never rename an existing key** —
it is the name recorded in the `kysely_migration` table.

### Migration policy: FORWARD-ONLY (decided)

**Migrations are forward-only from 002 onward.** New migrations ship an `up`
and no `down`. A mistake is corrected by a further migration, never by a
rollback.

`001_initial` keeps its `down` so the initial schema can be torn down and
rebuilt in development; that is the single exception and it is not a
precedent.

**The consequence is sharper than "there is no down method."** Kysely's
`migrateDown` runs `if (migration.down)` and, when there is none, neither
executes anything NOR deletes the row from `kysely_migration`. A forward-only
migration therefore **blocks rollback past it permanently** — repeated
`migrate down` calls are no-ops. Tearing down a development database is
`DROP SCHEMA`, not `migrate down`. `db/test/migration.test.ts` pins this, and
the CLI prints `SKIPPED (forward-only, no down migration)` so silence is never
mistaken for a successful rollback.

### Adding an enum value

`ALTER TYPE ... ADD VALUE` may run inside a transaction on PG12+, but the new
value **cannot be used in the transaction that added it** — "New enum values
must be committed before they can be used." Verified directly against PG16.
Kysely wraps each migration in a transaction, so a migration that adds a label
must not also write it. Any backfill needs its own later migration.

### db/schema.sql is the INITIAL schema only

With forward-only migrations no single file is the whole picture.
`db/schema.sql` stays the byte-for-byte reference copy of `001_initial`;
`db/test/schema.test.ts` is the authority on the CURRENT shape and asserts
001 + every migration after it.

---

## Testing

Integration tests run against a **real** Postgres and Redis. Do not mock the
database — a partial unique index is exactly the thing a mock cannot reproduce.
The same reasoning extends to failure paths: the readiness tests point at ports
nothing listens on rather than stubbing a client.

`db/test/schema.test.ts` is the proof that the migration reproduces the reviewed
DDL. It introspects `pg_enum`, `pg_constraint`, `pg_indexes` and
`information_schema` and asserts enum labels and their order, every column's
type and nullability, all nine partial index predicates verbatim, the composite
FK, the named check constraints, and the view's shape. It has been
negative-tested: deleting an index from the migration fails two assertions.

`db/test/schema-copy.test.ts` asserts `db/schema.sql` is byte-identical to the
SQL the migration executes, so the reference copy cannot drift.

---

## Hard-won facts (do not relearn these)

1. **`Migrator` is not exported from `kysely`.** Kysely 0.29 moved it to the
   `kysely/migration` subpath export. The root entry still ships deprecated stub
   types that resolve to `KyselyTypeError<"import from 'kysely/migration'
instead">`, so a wrong import fails at _runtime_ with a confusing
   "does not provide an export named 'Migrator'".
2. **Multi-statement DDL works through `sql.raw(...).execute(db)`.** Verified
   empirically against pg 8.23.0. This is why the whole reviewed schema is sent
   in one call and is byte-for-byte what Postgres receives — no SQL splitter.
3. **A refused TCP connection is an `AggregateError` with an empty `message`.**
   Node tries every resolved address and collects the failures. Reading
   `err.message` alone reported a dependency as "down" with no reason;
   `describeError` in `apps/api/src/health.ts` unwraps it and appends `err.code`.
4. **Prettier must not touch generated or reference files.** `db/src/generated.ts`
   is compared byte-for-byte by `codegen:verify`, and `db/schema.sql` by the
   copy test. Both are in `.prettierignore`. Reformatting either breaks CI.
5. **Type-aware ESLint must be scoped to `.ts`/`.tsx`.** Applying it to every
   file makes ESLint try to find `eslint.config.js` in a tsconfig and fail to
   parse it. Each package's `vitest.config.ts` must be in its tsconfig
   `include` for the same reason.
6. **Vite 8's `defineConfig` has no `test` key.** Vitest 5 needs its own
   `vitest.config.ts` (the dashboard merges the Vite config into it).
7. **pnpm 12 blocks dependency build scripts** until listed under `allowBuilds`
   in `pnpm-workspace.yaml`. `esbuild` is allowed there because tsx and Vitest
   execute its native binary; everything else stays blocked.
8. **`import.meta.main`** (Node 24) is the reliable "is this the entry module?"
   check. Comparing `process.argv[1]` to a file URL is fragile on Windows.
9. **`UPDATE ... FROM bookings old` reports a STALE previous status.** Under
   READ COMMITTED, when the update blocks on a concurrent writer Postgres
   re-checks only the TARGET row against its newest version; the joined copy
   stays on the original snapshot. `transition()` therefore locks with
   `SELECT ... FOR UPDATE` and re-reads. Verified directly against Postgres.
10. **BullMQ forbids `:` in a custom job id** — "Custom Id cannot contain :",
    because `:` is its Redis key separator. The brief specifies
    `expire-hold:{bookingId}`, so the separator is a `.` instead. See
    `JOB_ID_SEPARATOR`.
11. **BullMQ `add()` with an existing jobId is a NO-OP**, keeping the original
    delay. Rescheduling must `remove()` first, or an extension leaves the
    overstay job on the old deadline.
12. **A retained finished BullMQ job keeps its id reserved.** With
    deterministic ids that silently blocks the next schedule, so every queue
    sets `removeOnComplete`/`removeOnFail`.
13. **BullMQ needs `maxRetriesPerRequest: null`**, which is the opposite of
    what the readiness probe wants. They use separate Redis connections
    (`createQueueRedis` vs `createRedis`).
14. **zod's `.partial()` does NOT strip `.default()`.** A PATCH schema derived
    that way silently resets every defaulted field on an empty body. Update
    schemas are spelled out.
15. **`one_paid_final_per_booking` makes two successful finals IMPOSSIBLE.** A
    genuinely double-collected final therefore cannot be recorded as a second
    success. It is recorded as **`superseded`** (migration 002): collected by
    the provider, not applied to the booking, owed back. It is NOT `failed` —
    the money moved, so `failed` would make our ledger disagree with Chapa's
    settlement report. The refund queue selects on that status.
16. **Two concurrent confirms of the same tx_ref can cancel each other out.**
    One settles the row to success; the other then sees "a successful final
    exists" and would flag THAT SAME ROW as an overpayment, turning success
    back into failed. The duplicate pre-check in `settleFinal` excludes
    `payment.id` for exactly this reason. Found by the racy property test.
17. **supertest requests are LAZY.** A `Test` object does not send until
    something subscribes to it, so `const p = request(app).post(...)` followed
    by a sleep does NOT run concurrently — it runs when awaited. Race tests
    must attach `.then()` to start the request.
18. **The webhook answers 200 BEFORE processing**, so tests must wait for the
    effect rather than asserting immediately after the response.
19. **`payments.provider` is the RAIL, not the implementation.**
    FakePaymentProvider rows are `'chapa'`. Recording them as `'cash'` both
    lies and violates `cash_has_recorder`, which requires a named human.
20. **Advancing a FakeClock expires access tokens.** Tests that time-travel
    past `ACCESS_TOKEN_TTL_MINUTES` must re-issue (`reissue()` in
    test/helpers/auth.ts), which is incidental proof JWT expiry uses the
    injected clock.
21. **Express 5's `app.listen(port, callback)` passes a bind error TO THE
    CALLBACK.** It registers the callback as the server's one-shot `'error'`
    listener as well, so a failed bind runs the "listening" callback with
    the error as its argument, and Node does not throw because the error has
    a listener. The API logged "API listening" while bound to nothing, kept
    alive by Redis and BullMQ. Bind only through `listen()` in
    `apps/api/src/listen.ts`, which resolves on a real `'listening'` event.
    `guards.test.ts` forbids `.listen(` anywhere else, and
    `server-startup.test.ts` runs the real entry to prove a bind failure
    exits 1.

---

## Phase 4 note: React Native pins react EXACTLY

When `apps/mobile` is scaffolded, `react` must match the version React Native's
bundled renderer expects **exactly**. RN's renderer is built against one React
version and fails at runtime against any other; this is not an ordinary
semver-range concern, and a range that merely _satisfies_ RN's declared peer is
not sufficient. Pin `react` to precisely what the Expo SDK's bundled native
modules list specifies, and let `expo install` / `npx expo install --check`
resolve it rather than choosing a version by hand.

The dashboard is free to use a different React version — it is a separate
package with its own resolution, and nothing shares a renderer with it.

Expo also needs `node-linker=hoisted` for Metro, which does not follow pnpm's
symlinked store. Give `apps/mobile` its own `.npmrc` rather than loosening the
whole workspace.

---

## Phase roadmap

Gate on each phase's 🛑 before advancing.

- **Phase 0 — foundation.** ✅ Delivered. Monorepo, tooling, docker compose,
  env handling, initial migration, codegen + drift check, seed, CI, this file.
- **Phase 1 — API core.** ✅ Delivered. Auth (phone + OTP, rotating refresh
  tokens), lots/layout endpoints, booking creation with `FOR UPDATE SKIP
LOCKED` slot assignment, `transition()`, all staff actions, admin endpoints,
  `computeBill`, BullMQ jobs + sweeper, error model.
- **Phase 2 — payments.** ✅ Delivered. PaymentProvider interface,
  ChapaProvider (v1) incl. refunds, FakePaymentProvider, webhook + verify,
  deposit and final-payment flows, operator refund queue.
- **Phase 3 — realtime + dashboard.** ✅ Delivered. Socket.io with the Redis
  adapter, expiry-bound socket auth, commit-ordered event delivery, emits on
  every write path, and the attendant dashboard with QR scanning, plus a
  Playwright two-screen suite and screenshots.
- **Phase 4 — mobile app.** ✅ Built, **device-untested**. Expo SDK 57 driver
  app: all seven screens, secure tokens, single-flight refresh, the location
  gate, server-time countdowns, maps deep link, push token registration.
  Awaiting the device pass in [docs/DEVICE-TEST.md](docs/DEVICE-TEST.md).
- **Phase 5 — hardening.** Push notifications, rate limiting, pino request IDs,
  graceful shutdown, production Dockerfile, deployment README.

### NO INTERNATIONAL CARD — a standing constraint on every choice

The product owner has **no international payment card**. This is not a
preference to be worked around later; it rules out whole categories of
service, and any dependency that assumes one is unusable however good it is.
It is what replaced Google Maps with MapLibre + OpenFreeMap (below).

**Verified card-free and already relied on:**

- **Expo EAS Build** — free tier, no card, slower queues.
- **Firebase Spark for FCM** — no card, and Cloud Messaging is free and
  unlimited on it. (Since Feb 2026 Cloud _Storage_ requires Blaze and
  therefore a card; we use none.)
- **OpenFreeMap** — no registration, no keys, no limits.

**Known to hit the wall, unresolved:**

- **Apple App Store** ($99/yr) — no card-free route exists. iOS is already
  untested; treat it as out unless this changes.
- **Google Play** ($25 one-time) — direct APK distribution is the workaround,
  adequate for a pilot, not for public reach.
- **Twilio and every international SMS gateway.** OTP is still console-only.
  A local Ethiopian aggregator billed in birr is the only route.

### Phase 5 hosting — RESEARCH AT THE START OF PHASE 5, do not pre-decide

Constraints given by the product owner:

1. **Payment in birr** — bank transfer, Telebirr or similar. No international
   card.
2. **Prefer hosting in Ethiopia.** The system stores Ethiopian users' phone
   numbers and booking history. **Check whether Ethiopia's Personal Data
   Protection Proclamation restricts storing personal data abroad, and CITE
   the source** — this may be a legal requirement rather than a preference.
3. **Small budget** — a pilot with a few lots, not national scale.
4. **Development and staging may use a free tier abroad**, but only if it is
   **verified card-free at the time**, not assumed from an older memory.

Deliverable at the start of Phase 5: **2–3 concrete options with evidence** —
provider, how payment actually works, cost, and what the deploy looks like —
then aim the deploy README at whichever is chosen. Do not write a Heroku
guide.

### Chapa integration — the facts that matter

Every endpoint is cited in `apps/api/src/payments/chapa.ts`. **API v1**
(`api.chapa.co`, `tx_ref`), not the newer v2 (`api.chapa.global`,
`merchant_reference`) — v1 matches the brief and our `payments.tx_ref` column.

- initialize `POST /v1/transaction/initialize` — required `amount`, `currency`,
  `tx_ref`; returns `data.checkout_url`.
- verify `GET /v1/transaction/verify/<tx_ref>` — `data` carries `amount`,
  `charge`, `currency`, `status` (`failed | success | pending`).
- refund `POST /v1/refund/<tx_ref>` — optional `amount` (omit = full),
  `reason`, `reference`. **"Chapa charges are non-refundable."**

**Webhook signature: we require `x-chapa-signature` ONLY.** Chapa documents a
second header, `chapa-signature`, as an HMAC of the secret keyed by the secret
— a CONSTANT, identical on every request, which proves nothing about the body.
Chapa says either header is sufficient; accepting the constant would make any
observed webhook replayable with an attacker-chosen payload, so we don't. The
HMAC covers the RAW bytes, which is why the webhook route is mounted **before**
`express.json` in `app.ts`. Order is load-bearing.

**UNRESOLVED until the sandbox runs:** verify returns both `amount` and
`charge`, and whether `amount` is gross or net of the fee depends on the
merchant's fee settings. We compare `amount` exactly against the payments row
and never deduct `charge`. If Chapa reports net, EVERY payment would be
rejected. `pnpm chapa:sandbox` charges a known 20.00 ETB and prints
`amount`/`charge`/`currency` verbatim with a verdict. **Record the result here
before going live.**

### Realtime ordering: `lots.version`, never `updated_at`

Realtime clients must be able to tell a stale buffered event from a fresh one.
`updated_at` CANNOT do that job, for two independent reasons:

1. **A free slot has no live booking.** `slot_status` LEFT JOINs bookings, so a
   free slot's `updated_at` is NULL. A stale buffered "occupied" event carries
   a real timestamp and the snapshot row carries nothing to compare it with, so
   the stale event wins over a newer "free" snapshot — the dashboard shows a car
   that has driven away, and an attendant refuses to park someone on an empty
   space.
2. **Two API instances are two wall clocks.** They are not mutually ordered,
   however well they are synchronised.

`lots.version` (migration 003) fixes both. It is incremented **in the same
transaction as every booking status change**, so the row lock on `lots`
serialises the increments and versions come out in COMMIT order. It belongs to
the LOT, so it exists whether or not a slot has a booking.

- `bumpLotVersion` is **always acquired LAST** in every write path — after the
  booking or slot lock. Identical lock order everywhere means no cycle, hence
  no deadlock. Moving it earlier in any caller breaks that.
- `integer`, not `bigint`: `bigint` maps to a JS **string** in Kysely, which
  would put a string comparison in the middle of the ordering rule.
- **Snapshots read the version FIRST, then the rows.** A change committing
  between the two is then present in the rows but not the version, so the client
  re-applies an event whose effect is already there — idempotent. Rows first
  would fail the other way: the change missing from the rows AND covered by the
  version, so the one event that would have corrected it is discarded, and the
  slot stays wrong until its next change.
- **The client rule:** apply an event only when
  `event.lotVersion > snapshot.lotVersion`. The watermark advances to each
  applied event, so a burst all lands and a straggler is still rejected.
  `RealtimeStore.reset()` goes to **-1, not 0** — zero is a real version (a lot
  that has never had a booking).

Verified: `apps/dashboard/src/realtime/store.test.ts` **fails 6 of 11** against
a simulated `updated_at` rule, including the named free-slot test.

### Socket authorization must not outlive its basis

An HTTP request re-authorises itself on every call. A socket is authorised once
at handshake and then lives for hours, so without deliberate effort it keeps
authority long after the grounds for it are gone.

- **The socket dies with its token.** The disconnect timer is armed from the
  token's own `exp`, so a token issued 10 minutes ago dies in 5, not in 15. The
  client is sent `auth.expired` _before_ the close so it reconnects with a fresh
  token rather than treating it as a network blip and backing off.
- **`verifyAccessToken` REQUIRES `exp`.** jose only enforces an expiry claim
  that exists; a token without one would authorise a socket forever.
- **`lot_staff` is re-read on EVERY `:staff` subscribe.** Never cached at
  handshake and never remembered from a previous subscribe on the same socket.
  Reconnect is covered for free — it is a fresh handshake plus a fresh
  subscribe, and there is only one code path.
- Timers are **injected** (`realtime/timers.ts`), for the same reason the Clock
  is: the alternative is a real multi-minute sleep or a token contrived to
  expire in milliseconds.

Verified: caching membership at handshake makes exactly the named re-subscribe
test fail. The _reconnect_ variant still passes under that bug, because a
reconnect gets fresh socket data — which is why both cases are tested.

### DEV_AUTH fails closed

`POST /v1/auth/dev-login` signs in any seeded phone with no credential. It is
gated on `config.DEV_AUTH_ENABLED`, **never** on `DEV_AUTH`:

- unset ⇒ disabled (the schema default is `false`);
- only the exact string `'true'` enables it — `'1'`, `'yes'`, `'TRUE'` are a
  **startup error**, never a silent enable;
- `NODE_ENV=production` disables it regardless, and logs that it was ignored.

The route is **not registered** when disabled, so it 404s like any unknown path
— there is no guard clause that could be got wrong. `devSignIn` additionally
refuses an unknown number (it will not create an account, unlike the real OTP
flow) and reads the role from the database rather than the request.

### Emitting is structural, not remembered

`transition()` and `create.ts` — the only two functions invariant 3 lets write
`bookings.status` — record the change on their transaction via a WeakMap
(`recordSlotChange`), and `inTransaction` turns recorded changes into
SideEffects **only after the commit returns**. There is nothing for a caller to
remember, so a new write path cannot omit an emit.

`in_service` is the exception: no booking moves, so `setSlotService` bumps the
version and records the change itself. Without that, taking a slot out of
service left every open dashboard showing it free.

`emit-coverage.test.ts` iterates the `TRANSITIONS` table itself, so a new row
in the state machine becomes a new test. **Verified:** removing the
`recordSlotChange` call from `transition()` fails all 9.

### Dashboard rules that are easy to undo by accident

- **Status is never colour alone.** `statusPresentation.ts` is the single table
  giving each status a colour, a geometric glyph and a translated word; the
  type requires all three. Glyphs are geometric, NOT emoji — emoji render
  differently per platform and some Android builds ship no colour emoji font,
  so a tofu box would be worse than no glyph. Tests assert completeness,
  distinctness, and the no-emoji rule.
- **No optimistic updates.** An action sets `pending` and changes nothing. On
  `STATE_CONFLICT` or `SLOT_TAKEN` the view refetches and states what the slot
  actually is now — "conflict" alone just makes an attendant press again.
- **The drawer reads its slot from the store by id**, never a copy, so a
  realtime event cannot leave it showing actions for a state the slot has left.
- **Counters are derived** from slot rows on every change, never a running
  tally — a header that disagrees with the grid is worse than no header.
- **Resync order is subscribe-THEN-snapshot.** The reverse leaves a gap: a
  change between the read and the subscribe reaches nobody. This way the
  overlap is a duplicate, which the version rule discards.
- **Socket.io ping is 10s/5s, not the 25s/20s default.** The defaults let a
  dead connection go unnoticed for ~45s, which defeats the point of a
  connection indicator.

### Slot colours — APPROVED DEVIATION from the brief

The brief specifies **occupied = red, overstay = red-purple**. Shipped instead:
**occupied = BLUE, overstay = RED**. Reviewed and approved by the product
owner, whose reason to record is that **reserving red for "act now" is better**.

The supporting argument: occupied is the normal, expected state of a working
lot — on a busy evening most tiles are occupied, and a grid that is mostly red
trains an attendant to ignore red. Overstay is the state that costs the
operator money and needs someone to walk over, so it gets the alarm colour
alone. Different hue families also separate the two under the red-green colour
vision deficiency affecting roughly one man in twelve.

**The five colours are shared tokens**, in `packages/shared/src/palette.ts`
(`STATUS_PALETTE`), because the Phase 4 mobile app renders the same five
states and must not re-pick them:

- **Hex, not oklch.** oklch is better colour science and is what the CSS used
  first, but React Native cannot parse it. A token only one consumer can read
  is not a shared token.
- `apps/dashboard/src/index.css` mirrors the values verbatim and
  `palette.test.ts` **parses the CSS and asserts they match**, so web and
  mobile cannot drift.
- Every surface/ink pair clears **WCAG AA (4.5:1) in both themes**, asserted.
  This caught two real defects: light `occupied` was 3.68:1 (AA-large only)
  and the reconnecting chip was 2.80:1.
- Dark `occupied`/`overstay` additionally must not be near-grey (channel
  spread > 80), because a dark theme built by dimming makes exactly the two
  attention states recede.

### The connection indicator is NOT a status colour

It was green, and that was a bug: an empty lot is a field of green tiles, so a
green dot said nothing — and the connection state is the one thing an attendant
MUST notice changing, since a dashboard that has silently stopped updating
looks exactly like a quiet lot.

`live` is now an **inverted chip** — near-black on light, near-white on dark.
It is the only inverted element on the screen, so it reads against any grid,
and it is not a hue so it cannot collide with a future status colour.
`CONNECTION_PALETTE` is separate from `STATUS_PALETTE` for that reason, and a
test asserts `live` contrasts ≥3:1 against the `free` tile in both themes.
Degraded states depart from the dark chip loudly: solid orange then red, a `!`
glyph, and a pulse.

### Module resolution: TWO paths, both deliberate

Workspace packages (`@laqum/shared`, `@laqum/db`) are consumed two ways, and
`exports` is the only thing that decides which:

```json
"exports": { ".": {
  "types":       "./src/index.ts",   ← TypeScript, always source
  "development": "./src/index.ts",   ← tsx, with --conditions=development
  "import":      "./dist/...",       ← Node at runtime
  "default":     "./dist/..."        ← what production gets
}}
```

**tsx does NOT redirect bare specifiers to source.** It strips types from the
files it loads and otherwise uses Node's resolver, which honours `exports`.
Before the `development` condition existed, every tsx entry point
(`api dev`, `db migrate`, `db seed`) was silently running against `dist/` and
worked only because a build had been run at some point — they all failed on a
fresh clone. Vitest reached source solely through the explicit aliases in its
config, which is why the unit tests never noticed.

Order matters: `development` must precede `import`/`default`, because Node
takes the first matching condition. Node applies no `development` condition of
its own, so production is unaffected — only the `--conditions=development`
flag in those three scripts turns it on.

**Which path each thing exercises:**

|                                    | Path     | Why                                         |
| ---------------------------------- | -------- | ------------------------------------------- |
| `tsc`, all typechecking            | source   | `types` condition                           |
| Unit tests (vitest)                | source   | explicit aliases in the vitest configs      |
| `api dev`, `db migrate`, `db seed` | source   | `--conditions=development`                  |
| **e2e**                            | **dist** | runs `node dist/server.js` + `vite preview` |
| Docker image, production           | dist     | `import`/`default`                          |

e2e runs the COMPILED API and the BUILT dashboard on purpose: it is the last
gate before a release, so it should exercise the resolution that ships.
Otherwise the build is never exercised by a running process and a broken
`dist/` reaches production untested. `pnpm e2e` builds first so `dist` cannot
be stale; the CI job keeps its own `Build` step so a build failure reads as
one rather than as "webServer did not start".

`vite preview` does **not** inherit `server.proxy` — it has its own
`preview.proxy`. Both share one object in `vite.config.ts` so they cannot
drift.

### Phase 3 facts worth keeping

- **Windows reserves TCP ranges** for Hyper-V/WinNAT. Binding inside one fails
  `EACCES`, which reads like a permissions problem rather than "that port is
  taken". `netsh interface ipv4 show excludedportrange protocol=tcp` lists
  them. **The ranges move on every boot** (5199-5298 once; 2983-3082 on
  2026-09-24, which took the API's 3000). They come from the TCP dynamic
  range, which on the dev machine starts at 1024 (`netsh int ipv4 show
dynamicport tcp`), so ANY port from 1024 to 15000 can be taken, including
  3000, 8081, 5173 and e2e's 3100/5673. The device test therefore runs the
  API on 18000 and Metro on 18081, above that range.
- **`navigator.mediaDevices` is `undefined`** outside a secure context, not
  throwing — so the scanner feature-detects rather than catching, or an
  insecure origin would be reported as a denied permission.
- **TypeScript narrows a flag across `await`** and then `no-unnecessary-
condition` reports the re-check as dead code, even though a cleanup handler
  sets it during the await. Read such flags through a function call
  (`cancelled()`, `#isClosed()`) so the guard survives.
- **`exactOptionalPropertyTypes`** means `{ adapter: undefined }` is not the
  same as omitting `adapter`; spread conditionally instead.
- The root `db:migrate`/`db:codegen`/`db:seed` scripts pointed at `@laqum/api`,
  which has no such scripts. They were broken from Phase 0 and now target
  `@laqum/db`.

### Map stack — APPROVED DEVIATION from the brief

The brief specifies **react-native-maps with the Google provider**. Shipped
instead: **MapLibre React Native over OpenFreeMap tiles**.

**Reason: Google Maps Platform requires a billing account with an
international card, which this project does not have.** Not a preference — a
hard blocker. See "NO INTERNATIONAL CARD" above.

- `@maplibre/maplibre-react-native` **11.4.0**. Peer deps `expo >=54`,
  `react >=19.1`, `react-native >=0.80` — our 57 / 19.2.3 / 0.86.3 satisfy
  them. It is **not an Expo Module** and does **not work in Expo Go**: it
  needs a development build, which is what we already produce, and its config
  plugin `@maplibre/maplibre-react-native` must stay in `app.config.ts`.
- **v11 renamed `MapView` to `Map`**, and the style prop is `mapStyle`, not
  `styleURL`. `Marker` takes `lngLat: [longitude, latitude]` — the OPPOSITE
  order to the API's `{latitude, longitude}`, and a silent bug if swapped.
- **Tiles: OpenFreeMap.** From its README: _"There's no registration, no user
  database, no API keys, and no cookies"_ and _"no limits on the number of map
  views or requests"_. Styles are plain URLs
  (`https://tiles.openfreemap.org/styles/positron` and `/dark`).
- **No SLA.** It is free and sponsorship-funded, so a blank map is an expected
  state: the lot list never depends on it, and tiles are the only part of the
  app needing the public internet rather than just the LAN API.
- **ATTRIBUTION IS A LICENCE OBLIGATION.** `OpenFreeMap © OpenMapTiles Data
from OpenStreetMap`, rendered as permanent visible text. MapLibre's own
  `attribution` prop is a BUTTON that opens a dialog — confirmed in the
  installed source — so it does not display the credit by itself.
  `attribution.test.ts` pins the exact string and asserts no tile URL ever
  grows a `key=` or `token=`, which would mean a billing provider had crept
  in.
- **"Navigate" is unchanged** and still deep-links to Google Maps with its
  fallback chain. That needs no key and no SDK: we removed a dependency on
  Google's _platform_, not the ability to hand off to an app the driver may
  already have.

### Phase 4: the mobile facts worth keeping

**Versions are Expo's, not the registry's.** `expo install --fix` downgraded
react-native from the registry-latest **0.87.1** to the **0.86.3** SDK 57
actually bundles, and react to **19.2.3** with it. The registry's newest is
the wrong answer for an SDK-pinned app. `apps/mobile/test/resolution.test.ts`
asserts the app and react-native resolve the **same react file** — not merely
the same version string, since two copies of one version are still two
dispatchers. The workspace legitimately holds two reacts (the dashboard is on
19.3.0); pnpm's isolated linker keeps them apart.

**Metro needed exactly two settings**, each added only after a real bundle
failed without it (amendment: start from SDK 57's built-in monorepo support):

- **No** `watchFolders`, `nodeModulesPaths` or `unstable_enableSymlinks` —
  verified unnecessary by bundling with no `metro.config.js` at all.
- `resolver.unstable_conditionNames` including `development`, or
  `@laqum/shared` resolves to `dist/` and Metro demands a prior build.
- A `resolveRequest` hook mapping `./x.js` → `./x.ts`, because the shared
  source writes the `.js` specifiers Node ESM requires and Metro — unlike tsx
  and Vite — does not map them back.

**The location gate is a decision, not a threshold.** With `d` = distance,
`a` = accuracy, `r` = the lot's radius: `d + a <= r` proceed; `d - a > r`
refuse locally with the numbers; otherwise ask for a better fix. A fixed
"≤100m" rule is wrong both ways — it refuses a 120m fix taken inside the lot
and accepts a 10m fix at 95m from a 100m boundary. 60s staleness is checked
**first**, since accuracy says nothing about age.

**Countdowns never trust the device clock.** The offset comes from the `Date`
header every response already carries, and the tick runs on
`performance.now()` elapsed — so an NTP correction mid-countdown does not
double-count. On foreground the app **refetches** rather than extrapolating,
because the server may have expired the booking while the app slept.

**The push prompt waits for the first successful booking.** A denied
notification permission cannot be re-requested in-app on either platform, so
one badly-timed prompt costs the channel permanently.

**Phase 4 registers the push token; Phase 5 sends to it.** `POST
/v1/push/tokens` upserts on the token, re-pointing it at the current user — a
phone that changes hands must stop receiving the previous owner's bookings,
which is a privacy leak rather than a constraint violation.

**Cleartext HTTP is explicit, not a debug default.** The dev API is plain
http on a LAN address, and Android 9+ defaults `usesCleartextTraffic` to
false, so a build that did not opt in fails every request with "Network
request failed" — indistinguishable from a firewall problem.
`expo-build-properties` sets it from `EAS_BUILD_PROFILE`; verified against the
generated manifest: **development `"true"`, production `"false"`**, with no
`networkSecurityConfig` involved.

**The development APK carries NO JavaScript.** `developmentClient: true` makes
the EAS worker run `:app:assembleDebug`, and RN 0.86 does not bundle
debuggable variants. The app's code AND its config come from Metro when the
`expo-dev-client` launcher connects. That package was missing until it was
added deliberately; eas-cli refuses a dev-client build without it and offers
to install it mid-build. Consequences, verified by reading the manifest Metro
serves:

- `EXPO_PUBLIC_API_URL` and `extra.eas.projectId` reach the app from **Metro's
  environment when Metro starts**: `apps/mobile/.env.local`, with an exported
  shell value winning. The repo-root `.env` is not read by Metro.
- `eas.json`'s `build.development.env` never reaches the app in this build.
- On a real phone the launcher's server list stays empty: Expo CLI advertises
  over mDNS only with `EXPO_UNSTABLE_BONJOUR`. Connect by QR or typed URL.

**Nothing loads `.env`.** The API and the db scripts read `process.env` only,
so a shell must export it first (`set -a; . ./.env; set +a` in Git Bash).
The db CLI's hint "Copy .env.example to .env" is not sufficient on its own.

**`SEED_TEST_LOT_LAT`/`LNG` seed a lot where the TESTER is** — 5-minute
blocks, 3-minute hold, six slots, 150 m default radius — because arrival,
distance and the gate cannot be tested from outside Addis. `testLotFromEnv`
throws on production independently of the seed's own guard, and rejects an
empty, unparseable or out-of-range coordinate. An empty string was a real bug
the tests caught: `Number('')` is 0, which would have placed the lot in the
Atlantic and made every booking fail TOO_FAR for an unguessable reason.

### Phase 4 open items

- [ ] **The entire device pass.** [docs/DEVICE-TEST.md](docs/DEVICE-TEST.md),
      18 numbered steps. Nothing touching a camera, GPS, Keystore, Chapa's
      browser, the Maps hand-off, or push has been run.
- [ ] **Link the EXISTING Expo project `@dagisha-dev-works/laqum`** (owner
      is the organisation; `dagi-dev` is only the login). DEVICE-TEST step 5.
      **Decided:** `owner` and `extra.eas.projectId` are written LITERALLY
      in `app.config.ts`, replacing `EAS_PROJECT_ID`. `eas init --id` cannot
      write a dynamic config, and an env var would have to reach eas-cli, the
      EAS worker and Metro separately. The ID is not a secret — it ships in
      every APK. Never let eas-cli create a project: with no ID in the config
      it prints "EAS project not configured." and fetches-or-creates.
- [ ] **FCM credentials for Android push.** `getExpoPushTokenAsync` needs
      Firebase (`googleServicesFile`), which the app does not have; the call
      rejects and `src/push/expoDeps.ts` swallows it by design, so
      DEVICE-TEST step 12 expects NO `push_tokens` row. Needed before Phase 5
      can deliver anything. Firebase Spark is card-free.
- [ ] **iOS is untested.** Configuration is present and valid; no build has
      ever been produced. Device testing is Android-only by decision.

### Phase 3 open items

- [ ] **Native-speaker Amharic review.** Every string in
      [docs/AMHARIC-REVIEW.md](docs/AMHARIC-REVIEW.md) (56 keys) was written by
      a non-native speaker. **BLOCKS RELEASE. Does not block Phase 4.**
      `i18n.test.ts` guarantees key parity and non-emptiness; it cannot
      guarantee the Amharic is idiomatic, which is the point of the review.
      No known defect — `slot.free` is correctly ነፃ; an earlier report of ገባ
      was traced to the check-in verb አስገባ, which is a different key.

### Phase 2 open items

- [ ] **Run `pnpm chapa:sandbox` against the Chapa sandbox** and record the
      `amount` vs `charge` result above. Also note which signature headers the
      real service actually sends — our `x-chapa-signature`-only policy is
      stricter than Chapa's documented guidance and has not been exercised
      against the live service.

### Phase 1 open items

Deferred work, tracked so it cannot be quietly dropped. **The Phase 1 🛑
report must show this list fully ticked.**

- [x] **Extend-then-stale-overstay scenario test.** Done —
      `apps/api/test/jobs.test.ts`, "a stale overstay job after an extension".
      Extends through the real endpoint, fires the overstay handler at the
      ORIGINAL deadline, asserts `NOT_DUE`, still `CHECKED_IN`, and no phantom
      event; then asserts it still applies at the new deadline.
- [x] **`removeOnComplete` / `removeOnFail` on every queue**, with the real
      BullMQ test. Done — `DEFAULT_JOB_OPTIONS` in `apps/api/src/jobs/bullmq.ts`,
      covered by `apps/api/test/bullmq.test.ts` against real Redis, including
      "frees the deterministic id, so the same booking can be scheduled again".

### What `packages/shared` contains

Enums and `LIVE_STATUSES`, constants, money helpers, the `Clock`, the error
model, the **state-machine transition table**, **`computeBill`**, the haversine,
and the zod request/response schemas. It is imported by the browser dashboard,
so it must stay free of `node:` builtins — short-code and QR generation live in
`apps/api/src/bookings/codes.ts` for that reason.
