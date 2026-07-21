#!/usr/bin/env bash
set -Eeuo pipefail

readonly BACKUP_ROOT="/backup"
readonly STAGING_ROOT="/staging"
readonly UPLOADS_PATH="/data/uploads"
readonly TDLIB_WORKER_PATH="/data/tdlib-worker"
readonly TDLIB_BOT_PATH="/data/tdlib-bot"

RUN_DIR=""

require_value() {
  local name="$1"

  if [[ -z "${!name:-}" ]]; then
    printf 'Required environment variable %s is not set.\n' "$name" >&2
    return 1
  fi
}

require_directory() {
  local path="$1"

  if [[ ! -d "$path" ]]; then
    printf 'Required mounted directory %s is unavailable.\n' "$path" >&2
    return 1
  fi
}

json_escape() {
  local input="$1"
  local output=""
  local character
  local code

  while [[ -n "$input" ]]; do
    character="${input:0:1}"
    input="${input:1}"

    case "$character" in
      '"') output+='\"' ;;
      '\\') output+='\\' ;;
      $'\b') output+='\b' ;;
      $'\f') output+='\f' ;;
      $'\n') output+='\n' ;;
      $'\r') output+='\r' ;;
      $'\t') output+='\t' ;;
      *)
        printf -v code '%d' "'$character"
        if (( code < 32 )); then
          printf -v character '\u%04x' "$code"
        fi
        output+="$character"
        ;;
    esac
  done

  printf '%s' "$output"
}

cleanup() {
  local exit_code=$?

  if [[ -n "$RUN_DIR" && "$RUN_DIR" == "$STAGING_ROOT"/* ]]; then
    rm -rf -- "$RUN_DIR"
  fi

  exit "$exit_code"
}

run_backup() {
  local timestamp
  local checksum
  local app_version

  require_value DATABASE_URL
  require_value RESTIC_REPOSITORY
  require_value RESTIC_PASSWORD_FILE
  require_value BACKUP_RETENTION_DAYS

  if [[ ! -r "$RESTIC_PASSWORD_FILE" ]]; then
    printf 'Restic password file %s is not readable.\n' "$RESTIC_PASSWORD_FILE" >&2
    return 1
  fi

  require_directory "$BACKUP_ROOT"
  require_directory "$STAGING_ROOT"
  require_directory "$UPLOADS_PATH"
  require_directory "$TDLIB_WORKER_PATH"
  require_directory "$TDLIB_BOT_PATH"

  timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  RUN_DIR="$STAGING_ROOT/backup-${timestamp//[:]/}-$$"
  mkdir -- "$RUN_DIR"
  mkdir -- "$RUN_DIR/manifest"
  trap cleanup EXIT

  pg_dump --format=custom --file="$RUN_DIR/database.dump" "$DATABASE_URL"

  if [[ ! -f "$RUN_DIR/database.dump" || ! -s "$RUN_DIR/database.dump" ]]; then
    printf 'PostgreSQL dump is missing or empty.\n' >&2
    return 1
  fi

  sha256sum "$RUN_DIR/database.dump" > "$RUN_DIR/manifest/database.dump.sha256"
  checksum="$(awk '{print $1}' "$RUN_DIR/manifest/database.dump.sha256")"
  app_version="${BACKUP_APP_VERSION:-unknown}"

  cat > "$RUN_DIR/manifest/backup-manifest.json" <<EOF
{
  "backupTimestampUtc": "$(json_escape "$timestamp")",
  "repository": "$(json_escape "$RESTIC_REPOSITORY")",
  "retentionDays": "$(json_escape "$BACKUP_RETENTION_DAYS")",
  "applicationVersion": "$(json_escape "$app_version")",
  "databaseDump": {
    "filename": "database.dump",
    "sha256": "$(json_escape "$checksum")"
  },
  "volumePaths": [
    "$(json_escape "$UPLOADS_PATH")",
    "$(json_escape "$TDLIB_WORKER_PATH")",
    "$(json_escape "$TDLIB_BOT_PATH")"
  ]
}
EOF

  restic backup \
    --tag "application:dragons-stash" \
    --tag "source:database" \
    --tag "source:uploads" \
    --tag "source:tdlib-worker" \
    --tag "source:tdlib-bot" \
    "$RUN_DIR/database.dump" \
    "$RUN_DIR/manifest" \
    "$UPLOADS_PATH" \
    "$TDLIB_WORKER_PATH" \
    "$TDLIB_BOT_PATH"
  restic snapshots --latest 1
  restic check
  restic forget --keep-daily "$BACKUP_RETENTION_DAYS" --prune
}

run_restore() {
  shift
  exec restic restore "$@"
}

case "${1:-backup}" in
  backup) run_backup ;;
  restore) run_restore "$@" ;;
  *) exec restic "$@" ;;
esac
