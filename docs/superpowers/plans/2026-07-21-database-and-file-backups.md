# Database and File Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly, encrypted, deduplicated disaster-recovery backup for PostgreSQL, uploaded STL files, and Telegram session volumes, stored on a Synology NAS.

**Architecture:** A Linux-host systemd timer invokes a host orchestration script. The script verifies the mounted Synology NFS share, stops the app/worker/bot services for consistency, and runs a one-shot Docker Compose backup service. The backup service creates a PostgreSQL custom-format dump and stores it together with the three persistent file volumes in a Restic repository on the NAS. A guarded restore command reconstructs the database and volumes, and documentation describes setup and testing.

**Tech Stack:** Docker Compose, PostgreSQL 16 `pg_dump`/`pg_restore`, Restic repository encryption and retention, Synology NFS, Linux systemd service/timer, Bash.

## Global Constraints

- PostgreSQL data must be backed up as a logical custom-format dump; the raw `postgres_data` volume is not the primary backup.
- The `manual_uploads`, `tdlib_state`, and `tdlib_bot_state` volumes are included in every successful snapshot.
- The `tmp_zips` scratch volume is excluded.
- The Docker host must stop `app`, `worker`, and `bot` while volumes are captured; PostgreSQL remains running for `pg_dump`.
- The backup repository is encrypted and stored on a Synology NFS share restricted to the Docker host.
- Retention is 30 daily snapshots; pruning is allowed only after a verified successful backup.
- A failed run must restart services and preserve the last known-good snapshot.
- No in-app backup UI is part of this implementation.
- The repository has no automated test framework; verification uses Bash syntax checks, Docker Compose validation, logs, Restic checks, and a disposable restore rehearsal.

---

## File and Responsibility Map

Create or modify only these focused units:

- Create `backup/Dockerfile`: build the one-shot image containing PostgreSQL client tools, Restic, Bash, and the backup entrypoint.
- Create `scripts/backup/container-entrypoint.sh`: run the backup inside Compose, including dump creation, manifest creation, Restic snapshot, verification, and retention.
- Create `scripts/backup/run-backup.sh`: host-level lock, NFS mount validation, service stop/start, and invocation of the one-shot Compose service.
- Create `scripts/backup/restore.sh`: guarded restore orchestration for a selected Restic snapshot.
- Create `deploy/systemd/dragons-stash-backup.service`: systemd unit invoking the host backup script.
- Create `deploy/systemd/dragons-stash-backup.timer`: nightly schedule.
- Create `scripts/backup/README.md`: Synology setup, host mount, secrets, first backup, restore, and operational troubleshooting.
- Modify `docker-compose.yml`: add the profile-gated one-shot `backup` service and its read-only volume mounts.
- Modify `.env.example`: document backup mount, staging, repository, and secret-file configuration without committing secrets.
- Modify `README.md`: add the production backup setup and restore entry points, linking to the detailed backup guide.

---

### Task 1: Add the backup service and configuration contract

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Create: `backup/Dockerfile`

**Interfaces:**
- Consumes: existing `db`, `manual_uploads`, `tdlib_state`, and `tdlib_bot_state` Compose resources.
- Produces: a profile-gated Compose service named `backup` that mounts the three file volumes read-only, connects to the `backend` network, and exposes `/backup` and `/staging` to the container entrypoint.

- [ ] **Step 1: Add explicit backup environment variables to `.env.example`**

Add this block without real credentials:

```dotenv
# Disaster recovery backups
BACKUP_MOUNT_PATH="/mnt/dragonsstash-backups"
BACKUP_STAGING_PATH="/var/lib/dragons-stash-backup/staging"
BACKUP_REPOSITORY="/backup/restic"
BACKUP_RESTIC_PASSWORD_FILE="/etc/dragons-stash/restic-password"
BACKUP_RETENTION_DAYS=30
BACKUP_APP_VERSION="unknown"
```

- [ ] **Step 2: Add the profile-gated `backup` service to `docker-compose.yml`**

Add a service with these properties:

```yaml
  backup:
    profiles: ["backup"]
    build:
      context: .
      dockerfile: backup/Dockerfile
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-dragons}:${POSTGRES_PASSWORD:-stash}@db:5432/${POSTGRES_DB:-dragonsstash}
      RESTIC_REPOSITORY: ${BACKUP_REPOSITORY:-/backup/restic}
      RESTIC_PASSWORD_FILE: /run/secrets/restic-password
      BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-30}
      BACKUP_APP_VERSION: ${BACKUP_APP_VERSION:-unknown}
    user: "0:0"
    volumes:
      - manual_uploads:/data/uploads:ro
      - tdlib_state:/data/tdlib-worker:ro
      - tdlib_bot_state:/data/tdlib-bot:ro
      - ${BACKUP_MOUNT_PATH:?Set BACKUP_MOUNT_PATH to the mounted Synology share}:/backup:rw
      - ${BACKUP_STAGING_PATH:?Set BACKUP_STAGING_PATH to a local staging directory}:/staging:rw
      - ${BACKUP_RESTIC_PASSWORD_FILE:?Set BACKUP_RESTIC_PASSWORD_FILE to a root-readable secret file}:/run/secrets/restic-password:ro
    depends_on:
      db:
        condition: service_healthy
    networks:
      - backend
```

Ensure the new service does not have `restart: always` and is not started by the normal production `docker compose up -d` command unless the `backup` profile is explicitly requested.

- [ ] **Step 3: Create the backup image definition**

Create `backup/Dockerfile`:

```dockerfile
FROM postgres:16-alpine

RUN apk add --no-cache bash restic coreutils

COPY scripts/backup/container-entrypoint.sh /usr/local/bin/dragons-stash-backup
RUN chmod 0755 /usr/local/bin/dragons-stash-backup

ENTRYPOINT ["/usr/local/bin/dragons-stash-backup"]
```

- [ ] **Step 4: Validate the Compose contract**

Run on a Linux host with the required variables available:

```bash
docker compose --profile backup config --quiet
```

Expected: exit code `0` and no Compose validation errors. If the required NAS/secret paths are absent, the command must fail with the explicit variable-name error rather than silently using a host path.

- [ ] **Step 5: Commit the service boundary**

```bash
git add backup/Dockerfile docker-compose.yml .env.example
git commit -m "feat: add backup compose service"
```

### Task 2: Implement the one-shot backup container

**Files:**
- Create: `scripts/backup/container-entrypoint.sh`

**Interfaces:**
- Consumes: `DATABASE_URL`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `BACKUP_RETENTION_DAYS`, `/data/uploads`, `/data/tdlib-worker`, `/data/tdlib-bot`, `/backup`, and `/staging`.
- Produces: exit `0` only after a verified Restic snapshot and successful retention pruning; non-zero on any failed dump, snapshot, verification, or prune step.

- [ ] **Step 1: Define strict shell behavior and required inputs**

The script must begin with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
```

Validate that `DATABASE_URL`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, and `BACKUP_RETENTION_DAYS` are set, that the password file is readable, and that `/backup` and `/staging` are mounted directories.

- [ ] **Step 2: Create a per-run staging directory and cleanup trap**

Use a directory below `/staging` named with UTC timestamp and process ID. Register an `EXIT` trap that removes only that directory. Never remove `/staging` itself or any directory under `/backup`.

- [ ] **Step 3: Create the PostgreSQL dump**

Run `pg_dump` using the connection URL and custom format:

```bash
pg_dump --format=custom --file="$RUN_DIR/database.dump" "$DATABASE_URL"
```

After the command succeeds, require the dump to be a non-empty regular file. Generate a SHA-256 checksum for the dump in the manifest directory.

- [ ] **Step 4: Create the manifest**

Write a JSON manifest containing the UTC backup timestamp, repository path, retention value, dump filename, dump checksum, and the three volume paths captured. Obtain the application image/version from an explicit `BACKUP_APP_VERSION` environment value when supplied; otherwise record `unknown` rather than guessing from mutable container state.

- [ ] **Step 5: Create one Restic snapshot**

Run one `restic backup` command against the staged database dump, manifest, and the three mounted persistent volumes. Use stable source labels so the snapshot can be recognized during restore. Do not include `/data/uploads` more than once and do not pass `/data/tdlib` or `/tmp/zips` paths that are not mounted.

- [ ] **Step 6: Verify and apply retention**

After `restic backup` succeeds:

```bash
restic snapshots --latest 1
restic check
restic forget --keep-daily "$BACKUP_RETENTION_DAYS" --prune
```

If any command fails, exit non-zero and do not run `forget --prune`. The host wrapper will restart the stopped services. When invoked with an unrecognized first argument, the entrypoint must pass the remaining arguments to the `restic` binary so operators can inspect the repository through the Compose image without installing Restic on the host:

```bash
case "${1:-backup}" in
  backup) run_backup ;;
  restore) run_restore "$@" ;;
  *) exec restic "$@" ;;
esac
```

- [ ] **Step 7: Build and run a container-only smoke test**

Run:

```bash
docker build -f backup/Dockerfile -t dragons-stash-backup:smoke .
bash -n scripts/backup/container-entrypoint.sh
```

Expected: image build succeeds and Bash reports no syntax errors. The full snapshot test waits until the host wrapper and a real PostgreSQL/volume environment exist.

- [ ] **Step 8: Commit the backup container**

```bash
git add backup/Dockerfile scripts/backup/container-entrypoint.sh
git commit -m "feat: implement encrypted database and volume snapshots"
```

### Task 3: Add the host orchestration script and nightly systemd timer

**Files:**
- Create: `scripts/backup/run-backup.sh`
- Create: `deploy/systemd/dragons-stash-backup.service`
- Create: `deploy/systemd/dragons-stash-backup.timer`

**Interfaces:**
- Consumes: `.env`/deployment environment, the mounted `BACKUP_MOUNT_PATH`, Docker Compose project, and the `backup` service from Task 1.
- Produces: one host command that safely stops and restarts services and returns the backup container's exit status; systemd runs it nightly.

- [ ] **Step 1: Implement lock and mount validation**

The host script must use `flock` on `/run/lock/dragons-stash-backup.lock`, reject a concurrent run, and validate the NAS mount with both `mountpoint --q "$BACKUP_MOUNT_PATH"` and a writable probe file that is immediately removed. A local directory at the same path must not pass validation. The script reads `BACKUP_MOUNT_PATH`, `BACKUP_STAGING_PATH`, `BACKUP_RESTIC_PASSWORD_FILE`, and `BACKUP_RETENTION_DAYS` from the systemd environment file.

- [ ] **Step 2: Capture service state and define guaranteed restart**

Before stopping services, record which of `app`, `worker`, and `bot` are running with `docker compose ps --status running -q SERVICE`. Stop only the services that were running. Register an `EXIT` trap that starts exactly those services and preserves the backup command's original exit code.

- [ ] **Step 3: Invoke the profile-gated backup service**

After the services stop, run:

```bash
docker compose --profile backup run --rm backup backup
```

Pass through the container exit code. The wrapper must not call the Restic retention command itself; that responsibility stays inside the backup container.

- [ ] **Step 4: Add the systemd service**

Create a unit with `Type=oneshot`, `User=root`, `EnvironmentFile=-/etc/dragons-stash/backup.env`, `WorkingDirectory` set to the production Compose directory, `ExecStart` pointing to the absolute `run-backup.sh` path, and `TimeoutStartSec=infinity`. Configure `After=network-online.target docker.service` and `Requires=docker.service`. Do not put the Restic password or database password in the unit file.

- [ ] **Step 5: Add the nightly timer**

Create a timer using `OnCalendar=*-*-* 03:00:00`, `Persistent=true`, and `RandomizedDelaySec=15m`. Set `Unit=dragons-stash-backup.service` and `WantedBy=timers.target`.

- [ ] **Step 6: Validate shell and systemd files**

Run:

```bash
bash -n scripts/backup/run-backup.sh
systemd-analyze verify deploy/systemd/dragons-stash-backup.service deploy/systemd/dragons-stash-backup.timer
```

Expected: both commands exit `0`. Run `systemctl list-timers dragons-stash-backup.timer` after installation and confirm the next run is scheduled.

- [ ] **Step 7: Commit scheduling and orchestration**

```bash
git add scripts/backup/run-backup.sh deploy/systemd/dragons-stash-backup.service deploy/systemd/dragons-stash-backup.timer
git commit -m "feat: schedule nightly off-host backups"
```

### Task 4: Make completed STL uploads durable and implement guarded restore tooling

**Files:**
- Create: `scripts/backup/restore.sh`
- Create: `prisma/migrations/20260722000000_mark_retained_manual_files/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `src/app/api/uploads/route.ts`
- Modify: `worker/src/manual-upload.ts`

**Interfaces:**
- Consumes: a Restic snapshot ID, the same repository/password configuration, the backup Compose service, and the live Compose project.
- Produces: durable completed manual-upload files in the existing `manual_uploads` volume; restored PostgreSQL data and persistent volumes only after explicit confirmation for live replacement; a non-destructive staging restore by default.

- [ ] **Step 1: Make new manual-upload files durable**

Add nullable `retainedAt DateTime?` to `ManualUploadFile`. Create an additive migration that leaves existing rows `NULL`. Set `retainedAt: new Date()` when `src/app/api/uploads/route.ts` creates each new file record. Remove the worker's final recursive deletion of `/data/uploads/<uploadId>` while retaining split-file cleanup. This makes the existing `manual_uploads` volume the durable STL archive for new uploads.

Document and report that files already deleted by older worker runs cannot be reconstructed by this feature. The restore verifier must treat `retainedAt IS NULL` rows as legacy warnings and must require every `retainedAt IS NOT NULL` path to exist.

- [ ] **Step 2: Define restore modes and destructive guard**

Support these commands:

```bash
./scripts/backup/restore.sh list
./scripts/backup/restore.sh verify SNAPSHOT_ID
./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID STAGING_DIR
./scripts/backup/restore.sh restore-live SNAPSHOT_ID --confirm-replace-live-data
```

Reject `restore-live` unless the exact confirmation flag is present. `list`, `verify`, and `restore-to-staging` must not stop services or modify live volumes.

- [ ] **Step 3: Implement snapshot verification and staging restore**

Use `restic snapshots`, `restic check`, and `restic restore SNAPSHOT_ID --target STAGING_DIR`. Verify that the restored staging tree contains a non-empty custom-format dump, a manifest, `manual_uploads`, `tdlib-worker`, and `tdlib-bot` before reporting success.

- [ ] **Step 4: Implement live restore sequencing**

For `restore-live`:

1. Confirm the Compose project and target repository.
2. Stop `app`, `worker`, and `bot`.
3. Create a safety PostgreSQL dump of the current database into local staging.
4. Restore the selected snapshot to a separate staging directory.
5. Replace the three Docker volumes only after the restored tree passes validation, including retained STL files in `manual_uploads`.
6. Recreate the configured database from the restored custom-format dump using `pg_restore --no-owner`.
7. Start services and run the health endpoint plus file-reference verification.

If any step fails, leave the services stopped, print the exact staging path and failure, and do not delete the safety dump.

- [ ] **Step 5: Add file-reference verification**

Run a small SQL query against `manual_upload_files` to enumerate retained `filePath` values and check each path inside the restored `/data/uploads` tree. Report legacy rows with `retainedAt IS NULL` as warnings. Return non-zero if any retained database reference is broken.

- [ ] **Step 6: Validate the restore command without touching live data**

Run:

```bash
bash -n scripts/backup/restore.sh
./scripts/backup/restore.sh list
```

Expected: syntax passes and `list` prints available snapshot IDs without stopping any service or modifying a volume.

- [ ] **Step 7: Commit durable STL retention and restore tooling**

```bash
git add scripts/backup/restore.sh prisma/schema.prisma prisma/migrations/20260722000000_mark_retained_manual_files/migration.sql src/app/api/uploads/route.ts worker/src/manual-upload.ts
git commit -m "feat: retain uploaded STL files for recovery"
```

### Task 5: Document Synology setup, operations, and recovery

**Files:**
- Create: `scripts/backup/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the exact environment variables, systemd units, and restore commands from Tasks 1–4.
- Produces: operator-facing instructions that do not require reading implementation files.

- [ ] **Step 1: Document Synology configuration**

Document creating the `dragonsstash-backups` shared folder, enabling NFS, restricting the export to the Docker host's fixed IP, and mounting it at `/mnt/dragonsstash-backups`. Include commands for checking the mount:

```bash
mountpoint /mnt/dragonsstash-backups
touch /mnt/dragonsstash-backups/.write-test
rm /mnt/dragonsstash-backups/.write-test
```

Do not document exposing NFS to the Internet.

- [ ] **Step 2: Document secret and staging setup**

Document creating the root-readable Restic password file at `/etc/dragons-stash/restic-password`, creating the local staging directory, setting ownership/permissions, and adding the backup variables to the production environment without committing secrets.

- [ ] **Step 3: Document installation and first-run commands**

Include:

```bash
sudo install -m 0644 deploy/systemd/dragons-stash-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/dragons-stash-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dragons-stash-backup.timer
sudo systemctl start dragons-stash-backup.service
sudo journalctl -u dragons-stash-backup.service -n 100 --no-pager
```

Explain that the first run may be long because it uploads all existing STL and session data; later Restic snapshots deduplicate unchanged data.

- [ ] **Step 4: Document monitoring, retention, and restore**

Document how to inspect timer status, service failures, Restic snapshots, repository checks, and the four restore modes. Explicitly state that `restore-live` is destructive and requires the confirmation flag.

- [ ] **Step 5: Add a concise production-backup section to the root README**

Add a link from the deployment/operations section to `scripts/backup/README.md`, state that Docker volumes are not backups, and identify PostgreSQL, STL uploads, and Telegram session volumes as the protected data set.

- [ ] **Step 6: Commit documentation**

```bash
git add scripts/backup/README.md README.md
git commit -m "docs: document Synology backup and recovery"
```

### Task 6: Verify backup, failure recovery, retention, and restore

**Files:**
- Modify: `scripts/backup/README.md` only if verification commands need correction.

**Interfaces:**
- Consumes: the complete backup stack from Tasks 1–5.
- Produces: evidence that the acceptance criteria are met, including a disposable restore rehearsal and a failure-path result.

- [ ] **Step 1: Validate configuration and scripts**

Run:

```bash
docker compose --profile backup config --quiet
bash -n scripts/backup/container-entrypoint.sh scripts/backup/run-backup.sh scripts/backup/restore.sh
systemd-analyze verify deploy/systemd/dragons-stash-backup.service deploy/systemd/dragons-stash-backup.timer
```

Expected: all commands exit `0`.

- [ ] **Step 2: Seed a recognizable test record and STL file**

Using the existing app/database workflow, create one test upload whose database metadata and file can be identified after restore. Record the expected filename, upload ID, and file checksum before backup.

- [ ] **Step 3: Run a real backup and inspect the snapshot**

Run the systemd service manually, then inspect:

```bash
sudo systemctl start dragons-stash-backup.service
sudo journalctl -u dragons-stash-backup.service --since "10 minutes ago" --no-pager
docker compose --profile backup run --rm backup snapshots
docker compose --profile backup run --rm backup check
```

Expected: the service succeeds, the snapshot exists, the repository check succeeds, all services are running again, and the test file checksum is represented in the backed-up volume.

- [ ] **Step 4: Test the failure path with the NAS unavailable**

Temporarily unmount the Synology share in a controlled maintenance session, run the systemd service, and confirm it fails before creating a new snapshot. Remount the share and confirm the previously successful snapshot remains listed. Verify that services are running after the failed attempt.

- [ ] **Step 5: Rehearse a disposable restore**

Restore the selected snapshot to a disposable Compose project or isolated Docker volumes. Import the database dump, restore the three file trees, start the disposable app/worker/bot services, call `/api/health`, and run the file-reference verification. Confirm the test upload metadata and STL checksum match the pre-backup record.

- [ ] **Step 6: Verify retention behavior**

Use a disposable repository or controlled test timestamps to create more than 30 daily snapshots, run the retention command after a successful backup, and confirm that the latest 30 daily snapshots remain. Confirm a failed backup does not invoke pruning.

- [ ] **Step 7: Record verification evidence**

Add the actual commands, dates, snapshot ID, restore result, and any environment-specific caveats to the operational notes. Do not commit passwords, session contents, database dumps, or NAS addresses that are intended to remain private.

- [ ] **Step 8: Commit any documentation corrections**

```bash
git add scripts/backup/README.md
git commit -m "test: document verified backup and restore procedure"
```

## Plan Self-Review

- **Spec coverage:** PostgreSQL dump, STL volume, both Telegram volumes, Synology NFS, Restic encryption/deduplication, 30-day retention, maintenance window, service restart on failure, guarded restore, file-reference validation, monthly repository/restore checks, and NAS-loss caveat are covered by Tasks 1–6.
- **Placeholder scan:** No `TBD`, `TODO`, or unspecified implementation task remains. Environment-dependent values are explicit configuration variables or operator-supplied paths.
- **Type/interface consistency:** The Compose service name is consistently `backup`; the container command modes are `backup` and `restore`; the host wrapper owns service lifecycle; the restore script owns destructive confirmation; Restic owns snapshots and pruning.
- **Scope check:** The plan contains one operational subsystem with separate backup, restore, scheduling, and documentation units that can each be reviewed and tested independently.
