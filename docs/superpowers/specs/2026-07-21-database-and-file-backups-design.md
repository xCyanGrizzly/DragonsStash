# Database and File Backup Design

**Date:** 2026-07-21
**Status:** Design approved for written-spec review
**Scope:** Disaster recovery for the Docker Compose deployment

## Problem

Dragon's Stash currently persists PostgreSQL in a Docker named volume and stores uploaded STL files in the `manual_uploads` volume. A Docker volume protects data from container recreation, but it is not an off-host backup. A host disk failure, accidental deletion, corruption, or ransomware event could destroy both the database and the files it references.

The worker currently deletes manual-upload directories after processing. The backup feature will change that behavior for new uploads so the existing `manual_uploads` volume becomes a durable STL archive. Files already deleted before this change cannot be reconstructed by the backup feature.

The Telegram worker and bot also persist authentication/session state in `tdlib_state` and `tdlib_bot_state`. These files are sensitive and losing them requires Telegram re-authentication.

## Goals

- Protect PostgreSQL data and uploaded STL files against loss of the application host.
- Preserve newly uploaded STL files after worker processing so the backup contains completed uploads, not only in-flight uploads.
- Store backups on a Synology NAS over an authenticated, host-restricted NFS share.
- Create one recoverable snapshot containing related database and file state.
- Retain 30 daily recovery points.
- Include Telegram worker and bot session state so a host restore does not require re-authentication.
- Provide a documented, repeatable restore process.
- Detect failed or corrupt backups instead of silently pruning the last good copy.

## Non-goals

- Building an in-app backup-management UI.
- Backing up temporary ZIP processing data in `tmp_zips`.
- Copying the raw `postgres_data` volume as the primary database backup.
- Recovering STL binaries that were deleted by older worker runs before durable retention was enabled.
- Providing protection against loss of the NAS itself. A later Synology Hyper Backup task can replicate this repository to another device or cloud destination.

## Selected approach

Use a Linux-host backup script, scheduled by a systemd timer, with Restic writing to an encrypted repository on a Synology NFS share.

This approach keeps the backup and restore workflow explicit, deduplicates large STL files across daily snapshots, and avoids tying recovery to PostgreSQL's internal data-directory layout. Restic's repository encryption also protects database contents, uploaded files, and Telegram session state if the NAS share is accessed directly.

## Storage layout

### Synology

Create a dedicated shared folder, for example `dragonsstash-backups`, with:

- NFS enabled only for the Docker host's fixed IP address.
- A restricted NFS export used only for this backup share, with host access limited to the Docker host's fixed IP address.
- No Internet exposure.
- Sufficient capacity for the repository plus growth and safety margin.

The Linux host mounts the share at a stable path such as `/mnt/dragonsstash-backups` using systemd-aware network mount options so a NAS outage does not block normal boot indefinitely.

### Restic repository

The repository lives below the mounted share. The Restic password is stored separately from the repository in a root-readable host secret file and must also be recorded in the operator's offline password-management system. Losing both the NAS and the only copy of the Restic password makes encrypted backups unrecoverable.

Each successful Restic snapshot contains:

- A PostgreSQL custom-format dump generated for that run.
- The contents of the `manual_uploads` Docker volume.
- The contents of the `tdlib_state` Docker volume.
- The contents of the `tdlib_bot_state` Docker volume.
- A small manifest with the backup timestamp, application image/version, and database migration state.

The `tmp_zips` volume is scratch space and is excluded.

## Backup flow

The systemd timer invokes one backup command at the chosen nightly time. The command:

1. Acquires an exclusive lock and refuses to run if another backup is active.
2. Verifies that the NFS mount is present, writable, and points to the expected backup directory.
3. Stops the `app`, `worker`, and `bot` services while leaving PostgreSQL running.
4. Creates a PostgreSQL custom-format dump from the running database.
5. Creates a manifest for the backup.
6. Runs one Restic backup over the dump and the read-only mounted Docker volumes.
7. Verifies that Restic created the snapshot successfully.
8. Applies the retention policy: keep the latest 30 daily snapshots, then prune unreferenced data.
9. Restarts all stopped services, whether the backup succeeded or failed.

The service-stop window ensures that application writes and TDLib session updates do not occur while the corresponding file volumes are being captured. A failed run must never trigger retention pruning.

New `ManualUploadFile` rows carry a retention timestamp. Restore verification requires retained file paths to exist and reports older rows without a retention timestamp as legacy warnings, because those binaries may already have been deleted before this feature was enabled.

## Restore flow

The restore tooling and documentation will support this sequence:

1. Stop `app`, `worker`, and `bot`.
2. Select and inspect a Restic snapshot.
3. Restore the PostgreSQL dump and volume contents to a staging location.
4. Preserve the current database and volumes or confirm that the operator intends to replace them.
5. Restore `manual_uploads`, `tdlib_state`, and `tdlib_bot_state` into their Docker volumes with the expected ownership and paths.
6. Restore the database from the custom-format dump into the configured PostgreSQL database.
7. Verify that `ManualUploadFile.filePath` values resolve to restored files and that the application health endpoint can connect to PostgreSQL.
8. Start the services and inspect logs for startup, migration, and worker/bot authentication errors.

The restore process must be safe to rehearse against a disposable Compose project without modifying the live deployment.

## Failure handling and verification

- A missing or read-only NAS mount fails the backup before services are stopped where possible.
- A lock prevents overlapping backups.
- A cleanup trap or equivalent guarantees service restart after errors.
- Backup failure produces a non-zero systemd result and a clear log entry.
- Retention pruning runs only after a verified successful snapshot.
- A snapshot listing and repository metadata check run after each backup.
- A full Restic integrity check and disposable restore test run monthly.
- The project documentation describes how to inspect the last successful snapshot and how to recover when the NAS is unavailable.

## Security considerations

- The NFS share is limited to the Docker host and is not exposed to the Internet.
- Restic encryption protects the repository at rest.
- PostgreSQL credentials, NAS credentials/rules, and the Restic password are never committed to the repository.
- Restore commands must avoid printing database passwords or the Restic password in logs.
- Telegram session volumes are included because they are operationally valuable, but they must be treated as secrets.

## Acceptance criteria

- A nightly systemd timer creates a Restic snapshot on the Synology share.
- A snapshot includes PostgreSQL, all uploaded STL files, and both Telegram session volumes.
- At least 30 daily recovery points are retained without duplicating unchanged STL content unnecessarily.
- Newly uploaded STL files remain in `manual_uploads` after worker processing and are included in subsequent backup snapshots.
- A simulated host-loss restore reconstructs the database and uploaded files in a disposable Compose environment.
- A failed backup leaves services running and preserves the last known-good snapshot.
- The restore procedure is documented well enough for an operator to execute without reading the implementation.
