#!/bin/bash
set -euo pipefail

report_failure() {
  curl -fsS "$KUMA_PUSH_URL" --get \
    --data-urlencode "status=down" \
    --data-urlencode "msg=$BASH_COMMAND failed" || true
}
trap report_failure ERR

DUMP_FILE=/tmp/dragonsstash.dump
TAR_FILE=/tmp/tdlib.tar.gz

trap 'rm -f "$DUMP_FILE" "$TAR_FILE"' EXIT

pg_dump -h dragonsstash-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$DUMP_FILE"

tar czf "$TAR_FILE" -C /data tdlib-worker tdlib-bot

restic backup "$DUMP_FILE" "$TAR_FILE"
restic forget --keep-daily 14 --prune

curl -fsS "$KUMA_PUSH_URL" --get \
  --data-urlencode "status=up" \
  --data-urlencode "msg=OK"
