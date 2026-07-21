#!/usr/bin/env bash
set -Eeuo pipefail

readonly LOCK_FILE="/run/lock/dragons-stash-backup.lock"
readonly -a MANAGED_SERVICES=(app worker bot)

declare -a RUNNING_SERVICES=()

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
  require_value BACKUP_RETENTION_DAYS
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

capture_running_services() {
  local service
  local container_ids

  for service in "${MANAGED_SERVICES[@]}"; do
    if ! container_ids="$(docker compose ps --status running -q "$service")"; then
      printf 'Unable to determine whether Compose service %s is running.\n' "$service" >&2
      return 1
    fi

    if [[ -n "$container_ids" ]]; then
      RUNNING_SERVICES+=("$service")
    fi
  done
}

restart_running_services() {
  local exit_code=$?

  trap - EXIT

  if ((${#RUNNING_SERVICES[@]} > 0)); then
    if ! docker compose start "${RUNNING_SERVICES[@]}"; then
      printf 'Failed to restart one or more previously running services: %s\n' "${RUNNING_SERVICES[*]}" >&2
    fi
  fi

  exit "$exit_code"
}

main() {
  validate_environment

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf "%s\n" "Another Dragon's Stash backup is already running." >&2
    return 1
  fi

  validate_backup_mount
  capture_running_services
  trap restart_running_services EXIT

  if ((${#RUNNING_SERVICES[@]} > 0)); then
    docker compose stop "${RUNNING_SERVICES[@]}"
  fi

  docker compose --profile backup run --rm backup backup
}

main "$@"
