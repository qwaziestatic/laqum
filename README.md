# ላቁም? (Laqum)

Real-time parking for Addis Ababa.

Drivers use a mobile app to find nearby parking lots, see live free-slot counts,
book a slot with a small deposit, navigate there, and check in and out with a QR
code. Parking attendants use a web dashboard that shows each lot as a grid of
top-down car slots coloured by live status, register walk-in cars, scan QR codes
at entry and exit, and record cash.

## Status

**Phases 0–3 complete.** Foundation, API core, payments, and realtime plus the
attendant dashboard. The mobile app (Phase 4) and hardening (Phase 5) follow.

## Getting started

Requires **Node 24 LTS**, **pnpm 12** (`corepack enable`) and **Docker**.

```bash
pnpm install
cp .env.example .env

pnpm infra:up          # postgres 16 + redis 7
pnpm db:migrate        # apply the schema
pnpm db:seed           # two Addis lots, one attendant, one driver

pnpm --filter @laqum/api dev          # API on :3000
pnpm --filter @laqum/dashboard dev    # dashboard on :5173
```

No build step is needed for development: the tsx-based scripts above resolve
`@laqum/shared` and `@laqum/db` from TypeScript source via a `development`
export condition. `pnpm build` is only needed for the e2e suite, the Docker
image, and production. See CLAUDE.md, "Module resolution".

Or run the whole stack, API included:

```bash
docker compose up -d --build
curl localhost:3000/health   # liveness
curl localhost:3000/ready    # readiness: checks postgres and redis
```

## Tests

```bash
pnpm test:infra:up     # test postgres + redis on 55432 / 56379
pnpm -r test
```

Integration tests run against a real Postgres and Redis. The database is never
mocked.

### End-to-end

```bash
pnpm e2e:install       # once: downloads Playwright's Chromium
pnpm test:infra:up
pnpm e2e               # builds, starts the API and web server, runs the browser
```

The e2e suite runs the **compiled** API (`node dist/server.js`, port 3100) and
the **built** dashboard (`vite preview`, port 5673), both pointed at the
**test** database, and drives a real browser holding a real socket. It runs the
built artefacts rather than the dev servers because it is the last gate before
a release and should exercise the same module resolution production uses — so
`pnpm e2e` builds first, and the build cannot be skipped or go stale.

The two-screen test measures how long a change takes to reach a second screen
and prints it:

|       | Budget      | Why                                                                                                                              |
| ----- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local | **1000 ms** | The whole path is well under 100 ms on one machine, so a regression should fail the build.                                       |
| CI    | **5000 ms** | A shared runner's scheduler jitter is not a product defect, and a flaky e2e test gets ignored — a worse outcome than a slow one. |

Screenshots for review are written to `e2e/screenshots/` on every run, in both
themes and both languages, and are uploaded as a CI artifact.

## Camera access in development

The QR scanner needs `navigator.mediaDevices`, which the browser exposes **only
in a secure context**. `localhost` counts as secure, so the scanner works on
the development machine and then fails on a real tablet over the LAN — where
the origin is `http://192.168.x.x`. There, `navigator.mediaDevices` is not
merely restricted, it is `undefined`, which is why the code feature-detects it
rather than catching an exception: catching would report "permission denied"
for what is really a URL scheme problem.

To test the camera on the device it will actually run on, give the **dev
server** a locally-trusted certificate:

```bash
# once per machine — installs a local certificate authority
mkcert -install

# from apps/dashboard, naming every host the tablet might use
mkdir -p certs && cd certs
mkcert -key-file localhost-key.pem -cert-file localhost.pem \
  localhost 127.0.0.1 ::1 192.168.1.42
```

`vite.config.ts` picks the pair up automatically if `apps/dashboard/certs/`
exists, and runs plain http otherwise. `certs/` is gitignored.

**The API needs no certificate.** Vite proxies `/v1` and `/socket.io` to it, so
the browser only ever talks to the dashboard's origin — there is no mixed
content to block and no second certificate to trust on the tablet. The
`ws: true` flag on the `/socket.io` proxy entry is required: without it the
initial polling handshake succeeds and the WebSocket upgrade silently fails,
leaving the socket to reconnect forever with no obvious error.

On Android, the tablet must also trust the mkcert root CA — `mkcert -CAROOT`
prints its location; copy `rootCA.pem` across and install it under
**Settings → Security → Encryption & credentials → Install a certificate → CA
certificate**.

If none of that is practical, the manual short-code entry is a supported tier,
not a degraded one: it is a first-class button in the header and is what
attendants fall back to in the rain regardless.

## Layout

| Path              | Package            | What                                                    |
| ----------------- | ------------------ | ------------------------------------------------------- |
| `apps/api`        | `@laqum/api`       | Express 5 + Socket.io + BullMQ + Kysely                 |
| `apps/dashboard`  | `@laqum/dashboard` | Vite + React attendant web app                          |
| `packages/shared` | `@laqum/shared`    | types, zod schemas, constants, billing                  |
| `db`              | `@laqum/db`        | migrations, seed, Kysely connection and generated types |

`db/schema.sql` is a reference copy of the reviewed schema; the migrations in
`db/migrations/` are the source of truth, and a test asserts the two agree.

## Contributing

Read [CLAUDE.md](CLAUDE.md) first. It carries the architecture, the fixed
booking state machine, the invariants, and the decisions behind them.
