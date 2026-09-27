#!/usr/bin/env bash
# A DUMP IS NOT A BACKUP UNTIL IT HAS BEEN RESTORED.
#
#   deploy/restore-check.sh <laqum-YYYYMMDDTHHMMZ.dump>
#
# Restores the dump into a throwaway PostgreSQL 16 container, the same major
# version as production, and checks that what came back is a working
# database: every migration applied, the tables that matter present with
# their rows, and the index that forbids double bookings intact. Touches
# nothing else. Needs Docker; runs on the server, on the backup machine, or
# on a laptop. Run it after the first backup, and then monthly
# (docs/DEPLOY.md, "Backups").
set -euo pipefail
# Git Bash on Windows would otherwise rewrite the container paths below.
export MSYS_NO_PATHCONV=1

dump="${1:?usage: deploy/restore-check.sh <dump file>}"
[ -f "$dump" ] || { echo "restore-check: no such file: $dump" >&2; exit 2; }

name="laqum-restore-check-$$"
docker run -d --name "$name" -e POSTGRES_PASSWORD=restore-check postgres:16.15-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# Wait for the REAL server, over TCP. The image's init first runs a temporary
# server on the Unix socket only (listen_addresses=''), stops it, then starts
# the real one: a socket probe can succeed against the temporary server and
# the next command land in the restart ("connection to server on socket ...
# failed", CI #25). Only the real server listens on TCP.
ready=
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || { echo "restore-check: FAILED: PostgreSQL did not start within 60 s" >&2; exit 1; }

psql() {
  docker exec "$name" psql -U postgres -d laqum -v ON_ERROR_STOP=1 -At -c "$1"
}

docker cp "$dump" "$name:/tmp/laqum.dump"
docker exec "$name" createdb -U postgres laqum
docker exec "$name" pg_restore -U postgres --no-owner --no-privileges --exit-on-error \
  --dbname=laqum /tmp/laqum.dump

echo "restore-check: restored $(basename "$dump")"
echo "  latest migration:  $(psql 'SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1')"
for table in users lots slots bookings payments booking_events; do
  printf '  %-18s %s rows\n' "$table:" "$(psql "SELECT count(*) FROM $table")"
done

index=$(psql "SELECT count(*) FROM pg_indexes WHERE indexname = 'one_live_booking_per_slot'")
if [ "$index" != "1" ]; then
  echo "restore-check: FAILED: the index one_live_booking_per_slot is missing" >&2
  exit 1
fi
echo "  double-booking index: present"
echo "restore-check: OK"
