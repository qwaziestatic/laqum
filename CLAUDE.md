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
| Mobile    | Expo SDK 57 — **scaffolded in Phase 4, not before**                                        |
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
apps/mobile/      @laqum/mobile     Expo driver app — PHASE 4, does not exist yet
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
pnpm -r typecheck               # tsc --noEmit in every package
pnpm -r build                   # topological: shared -> db/dashboard -> api
pnpm -r test                    # vitest; db and api tests need test:infra:up
```

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
   event carries `updated_at` so clients can drop stale events.

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

### Migration policy is UNDECIDED beyond 001

`001_initial` ships a `down` so the up/down round-trip can be tested. That is
**not** a standing commitment that every migration ships a `down`.

**Before writing any second migration, ask the product owner** whether down
migrations are required, and record the answer here.

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
15. **Advancing a FakeClock expires access tokens.** Tests that time-travel
    past `ACCESS_TOKEN_TTL_MINUTES` must re-issue (`reissue()` in
    test/helpers/auth.ts), which is incidental proof JWT expiry uses the
    injected clock.

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
- **Phase 2 — payments.** PaymentProvider interface, Chapa test mode, fake
  provider, webhook + verify, deposit and final-payment flows.
- **Phase 3 — realtime + dashboard.** Socket.io with Redis adapter and auth,
  events after commit, the full attendant dashboard.
- **Phase 4 — mobile app.** Expo driver app against the real API.
- **Phase 5 — hardening.** Push notifications, rate limiting, pino request IDs,
  graceful shutdown, production Dockerfile, deployment README.

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
