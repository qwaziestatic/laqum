#!/bin/sh
# NIGHTLY DATABASE DUMPS (docs/DEPLOY.md, "Backups").
#
#   laqum-backup schedule   every night at BACKUP_AT_UTC (the container's default)
#   laqum-backup now        one dump, at once (also: before an upgrade)
#
# Each dump is pg_dump's custom format, written beside the old ones in
# /backups (a volume on this server), kept BACKUP_KEEP_DAYS days, and copied
# to BACKUP_REMOTE, the SECOND location in Ethiopia that does not depend on
# the hosting provider, so losing the provider does not lose the data. The
# copy goes over SSH with a key and a pinned host key from deploy/secrets/.
#
# A dump is not a backup until it has been restored: deploy/restore-check.sh.
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# 02:00 in Addis Ababa is 23:00 UTC (Ethiopia keeps no daylight saving).
AT_UTC="${BACKUP_AT_UTC:-23:00}"
DIR=/backups

log() {
  echo "backup: $*"
}

copy_off_server() {
  file="$1"
  if [ -z "${BACKUP_REMOTE:-}" ]; then
    log "WARNING: BACKUP_REMOTE is not set; this dump exists on this server only"
    return 0
  fi
  rsync -a --partial \
    -e "ssh -i /run/secrets/backup_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/secrets/backup_known_hosts" \
    "$file" "$BACKUP_REMOTE/"
  log "copied to $BACKUP_REMOTE"
}

dump() {
  stamp=$(date -u +%Y%m%dT%H%MZ)
  file="$DIR/laqum-$stamp.dump"
  # Written under a temporary name and renamed, so a dump cut short is never
  # mistaken for a complete one.
  pg_dump --format=custom --no-owner --no-privileges --file="$file.partial" "$DATABASE_URL"
  mv "$file.partial" "$file"
  log "wrote $file ($(du -h "$file" | cut -f1))"
  find "$DIR" -name 'laqum-*.dump' -mtime "+$KEEP_DAYS" -print -delete | sed 's/^/backup: removed old /'
  copy_off_server "$file"
}

seconds_until_next() {
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) $AT_UTC" +%s)
  if [ "$target" -le "$now" ]; then target=$((target + 86400)); fi
  echo $((target - now))
}

case "${1:-schedule}" in
  now)
    dump
    ;;
  schedule)
    log "scheduled daily at $AT_UTC UTC, keeping $KEEP_DAYS days"
    while true; do
      sleep "$(seconds_until_next)"
      # A failed night is logged loudly and does not stop the next one.
      dump || log "FAILED: see the lines above"
    done
    ;;
  *)
    echo "usage: laqum-backup [schedule|now]" >&2
    exit 2
    ;;
esac
