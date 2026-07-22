#!/bin/bash
set -euo pipefail

if ! restic snapshots >/dev/null 2>&1; then
  restic init
fi

exec crond -f -l 2
