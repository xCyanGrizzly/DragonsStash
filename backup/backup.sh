#!/bin/bash
set -euo pipefail

report_failure() {
  [ -n "${KUMA_PUSH_URL:-}" ] || return 0
  curl -fsS "$KUMA_PUSH_URL" --get \
    --data-urlencode "status=down" \
    --data-urlencode "msg=$BASH_COMMAND failed" || true
}
trap report_failure ERR

DUMP_FILE=/tmp/dragonsstash.dump
TAR_FILE=/tmp/tdlib.tar.gz

trap 'rm -f "$DUMP_FILE" "$TAR_FILE"' EXIT

pg_dump -h dragonsstash-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$DUMP_FILE"

# TDLib volumes are tarred live (best-effort, per design). A file changing
# mid-read makes GNU tar exit 1 (warning) — that is expected here and must not
# abort the backup. Only a genuine error (exit >= 2) is fatal.
tar --warning=no-file-changed -czf "$TAR_FILE" -C /data tdlib-worker tdlib-bot \
  || { rc=$?; [ "$rc" -le 1 ] || exit "$rc"; }

restic backup "$DUMP_FILE" "$TAR_FILE"
restic forget --keep-daily 14 --prune

if [ -n "${KUMA_PUSH_URL:-}" ]; then
  curl -fsS "$KUMA_PUSH_URL" --get \
    --data-urlencode "status=up" \
    --data-urlencode "msg=OK"
fi
