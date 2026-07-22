#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIRM_REPLACE_LIVE_DATA="--confirm-replace-live-data"
readonly STAGING_CONTAINER_ROOT="/staging"
readonly -a LIVE_SERVICES=(app worker bot)

RESTORED_DUMP=""
RESTORED_UPLOADS=""
RESTORED_TDLIB_WORKER=""
RESTORED_TDLIB_BOT=""
LIVE_STAGING_DIR=""
SAFETY_DUMP=""
LIVE_RESTORE_ACTIVE=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/backup/restore.sh list
  ./scripts/backup/restore.sh verify SNAPSHOT_ID
  ./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID STAGING_DIR
  ./scripts/backup/restore.sh restore-live SNAPSHOT_ID --confirm-replace-live-data
EOF
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Required environment variable %s is not set.\n' "$name" >&2
    return 1
  fi
}

validate_environment() {
  require_value BACKUP_MOUNT_PATH
  require_value BACKUP_STAGING_PATH
  require_value BACKUP_RESTIC_PASSWORD_FILE
  if [[ ! -r "$BACKUP_RESTIC_PASSWORD_FILE" ]]; then
    printf 'Restic password file %s is not readable.\n' "$BACKUP_RESTIC_PASSWORD_FILE" >&2
    return 1
  fi
}

backup_restic() {
  docker compose --profile backup run --rm --no-deps backup "$@"
}

canonical_staging_root() {
  realpath -m -- "$BACKUP_STAGING_PATH"
}

validate_staging_directory() {
  local staging_dir="$1"
  local staging_root
  local canonical_staging_dir

  staging_root="$(canonical_staging_root)"
  canonical_staging_dir="$(realpath -m -- "$staging_dir")"
  if [[ "$canonical_staging_dir" == "$staging_root" || "$canonical_staging_dir" != "$staging_root"/* ]]; then
    printf 'Staging directory %s must be inside BACKUP_STAGING_PATH (%s).\n' "$staging_dir" "$staging_root" >&2
    return 1
  fi
  printf '%s\n' "$canonical_staging_dir"
}

container_staging_directory() {
  local host_staging_dir="$1"
  local staging_root

  staging_root="$(canonical_staging_root)"
  printf '%s/%s\n' "$STAGING_CONTAINER_ROOT" "${host_staging_dir#"$staging_root"/}"
}

verify_custom_dump() {
  local dump_path="$1"
  docker compose --profile backup run --rm --no-deps \
    --entrypoint pg_restore \
    -v "$dump_path:/restore/database.dump:ro" \
    backup --list /restore/database.dump >/dev/null
}

validate_restored_tree() {
  local staging_dir="$1"
  local manifest

  RESTORED_DUMP="$(find "$staging_dir" -type f -name database.dump -size +0c -print -quit)"
  manifest="$(find "$staging_dir" -type f -path '*/manifest/backup-manifest.json' -size +0c -print -quit)"
  RESTORED_UPLOADS="$(find "$staging_dir" -type d \( -path '*/data/uploads' -o -name manual_uploads \) -print -quit)"
  RESTORED_TDLIB_WORKER="$(find "$staging_dir" -type d -name tdlib-worker -print -quit)"
  RESTORED_TDLIB_BOT="$(find "$staging_dir" -type d -name tdlib-bot -print -quit)"
  if [[ -z "$RESTORED_DUMP" || -z "$manifest" || -z "$RESTORED_UPLOADS" || -z "$RESTORED_TDLIB_WORKER" || -z "$RESTORED_TDLIB_BOT" ]]; then
    printf 'Restored tree %s is incomplete; require database.dump, manifest, manual_uploads, tdlib-worker, and tdlib-bot.\n' "$staging_dir" >&2
    return 1
  fi
  verify_custom_dump "$RESTORED_DUMP"
}

verify_snapshot() {
  local snapshot_id="$1"
  backup_restic snapshots "$snapshot_id"
  backup_restic check
}

restore_to_staging() {
  local snapshot_id="$1"
  local requested_staging_dir="$2"
  local staging_dir
  local container_staging_dir
  validate_environment
  staging_dir="$(validate_staging_directory "$requested_staging_dir")"
  container_staging_dir="$(container_staging_directory "$staging_dir")"
  mkdir -p -- "$staging_dir"
  verify_snapshot "$snapshot_id"
  backup_restic restore "$snapshot_id" --target "$container_staging_dir"
  validate_restored_tree "$staging_dir"
  printf 'Staging restore verified: %s\n' "$staging_dir"
}

compose_project_name() {
  local project_name
  project_name="$(docker compose config --format json | awk -F'"' '/^[[:space:]]*"name"[[:space:]]*:/ { print $4; exit }')"
  if [[ -z "$project_name" ]]; then
    printf '%s\n' 'Unable to determine the Docker Compose project name.' >&2
    return 1
  fi
  printf '%s\n' "$project_name"
}

compose_volume_name() {
  local project_name="$1"
  local logical_name="$2"
  local -a matches=()
  mapfile -t matches < <(docker volume ls \
    --filter "label=com.docker.compose.project=$project_name" \
    --filter "label=com.docker.compose.volume=$logical_name" \
    --format '{{.Name}}')
  if ((${#matches[@]} != 1)); then
    printf 'Expected exactly one %s volume for Compose project %s; found %s.\n' "$logical_name" "$project_name" "${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

replace_volume() {
  local source_dir="$1"
  local volume_name="$2"
  docker compose --profile backup run --rm --no-deps \
    --entrypoint bash \
    -v "$source_dir:/restore-source:ro" \
    -v "$volume_name:/restore-target" \
    backup -ceu '
      find /restore-target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a /restore-source/. /restore-target/
    '
}

create_safety_dump() {
  local database_user="${POSTGRES_USER:-dragons}"
  local database_name="${POSTGRES_DB:-dragonsstash}"
  SAFETY_DUMP="$LIVE_STAGING_DIR/pre-restore-database.dump"
  docker compose exec -T db pg_dump --format=custom --no-owner \
    --username "$database_user" --dbname "$database_name" > "$SAFETY_DUMP"
  if [[ ! -s "$SAFETY_DUMP" ]]; then
    printf 'Safety database dump %s is missing or empty.\n' "$SAFETY_DUMP" >&2
    return 1
  fi
}

restore_database() {
  local database_user="${POSTGRES_USER:-dragons}"
  local database_name="${POSTGRES_DB:-dragonsstash}"
  docker compose exec -T db dropdb --if-exists --force --username "$database_user" "$database_name"
  docker compose exec -T db createdb --username "$database_user" "$database_name"
  docker compose exec -T db pg_restore --no-owner --exit-on-error \
    --username "$database_user" --dbname "$database_name" < "$RESTORED_DUMP"
}

verify_file_references() {
  local uploads_volume="$1"
  local database_user="${POSTGRES_USER:-dragons}"
  local database_name="${POSTGRES_DB:-dragonsstash}"
  docker compose exec -T db psql --no-psqlrc --tuples-only --no-align --quiet \
    --field-separator=$'\t' \
    --username "$database_user" --dbname "$database_name" \
    --command "SELECT 'legacy', \"filePath\" FROM \"manual_upload_files\" WHERE \"retainedAt\" IS NULL
      UNION ALL
      SELECT 'retained', \"filePath\" FROM \"manual_upload_files\" WHERE \"retainedAt\" IS NOT NULL
      ORDER BY 2" |
    docker compose --profile backup run --rm --no-deps -T --entrypoint bash \
      -v "$uploads_volume:/data/uploads:ro" backup -ceu '
        missing=0
        while IFS="$(printf "\t")" read -r retention file_path; do
          if [[ "$retention" == "legacy" ]]; then
            printf "Warning: legacy manual-upload file reference is not required because retainedAt is NULL: %s\\n" "$file_path" >&2
            continue
          fi
          if [[ "$retention" != "retained" ]]; then
            printf "Unexpected retention status for database reference: %s\\n" "$file_path" >&2
            missing=1
            continue
          fi
          case "$file_path" in
            /data/uploads/*) relative_path="${file_path#/data/uploads/}" ;;
            *)
              printf "Database reference is outside /data/uploads: %s\\n" "$file_path" >&2
              missing=1
              continue
              ;;
          esac
          if [[ -z "$relative_path" || "$relative_path" == .. || "$relative_path" == ../* || "$relative_path" == */../* ]]; then
            printf "Database reference has an invalid uploads path: %s\\n" "$file_path" >&2
            missing=1
          elif [[ ! -f "/data/uploads/$relative_path" ]]; then
            printf "Missing restored upload for database reference: %s\\n" "$file_path" >&2
            missing=1
          fi
        done
        exit "$missing"
      '
}

wait_for_health() {
  local health_url="${RESTORE_HEALTH_URL:-http://localhost:${APP_PORT:-3000}/api/health}"
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --show-error "$health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  printf 'Application health endpoint did not become ready: %s\n' "$health_url" >&2
  return 1
}

live_restore_failure() {
  local exit_code=$?
  trap - EXIT
  if ((LIVE_RESTORE_ACTIVE)); then
    docker compose --profile full stop "${LIVE_SERVICES[@]}" || true
    printf 'Live restore failed (exit %s). Services remain stopped. Staging directory: %s\n' "$exit_code" "$LIVE_STAGING_DIR" >&2
    printf 'Safety database dump retained at: %s\n' "$SAFETY_DUMP" >&2
  fi
  exit "$exit_code"
}

restore_live() {
  local snapshot_id="$1"
  local project_name
  local uploads_volume
  local worker_volume
  local bot_volume
  local timestamp
  local container_staging_dir
  validate_environment
  docker compose --profile backup config --quiet
  project_name="$(compose_project_name)"
  verify_snapshot "$snapshot_id"
  printf 'Live restore target confirmed: Compose project %s, configured Restic repository, snapshot %s.\n' "$project_name" "$snapshot_id"
  timestamp="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
  LIVE_STAGING_DIR="$(validate_staging_directory "$BACKUP_STAGING_PATH/live-restore-$timestamp-$$")"
  container_staging_dir="$(container_staging_directory "$LIVE_STAGING_DIR")"
  mkdir -p -- "$LIVE_STAGING_DIR"
  SAFETY_DUMP="$LIVE_STAGING_DIR/pre-restore-database.dump"
  trap live_restore_failure EXIT
  LIVE_RESTORE_ACTIVE=1
  docker compose --profile full stop "${LIVE_SERVICES[@]}"
  create_safety_dump
  backup_restic restore "$snapshot_id" --target "$container_staging_dir"
  validate_restored_tree "$LIVE_STAGING_DIR"
  uploads_volume="$(compose_volume_name "$project_name" manual_uploads)"
  worker_volume="$(compose_volume_name "$project_name" tdlib_state)"
  bot_volume="$(compose_volume_name "$project_name" tdlib_bot_state)"
  replace_volume "$RESTORED_UPLOADS" "$uploads_volume"
  replace_volume "$RESTORED_TDLIB_WORKER" "$worker_volume"
  replace_volume "$RESTORED_TDLIB_BOT" "$bot_volume"
  restore_database
  docker compose --profile full up -d "${LIVE_SERVICES[@]}"
  wait_for_health
  verify_file_references "$uploads_volume"
  LIVE_RESTORE_ACTIVE=0
  trap - EXIT
  printf 'Live restore completed. Staging directory retained at: %s\n' "$LIVE_STAGING_DIR"
  printf 'Safety database dump retained at: %s\n' "$SAFETY_DUMP"
}

main() {
  local command="${1:-}"
  case "$command" in
    list)
      [[ $# -eq 1 ]] || { usage >&2; return 2; }
      validate_environment
      backup_restic snapshots
      ;;
    verify)
      [[ $# -eq 2 ]] || { usage >&2; return 2; }
      validate_environment
      verify_snapshot "$2"
      ;;
    restore-to-staging)
      [[ $# -eq 3 ]] || { usage >&2; return 2; }
      restore_to_staging "$2" "$3"
      ;;
    restore-live)
      if [[ $# -ne 3 || "$3" != "$CONFIRM_REPLACE_LIVE_DATA" ]]; then
        printf 'restore-live requires the exact confirmation flag: %s\n' "$CONFIRM_REPLACE_LIVE_DATA" >&2
        return 2
      fi
      restore_live "$2"
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
}

main "$@"
