# Scope correction implementation report

## Summary

Implemented the approved backup scope correction for Dragon's Stash. Backups and restores now cover only:

- PostgreSQL logical custom-format dump plus manifest/migration metadata.
- `tdlib_state` worker Telegram session volume.
- `tdlib_bot_state` bot Telegram session volume.

The implementation no longer treats `manual_uploads`, completed local STL binaries, or `tmp_zips` as protected backup data. Future channel forwarding and archive/STL-content integrity auditing remain out of scope.

## Changed files

- `docker-compose.yml`
  - Removed the backup service's read-only `manual_uploads:/data/uploads` mount.
  - Kept the normal operational app/worker `manual_uploads` mounts.
  - Kept both TDLib backup mounts.

- `scripts/backup/container-entrypoint.sh`
  - Removed `/data/uploads` as a required mounted directory.
  - Removed uploads from the manifest `volumePaths`.
  - Removed the `source:uploads` Restic tag.
  - Removed uploads from the Restic source list.
  - Kept database dump, manifest, worker TDLib, and bot TDLib sources/tags.

- `scripts/backup/restore.sh`
  - Removed restored uploads variables.
  - Removed uploads staging validation.
  - Removed manual uploads volume discovery, safety archive, replacement, and rollback.
  - Removed retained/manual upload file-path verification.
  - Removed temporary database verification that existed only for local upload file references.
  - Preserved guarded `restore-live` confirmation, backup mount/repository checks, service stop/start handling, safety PostgreSQL dump, TDLib volume safety archives, TDLib volume replacement/rollback, and `pg_restore --list`/`pg_restore --exit-on-error` validation.

- `prisma/schema.prisma`
  - Removed `ManualUploadFile.retainedAt`.

- `prisma/migrations/20260722100000_remove_retained_manual_files/migration.sql`
  - Added forward migration: `ALTER TABLE "manual_upload_files" DROP COLUMN IF EXISTS "retainedAt";`
  - Preserved the existing committed migration that added `retainedAt`.

- `src/app/api/uploads/route.ts`
  - Removed `retainedAt: new Date()` from manual upload file creation.

- `worker/src/manual-upload.ts`
  - Restored final best-effort cleanup of `/data/uploads/<uploadId>` using the older `path.join("/data/uploads", uploadId)` behavior.

- `scripts/backup/README.md`
  - Rewrote backup set and restore rehearsal docs around PostgreSQL plus both TDLib volumes only.
  - Removed local STL file, retainedAt, upload path, retained file reference, and restored checksum checks.
  - Clarified that STL binaries remain in Telegram and recovery preserves database mappings/Telegram IDs.
  - Kept monthly `restic check --read-data` and disposable restore rehearsal runbook.
  - Explicitly left future channel forwarding and archive/STL-content integrity auditing out of scope.

- `README.md`
  - Updated the production backup summary to name PostgreSQL logical dump plus Telegram session volumes as the protected set.
  - Clarified that `manual_uploads` and temporary ZIPs are excluded and STL binaries remain in Telegram.

## Verification

- `git diff --check`
  - Passed.

- `bash -n scripts/backup/container-entrypoint.sh scripts/backup/run-backup.sh scripts/backup/restore.sh`
  - Local `bash` failed because Windows only had the WSL shim and no installed WSL distribution.
  - Passed via Docker fallback:
    `docker run --rm --entrypoint bash -v E:\Projects\DragonsStash:/work:ro -w /work postgres:16-alpine -n scripts/backup/container-entrypoint.sh scripts/backup/run-backup.sh scripts/backup/restore.sh`

- `npx prisma validate`
  - Passed.

- `npm run build`
  - Passed.

- `cd worker && npm run build`
  - Passed.

- Focused backup/restore scope assertions
  - Backup shell paths assertion passed: no `manual_uploads`, `/data/uploads`, `retainedAt`, upload source tag, or upload-restore helper references in `scripts/backup/*.sh`.
  - Compose backup service assertion passed: no `manual_uploads`, `/data/uploads`, `retainedAt`, or `source:uploads` in the `backup` service block.
  - Active retainedAt assertion passed: no `retainedAt` in active Prisma schema, upload API, worker source, or backup shell scripts.
  - Active backup/restore upload-source assertion passed: no `manual_uploads`, `/data/uploads`, or `data/uploads` in backup/restore shell scripts.
  - Remaining expected matches are limited to normal operational app/worker upload mounts and paths, docs stating exclusions, and the historical add/drop migrations.

## Concerns

- None for implementation scope.
- Environment note: local Bash is unavailable because WSL has no installed distribution; Bash syntax was verified inside Docker instead.

---

# Restore Path Scope Review-Finding Fix

**Date:** 2026-07-22

## Fix

Addressed the Important restore finding by replacing both unrestricted
`restic restore` calls in `scripts/backup/restore.sh` with a shared filtered
restore wrapper. The wrapper restores only the backup source paths actually
written by `scripts/backup/container-entrypoint.sh`:

- `/staging/backup-*/database.dump`
- `/staging/backup-*/manifest` and `/staging/backup-*/manifest/**`
- `/data/tdlib-worker` and `/data/tdlib-worker/**`
- `/data/tdlib-bot` and `/data/tdlib-bot/**`

Added an explicit restored-tree guard that refuses unexpected restored content:
top-level restored directories other than `staging` and `data`, direct
`data/*` entries other than `tdlib-worker` and `tdlib-bot`, and direct
`staging/backup-*/*` entries other than `database.dump` and `manifest`. This
rejects old/broad snapshots that would otherwise restore `data/uploads`,
temporary ZIP or database volume trees, or other unexpected volume content.

Preserved the existing guarded live-restore confirmation, staging-directory
validation, mount/repository checks, snapshot verification, custom
PostgreSQL-dump validation, service stop/start lifecycle, health check, safety
database dump, TDLib safety archives, and rollback of exactly the PostgreSQL
database plus the two TDLib volumes.

Added `scripts/backup/restore-path-assertions.sh`, a focused shell assertion
harness that stubs Docker/Restic and verifies both staging and live restore use
the expected include filters and that unexpected restored data-volume content is
rejected explicitly.

Addressed the Minor documentation gap in the root README backup section by
stating that forwarding behavior and archive/STL-content integrity auditing are
future work outside the backup scope.

## Verification

- Red check before implementation:

  ```text
  & 'C:\Program Files\Git\bin\bash.exe' -lc 'scripts/backup/restore-path-assertions.sh'
  ASSERTION FAILED: database dump include filter missing
  ```

- Bash syntax check:

  ```text
  & 'C:\Program Files\Git\bin\bash.exe' -lc 'bash -n scripts/backup/container-entrypoint.sh scripts/backup/run-backup.sh scripts/backup/restore.sh scripts/backup/restore-path-assertions.sh'
  [passed with no output]
  ```

- Whitespace check:

  ```text
  git diff --check
  warning: in the working copy of '.superpowers/sdd/scope-correction-implementation-report.md', LF will be replaced by CRLF the next time Git touches it
  warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
  warning: in the working copy of 'scripts/backup/restore.sh', LF will be replaced by CRLF the next time Git touches it
  [exit 0]
  ```

- Focused restore-path assertions:

  ```text
  & 'C:\Program Files\Git\bin\bash.exe' -lc 'scripts/backup/restore-path-assertions.sh'
  restore-path assertions passed
  ```

## Concerns

- None for implementation scope.
- Git Bash was available and used for shell syntax/assertion checks, so Docker
  fallback was not needed for the final syntax verification.

---

# Important Operational Findings Fix

**Date:** 2026-07-22

## Fix

Addressed the two Important operational findings from final review:

- `scripts/backup/run-backup.sh`
  - Backup wrapper restart failures now make an otherwise successful backup
    exit non-zero.
  - Existing non-zero backup failures remain preserved if service restart also
    fails.
  - Added `scripts/backup/run-backup-assertions.sh` to assert both exit-code
    cases with a fake Docker/Compose environment.

- `scripts/backup/restore.sh`
  - `restore-live` now captures the managed services that were running before
    live restore using `docker compose --profile full ps --status running`.
  - Live restore stops only those previously running managed services.
  - Successful live restore starts only those previously running services, so
    the profile-gated optional `bot` is not started if it was not running.
  - Failure handling leaves services stopped and still rolls back only the
    PostgreSQL database plus both TDLib volumes.
  - App health wait now runs only when `app` was previously running.
  - Extended `scripts/backup/restore-path-assertions.sh` to assert subset
    stop/start behavior and skipped health checks when `app` was not running.

Addressed the Minor staging-path documentation mismatch by aligning
`.env.example` with the backup README example:
`/var/lib/dragons-stash/backup-staging`.

## Verification

- Red checks before implementation:
  - `docker run --rm -v "${PWD}:/work" -w /work ubuntu:24.04 bash scripts/backup/run-backup-assertions.sh`
    - Failed as expected: backup reported success when restart failed.
  - `docker run --rm -v "${PWD}:/work" -w /work ubuntu:24.04 bash scripts/backup/restore-path-assertions.sh`
    - Failed as expected: restore-live stopped the fixed `app worker bot`
      service set instead of the running subset.

- Focused assertions after implementation:
  - `docker run --rm -v "${PWD}:/work" -w /work ubuntu:24.04 bash scripts/backup/run-backup-assertions.sh`
    - Passed.
  - `docker run --rm -v "${PWD}:/work" -w /work ubuntu:24.04 bash scripts/backup/restore-path-assertions.sh`
    - Passed.

- `git diff --check`
  - Passed.

- Docker Bash syntax check:
  - `docker run --rm -v "${PWD}:/work" -w /work ubuntu:24.04 bash -n scripts/backup/run-backup.sh scripts/backup/restore.sh scripts/backup/container-entrypoint.sh scripts/backup/restore-path-assertions.sh scripts/backup/run-backup-assertions.sh`
  - Passed.

- `npx prisma validate`
  - Passed.

- `npm run build`
  - Passed.

- `npm run lint`
  - Failed on unrelated existing React lint issues in `src/` and mirrored
    `.worktrees/worker-improvements` files; no failures were in touched backup
    files.

## Concerns

- Local `bash` is unavailable because the Windows `bash` command resolves to a
  WSL shim with no installed distribution; shell checks used Docker fallback.
- Full `npm run lint` remains blocked by pre-existing unrelated lint errors.
