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
