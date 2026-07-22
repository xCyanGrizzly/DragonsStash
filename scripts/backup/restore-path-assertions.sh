#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
RESTORE_SCRIPT="$PROJECT_ROOT/scripts/backup/restore.sh"
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

target=""
previous=""
safety_output_host=""
safety_archive=""
for argument in "$@"; do
  if [[ "$previous" == "--target" ]]; then
    target="$argument"
  fi
  if [[ "$previous" == "-v" && "$argument" == *":/safety-output" ]]; then
    safety_output_host="${argument%:/safety-output}"
  fi
  if [[ "$argument" == /safety-output/pre-restore-*.tar ]]; then
    safety_archive="${argument#/safety-output/}"
  fi
  previous="$argument"
done

if [[ "${1:-}" == "compose" && "${2:-}" == "config" && "${3:-}" == "--format" && "${4:-}" == "json" ]]; then
  printf '{\n  "name": "dragonsstash"\n}\n'
  exit 0
fi

if [[ "${1:-}" == "volume" && "${2:-}" == "ls" ]]; then
  if [[ " $* " == *"com.docker.compose.volume=tdlib_state"* ]]; then
    printf 'dragonsstash_tdlib_state\n'
  elif [[ " $* " == *"com.docker.compose.volume=tdlib_bot_state"* ]]; then
    printf 'dragonsstash_tdlib_bot_state\n'
  fi
  exit 0
fi

if [[ " $* " == *" exec -T db pg_dump "* ]]; then
  printf 'custom dump\n'
  exit 0
fi

if [[ " $* " == *" backup restore "* ]]; then
  if [[ "$target" != /staging/* ]]; then
    printf 'Unexpected restore target: %s\n' "$target" >&2
    exit 1
  fi

  host_target="$BACKUP_STAGING_PATH/${target#/staging/}"
  mkdir -p \
    "$host_target/staging/backup-legacy/manifest" \
    "$host_target/data/tdlib-worker" \
    "$host_target/data/tdlib-bot"
  printf 'custom dump\n' > "$host_target/staging/backup-legacy/database.dump"
  printf '{}\n' > "$host_target/staging/backup-legacy/manifest/backup-manifest.json"

  if [[ "${RESTORE_ASSERT_CREATE_UNEXPECTED:-0}" == "1" ]]; then
    mkdir -p "$host_target/data/uploads" "$host_target/data/tmp-zips" "$host_target/data/postgres"
  fi
fi

if [[ -n "$safety_output_host" && -n "$safety_archive" ]]; then
  printf 'archive\n' > "$safety_output_host/$safety_archive"
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

  cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exit 0
EOF
  chmod +x "$fake_bin/curl"

  export PATH="$fake_bin:$PATH"
  export BACKUP_MOUNT_PATH="$TMP_ROOT/mount"
  export BACKUP_STAGING_PATH="$TMP_ROOT/staging"
  export BACKUP_RESTIC_PASSWORD_FILE="$TMP_ROOT/restic-password"
  export BACKUP_REPOSITORY="/backup/restic"
}

run_restore_to_staging() {
  local name="$1"
  shift

  DRAGONS_STASH_DOCKER_CALLS="$TMP_ROOT/docker-calls-$name.log" \
    "$@" "$RESTORE_SCRIPT" restore-to-staging snapshot-scope "$TMP_ROOT/staging/$name"
}

run_restore_live() {
  local name="$1"
  shift

  DRAGONS_STASH_DOCKER_CALLS="$TMP_ROOT/docker-calls-$name.log" \
    "$@" "$RESTORE_SCRIPT" restore-live snapshot-scope --confirm-replace-live-data
}

assert_restore_call_is_filtered() {
  local calls="$1"
  local restore_call

  restore_call="$(grep $'backup\trestore\tsnapshot-scope' "$calls" || true)"
  [[ -n "$restore_call" ]] || fail "restore command was not invoked"
  [[ "$restore_call" == *$'--include\t/staging/backup-*/database.dump'* ]] || fail "database dump include filter missing"
  [[ "$restore_call" == *$'--include\t/staging/backup-*/manifest\t'* ]] || fail "manifest include filter missing"
  [[ "$restore_call" == *$'--include\t/staging/backup-*/manifest/**'* ]] || fail "manifest subtree include filter missing"
  [[ "$restore_call" == *$'--include\t/data/tdlib-worker\t'* ]] || fail "worker TDLib root include filter missing"
  [[ "$restore_call" == *$'--include\t/data/tdlib-worker/**'* ]] || fail "worker TDLib subtree include filter missing"
  [[ "$restore_call" == *$'--include\t/data/tdlib-bot\t'* ]] || fail "bot TDLib root include filter missing"
  [[ "$restore_call" == *$'--include\t/data/tdlib-bot/**'* ]] || fail "bot TDLib subtree include filter missing"
  [[ "$restore_call" != *"/data/uploads"* ]] || fail "restore includes uploads path"
}

assert_restore_uses_include_filters() {
  local calls="$TMP_ROOT/docker-calls-safe.log"

  setup_fake_environment
  run_restore_to_staging safe bash >/dev/null

  assert_restore_call_is_filtered "$calls"
}

assert_live_restore_uses_include_filters() {
  local calls="$TMP_ROOT/docker-calls-live.log"

  setup_fake_environment
  run_restore_live live bash >/dev/null

  assert_restore_call_is_filtered "$calls"
}

assert_unexpected_volume_content_is_rejected() {
  local output="$TMP_ROOT/unexpected-output.log"

  setup_fake_environment
  if RESTORE_ASSERT_CREATE_UNEXPECTED=1 run_restore_to_staging unexpected bash >"$output" 2>&1; then
    fail "restore accepted unexpected restored data volume content"
  fi
  grep -Eq 'Unexpected restored data volume content|Refusing restore' "$output" \
    || fail "restore rejected unexpected content without an explicit guard message"
}

assert_restore_uses_include_filters
assert_live_restore_uses_include_filters
assert_unexpected_volume_content_is_rejected

printf 'restore-path assertions passed\n'
