# The public face: Caddy, with the attendant dashboard built into it.
#
# Build context is the REPO ROOT, like the API's:
#   docker build -f deploy/web.Dockerfile .
# docker-compose.prod.yml does this.

# ─── build the dashboard ─────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Manifests first, so this layer is cached until a dependency changes. Only
# the dashboard and what it needs: its Vite config aliases @laqum/shared to
# source, so shared needs no build of its own.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@laqum/dashboard..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
RUN pnpm --filter @laqum/dashboard build

# ─── serve ───────────────────────────────────────────────────────────────
FROM caddy:2.11.4-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/dashboard/dist /srv
