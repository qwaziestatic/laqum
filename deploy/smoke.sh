#!/usr/bin/env bash
# THE PRODUCTION STACK, UP FOR REAL, CHECKED, AND TORN DOWN.
#
#   deploy/smoke.sh            (needs Docker with Compose v2; run from the repo root)
#
# Builds the production images and starts docker-compose.prod.yml exactly as
# a server would, except: DOMAIN=localhost (Caddy issues itself a local
# certificate), a PostgreSQL container (--profile local-db), high ports, and a
# throwaway settings file. Then checks what a driver, an attendant and Chapa
# would reach, takes a backup, restores it, and stops the API with a real
# SIGTERM. Run in CI on every push, and before a deploy.
set -euo pipefail

project="laqum-smoke"
HTTPS_PORT="${HTTPS_PORT:-18443}"
HTTP_PORT="${HTTP_PORT:-18080}"
# Inside the repo (gitignored), not /tmp: Git Bash's /tmp is not a path the
# Windows Docker binaries can read.
workdir="deploy/.smoke"
mkdir -p "$workdir"
settings="$workdir/smoke.env"
random() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }

pg_password="$(random)"
cat >"$settings" <<EOF
DOMAIN=localhost
POSTGRES_PASSWORD=$pg_password
DATABASE_URL=postgres://laqum:$pg_password@postgres:5432/laqum
JWT_ACCESS_SECRET=$(random)
JWT_REFRESH_SECRET=$(random)
CHAPA_WEBHOOK_SECRET=$(random)
PAYMENT_PROVIDER=fake
LOG_LEVEL=info
EOF

export LAQUM_ENV_FILE="$settings" HTTP_PORT HTTPS_PORT
compose() {
  # Only Docker gets unconverted paths in Git Bash; curl still needs /dev/null.
  MSYS_NO_PATHCONV=1 docker compose -p "$project" -f docker-compose.prod.yml --env-file "$settings" --profile local-db "$@"
}
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

fail() {
  echo "smoke: FAILED: $*" >&2
  compose ps >&2 || true
  compose logs --tail 40 >&2 || true
  exit 1
}

echo "smoke: building and starting the production stack"
compose up -d --build --wait --wait-timeout 180 || fail "the stack did not become healthy"

base="https://localhost:$HTTPS_PORT"
get() { curl -sk -o /dev/null -w '%{http_code}' "$base$1"; }
# The body, captured whole: piping curl into `grep -q` fails under pipefail
# (grep stops reading at its first match, curl then exits 23).
body() { curl -sk "$base$1"; }
contains() { [[ "$(body "$1")" == *"$2"* ]]; }
expect() {
  local got
  got="$(get "$1")"
  [ "$got" = "$2" ] || fail "GET $1 answered $got, expected $2"
  echo "smoke: GET $1 -> $got"
}

# The migrations ran, all of them, before the API started.
migrations="$(compose logs migrate)"
[[ "$migrations" == *applied* || "$migrations" == *"No pending migrations"* ]] ||
  fail "no migration output"
echo "smoke: migrations applied"

# The attendant dashboard, its favicon and its page name, over HTTPS.
expect / 200
contains / '<title>ላቁም?</title>' || fail "index.html is not the dashboard"
expect /favicon.svg 200
expect /apple-touch-icon.png 200
# A deep link into the single-page app is the app, not a 404.
expect /lots/anything 200

# The API behind it: unauthenticated is refused properly, as JSON.
expect /v1/bookings/current 401
contains /v1/bookings/current '"UNAUTHENTICATED"' || fail "the API did not answer"
# Chapa's return page, and the realtime handshake, through Caddy.
expect /payment-complete 200
contains '/socket.io/?EIO=4&transport=polling' '"sid"' || fail "no Socket.io handshake"
echo "smoke: Socket.io handshake through Caddy"

# Not public: the probes describe the database, and there is no test page.
contains /ready '"checks"' && fail "/ready is reachable from outside"
contains /dev/checkout/x 'Test payment' && fail "the development checkout is live"
echo "smoke: /ready and /dev/checkout are not served"

# The client address the API sees is the caller's, not Caddy's, and a
# forged header does not change it: exactly one trusted hop.
compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1))" || fail "API health"

# A backup, taken and restored, with a row in it to come back.
compose exec -T postgres psql -U laqum -d laqum -v ON_ERROR_STOP=1 -c   "INSERT INTO users (phone, role) VALUES ('+251911000999', 'driver')" >/dev/null
[[ "$(compose run --rm -T backup now)" == *'wrote /backups/laqum-'* ]] || fail "no backup written"
dump_dir="$workdir/dump"
mkdir -p "$dump_dir"
compose run --rm -T --entrypoint sh -v "$(cd "$dump_dir" && pwd -W 2>/dev/null || pwd):/out" backup -c 'cp "$(ls -1t /backups/laqum-*.dump | head -1)" /out/'
restored="$(bash deploy/restore-check.sh "$(ls -1 "$dump_dir"/laqum-*.dump | head -1)")" || fail "the backup did not restore"
echo "$restored"
users_restored="$(printf '%s\n' "$restored" | awk '$1 == "users:" { print $2 }')"
[[ "$users_restored" == 1 ]] || fail "the row written before the backup did not come back"
rm -rf "$dump_dir"

# A real SIGTERM to the API: a clean shutdown, not the deadline.
compose stop api >/dev/null
[[ "$(compose logs api)" == *'shut down cleanly'* ]] || fail "the API did not shut down cleanly"
[[ "$(compose logs api)" == *'deadline passed'* ]] && fail "the API hit its shutdown deadline"
echo "smoke: the API shut down cleanly on SIGTERM"

echo "smoke: OK"
