#!/bin/bash
set -uo pipefail

# Ensure the repo exists, but never crash-loop on it: a transient error reading
# the repo (CIFS hiccup, stale lock) must not kill PID 1. `restic init` failing
# because the repo already exists is expected and harmless here.
if ! restic cat config >/dev/null 2>&1; then
  restic init || echo "restic init skipped (repo already exists or temporarily unreachable)"
fi

exec crond -f -l 2
