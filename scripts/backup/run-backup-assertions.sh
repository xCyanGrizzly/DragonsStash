#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
BACKUP_SCRIPT="$PROJECT_ROOT/scripts/backup/run-backup.sh"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'ASSERTION FAILED: %s\n' "$*" >&2
  exit 1
}

setup_fake_environment() {
  local fake_bin="$TMP_ROOT/bin"

  mkdir -p -- "$fake_bin" "$TMP_ROOT/mount" "$TMP_ROOT/staging"
  printf 'not-secret\n' > "$TMP_ROOT/restic-password"

  cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

printf '%s\t' "$@" >> "$DRAGONS_STASH_DOCKER_CALLS"
printf '\n' >> "$DRAGONS_STASH_DOCKER_CALLS"

if [[ "${1:-}" == "compose" && "${2:-}" == "ps" && "${3:-}" == "--status" && "${4:-}" == "running" && "${5:-}" == "-q" ]]; then
  case "${6:-}" in
    app) printf 'app-container\n' ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "compose" && "${2:-}" == "stop" ]]; then
  exit 0
fi

if [[ "${1:-}" == "compose" && "${2:-}" == "start" ]]; then
  exit "${BACKUP_ASSERT_START_EXIT:-0}"
fi

if [[ " $* " == *" backup backup "* ]]; then
  exit "${BACKUP_ASSERT_BACKUP_EXIT:-0}"
fi

exit 0
EOF
  chmod +x "$fake_bin/docker"

  cat > "$fake_bin/mountpoint" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exit 0
EOF
  chmod +x "$fake_bin/mountpoint"

  cat > "$fake_bin/flock" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exit 0
EOF
  chmod +x "$fake_bin/flock"

  export PATH="$fake_bin:$PATH"
  export BACKUP_MOUNT_PATH="$TMP_ROOT/mount"
  export BACKUP_STAGING_PATH="$TMP_ROOT/staging"
  export BACKUP_RESTIC_PASSWORD_FILE="$TMP_ROOT/restic-password"
  export BACKUP_RETENTION_DAYS="30"
  export BACKUP_REPOSITORY="/backup/restic"
}

run_backup() {
  local name="$1"
  shift

  DRAGONS_STASH_DOCKER_CALLS="$TMP_ROOT/docker-calls-$name.log" \
    "$@" "$BACKUP_SCRIPT"
}

assert_restart_failure_makes_successful_backup_fail() {
  local output="$TMP_ROOT/restart-fails-output.log"

  setup_fake_environment
  if BACKUP_ASSERT_START_EXIT=9 run_backup restart-fails bash >"$output" 2>&1; then
    fail "backup reported success when restart failed"
  fi
  grep -q 'Failed to restart one or more previously running services' "$output" \
    || fail "restart failure did not produce an explicit error"
}

assert_backup_failure_exit_is_preserved_when_restart_also_fails() {
  local output="$TMP_ROOT/backup-and-restart-fail-output.log"
  local exit_code

  setup_fake_environment
  set +e
  BACKUP_ASSERT_BACKUP_EXIT=42 BACKUP_ASSERT_START_EXIT=9 run_backup backup-and-restart-fail bash >"$output" 2>&1
  exit_code=$?
  set -e

  [[ "$exit_code" -eq 42 ]] || fail "expected backup failure exit 42 to be preserved; got $exit_code"
  grep -q 'Failed to restart one or more previously running services' "$output" \
    || fail "restart failure did not produce an explicit error"
}

assert_restart_failure_makes_successful_backup_fail
assert_backup_failure_exit_is_preserved_when_restart_also_fails

printf 'run-backup assertions passed\n'
