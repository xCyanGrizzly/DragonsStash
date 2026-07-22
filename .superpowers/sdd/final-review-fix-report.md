# Backup Final Review Fix Report

## Implemented findings

- The backup container now validates that `RESTIC_REPOSITORY` resolves strictly
  below `/backup`, verifies that the Restic repository already has a readable
  configuration before a scheduled backup, and gives the explicit first-run
  initialization command when that preflight fails.
- The backup manifest now records every successfully applied Prisma migration
  as a JSON object with its name and UTC completion timestamp. The `psql`
  query uses the existing `DATABASE_URL` connection configuration and stops on
  query errors.
- Restore now requires `BACKUP_REPOSITORY`, validates that it resolves strictly
  below `/backup`, and validates the configured backup mount (including the
  existing writable probe) before `restore-live` can stop services or replace
  live data.
- The backup runbook now documents explicit repository initialization, monthly
  full-read Restic checks, a disposable restore/checksum rehearsal, and
  post-restore Compose status/log checks.

## Verification

- `bash -n scripts/backup/container-entrypoint.sh`
- `bash -n scripts/backup/restore.sh`
- Focused `rg` assertions for repository validation/preflight, migration
  timestamp metadata, restore mount validation, initialization, maintenance,
  and post-restore runbook commands.
- `npx prisma validate`
- `git diff --check`

## Scope and concerns

- No Docker, NAS, systemd, Restic repository, or live restore was run, per the
  bounded review scope. The command-level behavior is therefore statically
  validated only.
- Existing durable STL handling, the exact live-restore confirmation flag, and
  rollback/safety-artifact behavior were retained.
