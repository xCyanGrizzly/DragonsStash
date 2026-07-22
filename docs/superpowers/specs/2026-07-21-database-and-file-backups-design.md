# Database and File Backup Design

**Date:** 2026-07-21
**Status:** Design approved for written-spec review
**Scope:** Disaster recovery for the Docker Compose deployment

## Problem

Dragon's Stash currently persists PostgreSQL in a Docker named volume. The Telegram worker and bot also persist authentication and session state in the `tdlib_state` and `tdlib_bot_state` volumes. Docker volumes protect against container recreation, but they are not off-host backups. A host disk failure, accidental deletion, corruption, or ransomware event could destroy the database and require both Telegram clients to authenticate again.

STL binaries are intentionally not retained as a local recovery set. They remain in Telegram. The PostgreSQL database preserves the archive, message, package, and file metadata needed to locate and send those Telegram-hosted binaries after the application database is restored. Existing worker cleanup behavior is unchanged.

## Goals

- Protect PostgreSQL data against loss of the application host with a logical backup.
- Preserve Telegram worker and bot session state so a host restore does not normally require re-authentication.
- Store backups on a Synology NAS over an authenticated, host-restricted NFS share.
- Create one recoverable snapshot containing related database and session state.
- Retain 30 daily recovery points.
- Provide a documented, repeatable, guarded restore process.
- Detect failed or corrupt backups instead of silently pruning the last good copy.

## Non-goals

- Building an in-app backup-management UI.
- Backing up `manual_uploads`, retaining completed STL binaries locally, or changing worker cleanup behavior.
- Backing up temporary ZIP processing data in `tmp_zips`.
- Copying the raw `postgres_data` volume as the primary database backup.
- Implementing future Telegram channel-forwarding behavior.
- Validating the content or binary integrity of Telegram archives or STL files. This is future work and is outside the backup/restore feature.
- Providing protection against loss of the NAS itself. A later Synology Hyper Backup task can replicate this repository to another device or cloud destination.

## Selected approach

Use a Linux-host backup script, scheduled by a systemd timer, with Restic writing to an encrypted repository on a Synology NFS share.

This approach keeps backup and restore explicit, avoids tying recovery to PostgreSQL's internal data-directory layout, and captures the sensitive TDLib state alongside the database. Restic repository encryption protects database contents and Telegram session state if the NAS share is accessed directly.

## Storage layout

### Synology

Create a dedicated shared folder, for example `dragonsstash-backups`, with:

- The dedicated backup shared folder is exported through NFS only to the Docker host's fixed IP address.
- No Internet exposure.
- Sufficient capacity for the repository plus growth and safety margin.

The Linux host mounts the share at a stable path such as `/mnt/dragonsstash-backups` using systemd-aware network mount options so a NAS outage does not block normal boot indefinitely.

### Restic repository

The repository lives below the mounted share. The Restic password is stored separately from the repository in a root-readable host secret file and must also be recorded in the operator's offline password-management system. Losing both the NAS and the only copy of the Restic password makes encrypted backups unrecoverable.

Each successful Restic snapshot contains:

- A PostgreSQL custom-format dump generated for that run.
- The contents of the `tdlib_state` Docker volume.
- The contents of the `tdlib_bot_state` Docker volume.
- A small manifest with the backup timestamp, application image/version, database migration state, and captured volume paths.

The `manual_uploads` and `tmp_zips` volumes are excluded. STL binaries continue to live in Telegram; the restored database supplies the metadata and mappings required for the worker and bot to locate and send them.

## Backup flow

The systemd timer invokes one backup command at the chosen nightly time. The command:

1. Acquires an exclusive lock and refuses to run if another backup is active.
2. Verifies that the NFS mount is present, writable, and points to the expected backup directory.
3. Stops the `app`, `worker`, and `bot` services while leaving PostgreSQL running.
4. Creates a PostgreSQL custom-format dump from the running database.
5. Creates a manifest for the backup.
6. Runs one Restic backup over the dump and the read-only mounted TDLib session volumes.
7. Verifies that Restic created the snapshot successfully.
8. Applies the retention policy: keep the latest 30 daily snapshots, then prune unreferenced data.
9. Restarts all stopped services, whether the backup succeeded or failed.

The service-stop window ensures that application writes and TDLib session updates do not occur while the corresponding data is captured. A failed run must never trigger retention pruning.

## Restore flow

The restore tooling and documentation will support this sequence:

1. Stop `app`, `worker`, and `bot` for a live restore.
2. Select and inspect a Restic snapshot.
3. Restore the PostgreSQL dump and TDLib session contents to a staging location.
4. Preserve the current database and volumes or confirm that the operator intends to replace them.
5. Restore `tdlib_state` and `tdlib_bot_state` into their Docker volumes with the expected ownership and paths.
6. Restore the database from the custom-format dump into the configured PostgreSQL database.
7. Verify the dump, session-volume layout, database connectivity, and worker/bot authentication startup state.
8. Start the services and inspect logs for startup, migration, and worker/bot authentication errors.

After restore, existing database metadata and mappings allow normal Telegram-based STL lookup and delivery. Restoring STL binaries, forwarding Telegram content, and checking archive/STL binary integrity are outside this restore flow.

The restore process must be safe to rehearse against a disposable Compose project without modifying the live deployment.

## Failure handling and verification

- A missing or read-only NAS mount fails the backup before services are stopped where possible.
- A lock prevents overlapping backups.
- A cleanup trap or equivalent guarantees service restart after errors.
- Backup failure produces a non-zero systemd result and a clear log entry.
- Retention pruning runs only after a verified successful snapshot.
- A snapshot listing and repository metadata check run after each backup.
- The deployment operator completes and records a monthly operational check: `restic check --read-data` followed by a disposable restore rehearsal. This verifies only the PostgreSQL logical dump and TDLib session-state recovery set; archive/STL-content integrity and future forwarding checks remain out of scope.
- The project documentation describes how to inspect the last successful snapshot and how to recover when the NAS is unavailable.

## Security considerations

- The NFS share is limited to the Docker host and is not exposed to the Internet.
- Restic encryption protects the repository at rest.
- PostgreSQL credentials, NAS credentials/rules, and the Restic password are never committed to the repository.
- Restore commands must avoid printing database passwords or the Restic password in logs.
- Telegram session volumes are included because they are operationally valuable, but they must be treated as secrets.

## Acceptance criteria

- A nightly systemd timer creates a Restic snapshot on the Synology share.
- A snapshot includes a PostgreSQL logical dump and both Telegram session volumes, while excluding `manual_uploads` and `tmp_zips`.
- At least 30 daily recovery points are retained.
- Each month, the deployment operator runs and records a full `restic check --read-data` and a disposable restore rehearsal of the PostgreSQL dump plus both TDLib session volumes.
- A simulated host-loss restore reconstructs the database and Telegram session state in a disposable Compose environment.
- The restored database retains the Telegram metadata and mappings the worker and bot use to locate and send STL binaries that remain in Telegram.
- A failed backup leaves services running and preserves the last known-good snapshot.
- The restore procedure is documented well enough for an operator to execute without reading the implementation.
