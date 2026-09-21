# ላቁም? (Laqum)

Real-time parking for Addis Ababa.

Drivers use a mobile app to find nearby parking lots, see live free-slot counts,
book a slot with a small deposit, navigate there, and check in and out with a QR
code. Parking attendants use a web dashboard that shows each lot as a grid of
top-down car slots coloured by live status, register walk-in cars, scan QR codes
at entry and exit, and record cash.

## Status

**Phase 0 (foundation) complete.** The monorepo, database schema, health
endpoints and CI are in place. The API surface, payments, realtime, dashboard
and mobile app follow in Phases 1–5.

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
