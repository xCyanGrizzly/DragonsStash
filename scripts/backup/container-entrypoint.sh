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

validate_restic_repository() {
  local canonical_repository

  canonical_repository="$(realpath -m -- "$RESTIC_REPOSITORY")"
  if [[ "$canonical_repository" == "$BACKUP_ROOT" || "$canonical_repository" != "$BACKUP_ROOT"/* ]]; then
    printf 'RESTIC_REPOSITORY must be strictly below /backup; got %s.\n' "$RESTIC_REPOSITORY" >&2
    return 1
  fi

  RESTIC_REPOSITORY="$canonical_repository"
  export RESTIC_REPOSITORY
}

validate_restic_configuration() {
  require_value RESTIC_REPOSITORY
  require_value RESTIC_PASSWORD_FILE

  if [[ ! -r "$RESTIC_PASSWORD_FILE" ]]; then
    printf 'Restic password file %s is not readable.\n' "$RESTIC_PASSWORD_FILE" >&2
    return 1
  fi

  require_directory "$BACKUP_ROOT"
  validate_restic_repository
}

ensure_repository_initialized() {
  if ! restic cat config >/dev/null; then
    printf 'Restic repository %s is not initialized or could not be opened. Verify the backup mount, repository path, and password.\n' "$RESTIC_REPOSITORY" >&2
    printf 'For an intended first-time repository, initialize it explicitly with: docker compose --profile backup run --rm backup init\n' >&2
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
  local applied_migrations

  require_value DATABASE_URL
  require_value BACKUP_RETENTION_DAYS
  validate_restic_configuration
  require_directory "$STAGING_ROOT"
  require_directory "$UPLOADS_PATH"
  require_directory "$TDLIB_WORKER_PATH"
  require_directory "$TDLIB_BOT_PATH"
  ensure_repository_initialized

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
  applied_migrations="$(
    psql --dbname "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --quiet \
      --set ON_ERROR_STOP=on <<'SQL'
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'name', "migration_name",
            'finishedAtUtc', to_char(
              "finished_at" AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          )
          ORDER BY "finished_at", "migration_name"
        ),
        '[]'::json
      )::text
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;
SQL
  )"

  cat > "$RUN_DIR/manifest/backup-manifest.json" <<EOF
{
  "backupTimestampUtc": "$(json_escape "$timestamp")",
  "repository": "$(json_escape "$RESTIC_REPOSITORY")",
  "retentionDays": "$(json_escape "$BACKUP_RETENTION_DAYS")",
  "applicationVersion": "$(json_escape "$app_version")",
  "appliedPrismaMigrations": $applied_migrations,
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
  validate_restic_configuration
  exec restic restore "$@"
}

run_restic() {
  validate_restic_configuration
  exec restic "$@"
}

case "${1:-backup}" in
  backup) run_backup ;;
  restore) run_restore "$@" ;;
  *) run_restic "$@" ;;
esac
