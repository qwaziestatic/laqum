# Multi-stage build for @laqum/api.
#
# Build context is the REPO ROOT, not apps/api, because the API depends on the
# @laqum/db and @laqum/shared workspace packages:
#   docker build -f apps/api/Dockerfile .
# docker-compose.yml sets `context: .` for this reason.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# ─── deps ────────────────────────────────────────────────────────────────
# Only the manifests, so this layer is cached until a dependency changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY db/package.json db/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── build ───────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY db db
COPY apps/api apps/api
# Topological order: api imports db, db imports shared.
RUN pnpm --filter @laqum/shared build \
 && pnpm --filter @laqum/db build \
 && pnpm --filter @laqum/api build

# `pnpm deploy` resolves the workspace links into a self-contained tree and
# drops devDependencies, so the runtime image carries no TypeScript toolchain.
RUN pnpm --filter @laqum/api deploy --prod --legacy /deploy

# ─── runtime ─────────────────────────────────────────────────────────────
# Only compiled code and production dependencies: each workspace package's
# `files` is ["dist"], so no source, test or tooling reaches this image.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /deploy /app

# Never run the API as root.
USER node
EXPOSE 3000

# Liveness only: /ready (Postgres and Redis) is for whoever routes traffic.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# SIGTERM starts a graceful shutdown (src/shutdown.ts), bounded by
# SHUTDOWN_TIMEOUT_MS; give the container a longer stop grace period.
STOPSIGNAL SIGTERM

# The same image runs the migrations, before the API starts:
#   node node_modules/@laqum/db/dist/src/cli.js up
CMD ["node", "dist/server.js"]
