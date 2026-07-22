#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIRM_REPLACE_LIVE_DATA="--confirm-replace-live-data"
readonly STAGING_CONTAINER_ROOT="/staging"
readonly BACKUP_CONTAINER_ROOT="/backup"
readonly -a LIVE_SERVICES=(app worker bot)
readonly -a RESTORE_INCLUDE_FILTERS=(
  --include "/staging/backup-*/database.dump"
  --include "/staging/backup-*/manifest"
  --include "/staging/backup-*/manifest/**"
  --include "/data/tdlib-worker"
  --include "/data/tdlib-worker/**"
  --include "/data/tdlib-bot"
  --include "/data/tdlib-bot/**"
)

RESTORED_DUMP=""
RESTORED_TDLIB_WORKER=""
RESTORED_TDLIB_BOT=""
LIVE_STAGING_DIR=""
SAFETY_DUMP=""
LIVE_RESTORE_ACTIVE=0
LIVE_REPLACEMENT_STARTED=0
LIVE_WORKER_VOLUME=""
LIVE_BOT_VOLUME=""
declare -a RUNNING_LIVE_SERVICES=()

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
  require_value BACKUP_REPOSITORY
  if [[ ! -r "$BACKUP_RESTIC_PASSWORD_FILE" ]]; then
    printf 'Restic password file %s is not readable.\n' "$BACKUP_RESTIC_PASSWORD_FILE" >&2
    return 1
  fi
  validate_backup_repository
}

validate_backup_repository() {
  local repository="$BACKUP_REPOSITORY"
  local canonical_repository

  canonical_repository="$(realpath -ms -- "$repository")"
  if [[ "$canonical_repository" == "$BACKUP_CONTAINER_ROOT" || "$canonical_repository" != "$BACKUP_CONTAINER_ROOT"/* ]]; then
    printf 'BACKUP_REPOSITORY must be strictly below /backup; got %s.\n' "$repository" >&2
    return 1
  fi
}

validate_backup_mount() {
  local probe_file

  if ! mountpoint --q "$BACKUP_MOUNT_PATH"; then
    printf 'Backup mount %s is not an active mountpoint.\n' "$BACKUP_MOUNT_PATH" >&2
    return 1
  fi

  if ! probe_file="$(mktemp "$BACKUP_MOUNT_PATH/.dragons-stash-backup-write-probe.XXXXXX")"; then
    printf 'Backup mount %s is not writable.\n' "$BACKUP_MOUNT_PATH" >&2
    return 1
  fi

  if ! rm -f -- "$probe_file"; then
    printf 'Unable to remove writable probe %s.\n' "$probe_file" >&2
    return 1
  fi
}

backup_restic() {
  docker compose --profile backup run --rm --no-deps backup "$@"
}

restore_snapshot_subset() {
  local snapshot_id="$1"
  local container_staging_dir="$2"

  backup_restic restore "$snapshot_id" --target "$container_staging_dir" "${RESTORE_INCLUDE_FILTERS[@]}"
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

prepare_fresh_staging_directory() {
  local staging_dir="$1"

  if [[ -e "$staging_dir" ]]; then
    if [[ ! -d "$staging_dir" ]]; then
      printf 'Staging target %s exists but is not a directory.\n' "$staging_dir" >&2
      return 1
    fi
    if [[ -n "$(find "$staging_dir" -mindepth 1 -print -quit)" ]]; then
      printf 'Staging target %s must be fresh and empty; remove stale artifacts first.\n' "$staging_dir" >&2
      return 1
    fi
  else
    mkdir -p -- "$staging_dir"
  fi
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

reject_unexpected_restored_content() {
  local staging_dir="$1"
  local backup_directory="$2"
  local entry
  local name
  local -a unexpected_entries=()

  while IFS= read -r -d '' entry; do
    name="$(basename -- "$entry")"
    case "$name" in
      data|staging) ;;
      *) unexpected_entries+=("$entry") ;;
    esac
  done < <(find "$staging_dir" -mindepth 1 -maxdepth 1 -type d -print0)

  if [[ -d "$staging_dir/data" ]]; then
    while IFS= read -r -d '' entry; do
      name="$(basename -- "$entry")"
      case "$name" in
        tdlib-worker|tdlib-bot) ;;
        *) unexpected_entries+=("$entry") ;;
      esac
    done < <(find "$staging_dir/data" -mindepth 1 -maxdepth 1 -print0)
  fi

  while IFS= read -r -d '' entry; do
    name="$(basename -- "$entry")"
    case "$name" in
      database.dump|manifest) ;;
      *) unexpected_entries+=("$entry") ;;
    esac
  done < <(find "$backup_directory" -mindepth 1 -maxdepth 1 -print0)

  if ((${#unexpected_entries[@]})); then
    printf 'Refusing restore: unexpected restored data volume content found under %s:\n' "$staging_dir" >&2
    for entry in "${unexpected_entries[@]}"; do
      printf '  - %s\n' "${entry#"$staging_dir"/}" >&2
    done
    return 1
  fi
}

validate_restored_tree() {
  local staging_dir="$1"
  local -a backup_directories=("$staging_dir"/staging/backup-*)
  local backup_directory
  local manifest

  if ((${#backup_directories[@]} != 1)) || [[ ! -d "${backup_directories[0]:-}" ]]; then
    printf 'Restored tree %s must contain exactly one staging/backup-* directory.\n' "$staging_dir" >&2
    return 1
  fi
  backup_directory="${backup_directories[0]}"
  reject_unexpected_restored_content "$staging_dir" "$backup_directory"
  RESTORED_DUMP="$backup_directory/database.dump"
  manifest="$backup_directory/manifest/backup-manifest.json"
  RESTORED_TDLIB_WORKER="$staging_dir/data/tdlib-worker"
  RESTORED_TDLIB_BOT="$staging_dir/data/tdlib-bot"
  if [[ ! -s "$RESTORED_DUMP" || ! -s "$manifest" || ! -d "$RESTORED_TDLIB_WORKER" || ! -d "$RESTORED_TDLIB_BOT" ]]; then
    printf 'Restored tree %s is incomplete; require staging/backup-*/database.dump, its manifest, data/tdlib-worker, and data/tdlib-bot.\n' "$staging_dir" >&2
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
  prepare_fresh_staging_directory "$staging_dir"
  verify_snapshot "$snapshot_id"
  restore_snapshot_subset "$snapshot_id" "$container_staging_dir"
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

capture_running_live_services() {
  local service
  local container_ids

  RUNNING_LIVE_SERVICES=()
  for service in "${LIVE_SERVICES[@]}"; do
    if ! container_ids="$(docker compose --profile full ps --status running -q "$service")"; then
      printf 'Unable to determine whether Compose service %s is running.\n' "$service" >&2
      return 1
    fi

    if [[ -n "$container_ids" ]]; then
      RUNNING_LIVE_SERVICES+=("$service")
    fi
  done
}

live_service_was_running() {
  local requested_service="$1"
  local service

  for service in "${RUNNING_LIVE_SERVICES[@]}"; do
    [[ "$service" == "$requested_service" ]] && return 0
  done
  return 1
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

restore_database_dump() {
  local dump_path="$1"
  local database_user="${POSTGRES_USER:-dragons}"
  local database_name="${POSTGRES_DB:-dragonsstash}"
  docker compose exec -T db dropdb --if-exists --force --username "$database_user" "$database_name"
  docker compose exec -T db createdb --username "$database_user" "$database_name"
  docker compose exec -T db pg_restore --no-owner --exit-on-error \
    --username "$database_user" --dbname "$database_name" < "$dump_path"
}

restore_database() {
  restore_database_dump "$RESTORED_DUMP"
}

archive_live_volume() {
  local volume_name="$1"
  local logical_name="$2"
  local archive_path="$LIVE_STAGING_DIR/pre-restore-$logical_name.tar"

  docker compose --profile backup run --rm --no-deps \
    --entrypoint bash \
    -v "$volume_name:/safety-source:ro" \
    -v "$LIVE_STAGING_DIR:/safety-output" \
    backup -ceu 'tar -C /safety-source -cf "$1" .' bash \
    "/safety-output/pre-restore-$logical_name.tar"
  if [[ ! -s "$archive_path" ]]; then
    printf 'Safety archive %s is missing or empty.\n' "$archive_path" >&2
    return 1
  fi
}

restore_live_volume_archive() {
  local volume_name="$1"
  local logical_name="$2"
  local archive_path="$LIVE_STAGING_DIR/pre-restore-$logical_name.tar"

  docker compose --profile backup run --rm --no-deps \
    --entrypoint bash \
    -v "$archive_path:/safety-archive:ro" \
    -v "$volume_name:/restore-target" \
    backup -ceu '
      find /restore-target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      tar -C /restore-target -xf /safety-archive
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
  local rollback_ok=1
  trap - EXIT
  if ((LIVE_RESTORE_ACTIVE)); then
    if ((${#RUNNING_LIVE_SERVICES[@]} > 0)); then
      docker compose --profile full stop "${RUNNING_LIVE_SERVICES[@]}" || true
    fi
    if ((LIVE_REPLACEMENT_STARTED)); then
      restore_live_volume_archive "$LIVE_WORKER_VOLUME" tdlib_state || rollback_ok=0
      restore_live_volume_archive "$LIVE_BOT_VOLUME" tdlib_bot_state || rollback_ok=0
      restore_database_dump "$SAFETY_DUMP" || rollback_ok=0
      if ((rollback_ok)); then
        printf 'Rollback restored the pre-restore database and both TDLib Docker volumes. Services remain stopped.\n' >&2
      else
        printf 'Rollback failed; services remain stopped. Restore the safety archives and database dump manually.\n' >&2
      fi
    fi
    printf 'Live restore failed (exit %s). Services remain stopped. Staging directory: %s\n' "$exit_code" "$LIVE_STAGING_DIR" >&2
    printf 'Safety database dump retained at: %s\n' "$SAFETY_DUMP" >&2
  fi
  exit "$exit_code"
}

restore_live() {
  local snapshot_id="$1"
  local project_name
  local worker_volume
  local bot_volume
  local timestamp
  local container_staging_dir
  validate_environment
  validate_backup_mount
  docker compose --profile backup config --quiet
  project_name="$(compose_project_name)"
  verify_snapshot "$snapshot_id"
  printf 'Live restore target confirmed: Compose project %s, configured Restic repository, snapshot %s.\n' "$project_name" "$snapshot_id"
  timestamp="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
  LIVE_STAGING_DIR="$(validate_staging_directory "$BACKUP_STAGING_PATH/live-restore-$timestamp-$$")"
  container_staging_dir="$(container_staging_directory "$LIVE_STAGING_DIR")"
  prepare_fresh_staging_directory "$LIVE_STAGING_DIR"
  SAFETY_DUMP="$LIVE_STAGING_DIR/pre-restore-database.dump"
  trap live_restore_failure EXIT
  LIVE_RESTORE_ACTIVE=1
  capture_running_live_services
  if ((${#RUNNING_LIVE_SERVICES[@]} > 0)); then
    docker compose --profile full stop "${RUNNING_LIVE_SERVICES[@]}"
  fi
  create_safety_dump
  restore_snapshot_subset "$snapshot_id" "$container_staging_dir"
  validate_restored_tree "$LIVE_STAGING_DIR"
  worker_volume="$(compose_volume_name "$project_name" tdlib_state)"
  bot_volume="$(compose_volume_name "$project_name" tdlib_bot_state)"
  LIVE_WORKER_VOLUME="$worker_volume"
  LIVE_BOT_VOLUME="$bot_volume"
  archive_live_volume "$worker_volume" tdlib_state
  archive_live_volume "$bot_volume" tdlib_bot_state
  LIVE_REPLACEMENT_STARTED=1
  replace_volume "$RESTORED_TDLIB_WORKER" "$worker_volume"
  replace_volume "$RESTORED_TDLIB_BOT" "$bot_volume"
  restore_database
  if ((${#RUNNING_LIVE_SERVICES[@]} > 0)); then
    docker compose --profile full up -d "${RUNNING_LIVE_SERVICES[@]}"
  fi
  if live_service_was_running app; then
    wait_for_health
  fi
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
