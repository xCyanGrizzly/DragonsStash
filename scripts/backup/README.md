# Production backup and recovery

Dragon's Stash backs up its PostgreSQL database and the worker/bot Telegram
(TDLib) session volumes to an encrypted Restic repository on a Synology NFS
share. Docker volumes are local runtime storage; they are not, by themselves,
backups.

The backup job runs as `root` because it reads the Restic password file and
mounts host paths into the backup container. Keep the Synology share on the
private network. Do **not** expose NFS to the Internet.

## Protected data and limits

Each snapshot contains:

- a custom-format PostgreSQL dump;
- a backup manifest with dump checksum, migration metadata, version metadata,
  and captured source paths;
- the worker TDLib session volume; and
- the bot TDLib session volume.

The `manual_uploads` and `tmp_zips` volumes are excluded. Completed STL
binaries are not retained as a local recovery set by this backup feature; they
remain in Telegram. Recovery preserves the PostgreSQL archive, message,
package, file, Telegram channel, and Telegram message ID mappings needed for
normal lookup and delivery after restore.

Future Telegram channel-forwarding behavior and archive/STL-content integrity
auditing are intentionally outside this backup and restore procedure.

## 1. Configure the Synology NFS share

On the Synology DSM host:

1. In **Control Panel > Shared Folder**, create a shared folder named
   `dragonsstash-backups`.
2. In **Control Panel > File Services > NFS**, enable NFS.
3. Edit the new shared folder and add an **NFS Permissions** entry for the
   Docker host's fixed private-network IP address. Grant read/write access.
   Use the least permissive squash and authentication settings that work for
   the root-run backup job, and do not use a broad subnet or public address.
4. Record the NFS export path shown by DSM, for example
   `/volume1/dragonsstash-backups`.

On the Docker host, install the NFS client package for its distribution, create
the mountpoint, and mount the export. Replace `NAS_IP` and the export path with
the values for the Synology:

```bash
sudo mkdir -p /mnt/dragonsstash-backups
sudo mount -t nfs -o nfsvers=4 NAS_IP:/volume1/dragonsstash-backups /mnt/dragonsstash-backups
```

For a persistent mount, add an `/etc/fstab` entry using the DSM export path:

```fstab
NAS_IP:/volume1/dragonsstash-backups /mnt/dragonsstash-backups nfs nfsvers=4,_netdev,nofail,x-systemd.automount 0 0
```

Then verify that the host sees an actual writable mount rather than an empty
local directory:

```bash
mountpoint /mnt/dragonsstash-backups
touch /mnt/dragonsstash-backups/.write-test
rm /mnt/dragonsstash-backups/.write-test
```

The scheduled backup refuses to run if `BACKUP_MOUNT_PATH` is not a mountpoint
or is not writable.

## 2. Create secrets and host configuration

Create a root-readable Restic password file. Generate and store a strong,
unique repository password by your approved secret-management process; never
commit it, place it in the Compose file, or paste it into shell history.

```bash
sudo install -d -m 0700 -o root -g root /etc/dragons-stash
sudo install -m 0600 -o root -g root /dev/null /etc/dragons-stash/restic-password
sudoedit /etc/dragons-stash/restic-password
```

Create a local staging directory. It must be on host-local storage, not the NFS
share, and must have enough room for a PostgreSQL dump and restore staging
data.

```bash
sudo install -d -m 0700 -o root -g root /var/lib/dragons-stash/backup-staging
```

Create the systemd environment file at `/etc/dragons-stash/backup.env` and keep
it root-only. It supplies both the host wrapper and the profile-gated backup
container:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/dragons-stash/backup.env
sudoedit /etc/dragons-stash/backup.env
```

Set these production values, replacing paths and retention as needed:

```dotenv
BACKUP_MOUNT_PATH=/mnt/dragonsstash-backups
BACKUP_STAGING_PATH=/var/lib/dragons-stash/backup-staging
BACKUP_RESTIC_PASSWORD_FILE=/etc/dragons-stash/restic-password
BACKUP_REPOSITORY=/backup/restic
BACKUP_RETENTION_DAYS=30
BACKUP_APP_VERSION=unknown
```

`BACKUP_REPOSITORY` is evaluated inside the backup container, where the NFS
share is mounted at `/backup`; `/backup/restic` keeps the Restic repository in
the Synology share. `BACKUP_APP_VERSION` is optional metadata. The production
Compose environment must also retain its existing database and application
secrets; do not add secrets to Git.

## 3. Initialize the Restic repository once

Before enabling the scheduled job, initialize a new repository explicitly:

```bash
docker compose --profile backup run --rm backup init
```

The backup container preflight refuses to create a repository implicitly. If a
scheduled backup reports that the repository is unavailable or uninitialized,
verify the NFS mount, `BACKUP_REPOSITORY`, and password file before running the
explicit initialization command for an intended new repository.

## 4. Install the nightly systemd job

The supplied unit assumes the production Compose checkout is
`/opt/stacks/DragonsStash`. If your deployment lives elsewhere, update the
installed service's `WorkingDirectory` and `ExecStart` to the corresponding
absolute paths before enabling it.

Install and start the units:

```bash
sudo install -m 0644 deploy/systemd/dragons-stash-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/dragons-stash-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dragons-stash-backup.timer
sudo systemctl start dragons-stash-backup.service
sudo journalctl -u dragons-stash-backup.service -n 100 --no-pager
```

The timer runs nightly at 03:00 with up to 15 minutes of randomized delay and
catches up after downtime. The first run captures PostgreSQL and both TDLib
session volumes. Later Restic snapshots deduplicate unchanged session state and
database dump content.

## 5. Monitor and maintain backups

Inspect the next scheduled run and the last service result:

```bash
systemctl list-timers dragons-stash-backup.timer
systemctl status dragons-stash-backup.timer
systemctl status dragons-stash-backup.service
sudo journalctl -u dragons-stash-backup.service -n 100 --no-pager
sudo systemctl --failed
```

List snapshots through the configured backup container:

```bash
./scripts/backup/restore.sh list
```

Check a selected repository snapshot before restoring it:

```bash
./scripts/backup/restore.sh verify SNAPSHOT_ID
```

`verify` runs `restic snapshots SNAPSHOT_ID` and `restic check`. Routine backup
runs apply retention with `restic forget --keep-daily "$BACKUP_RETENTION_DAYS"
--prune`; with the example configuration, this retains 30 daily snapshots.
Choose `BACKUP_RETENTION_DAYS` based on storage capacity and the recovery
window you need. Watch Synology capacity and investigate any failed timer or
service promptly.

At least monthly, perform a full repository read check:

```bash
docker compose --profile backup run --rm backup check --read-data
```

## 6. Monthly disposable recovery rehearsal

Perform the following procedure at least monthly. It restores one snapshot into
a unique, disposable Compose project, so the database and Compose volumes are
isolated from production. **Never use the production Compose project name,
production volume names, or `restore-live` for this rehearsal.** Do not run
`docker compose down -v` without the explicit rehearsal `--project-name` shown
below.

Run these commands from the production Compose checkout as an operator allowed
to read `/etc/dragons-stash/backup.env`. They use a separate application stack;
do not expose its published port beyond the host. The worker and bot are
deliberately replaced with inert processes, so this validates restored images,
database state, and TDLib volume layout without executing Telegram clients or
using production Telegram credentials.

```bash
set -Eeuo pipefail
set -a
. /etc/dragons-stash/backup.env
set +a

./scripts/backup/restore.sh list
SNAPSHOT_ID=SNAPSHOT_ID_FROM_LIST
REHEARSAL_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
REHEARSAL_PROJECT="dragonsstash-rehearsal-$REHEARSAL_ID"
REHEARSAL_DIR="$BACKUP_STAGING_PATH/monthly-rehearsal-$REHEARSAL_ID"
REHEARSAL_ENV="$REHEARSAL_DIR/compose.env"
REHEARSAL_OVERRIDE="$REHEARSAL_DIR/compose.rehearsal.override.yml"
REHEARSAL_APP_PORT=13000  # Choose an unused host-local port.

./scripts/backup/restore.sh verify "$SNAPSHOT_ID"
./scripts/backup/restore.sh restore-to-staging "$SNAPSHOT_ID" "$REHEARSAL_DIR"
RESTORE_ROOT="$(printf '%s\n' "$REHEARSAL_DIR"/staging/backup-*)"
sha256sum --check "$RESTORE_ROOT/manifest/database.dump.sha256"

test -s "$RESTORE_ROOT/database.dump"
test -s "$RESTORE_ROOT/manifest/backup-manifest.json"
test -d "$REHEARSAL_DIR/data/tdlib-worker"
test -d "$REHEARSAL_DIR/data/tdlib-bot"

umask 077
cp .env "$REHEARSAL_ENV"
printf '\nAPP_PORT=%s\nNEXT_PUBLIC_APP_URL=http://localhost:%s\n' \
  "$REHEARSAL_APP_PORT" "$REHEARSAL_APP_PORT" >> "$REHEARSAL_ENV"

cat > "$REHEARSAL_OVERRIDE" <<'EOF'
services:
  worker:
    environment:
      TELEGRAM_API_ID: ""
      TELEGRAM_API_HASH: ""
    entrypoint: ["/bin/sh", "-c"]
    command: ["exec sleep infinity"]
  bot:
    environment:
      BOT_TOKEN: ""
      TELEGRAM_API_ID: ""
      TELEGRAM_API_HASH: ""
    entrypoint: ["/bin/sh", "-c"]
    command: ["exec sleep infinity"]
EOF
```

Confirm that `RESTORE_ROOT` names exactly one `backup-*` directory before
continuing. The staging restore has already verified the custom PostgreSQL dump
and restored `data/tdlib-worker` and `data/tdlib-bot`.

Create the isolated project and volumes, start only its database, then import
the dump. `compose_rehearsal()` always applies the disposable override created
above: worker and bot retain their restored images and volumes but have their
Telegram credential variables blanked and run only `sleep infinity`, never
Telegram clients. The `create` command makes project-scoped application
volumes without starting app, worker, or bot.

```bash
compose_rehearsal() {
  docker compose --project-name "$REHEARSAL_PROJECT" --env-file "$REHEARSAL_ENV" \
    -f docker-compose.yml -f "$REHEARSAL_OVERRIDE" "$@"
}
rehearsal_volume() {
  docker volume ls \
    --filter "label=com.docker.compose.project=$REHEARSAL_PROJECT" \
    --filter "label=com.docker.compose.volume=$1" \
    --format '{{.Name}}'
}

compose_rehearsal --profile full create app worker bot
compose_rehearsal --profile full up -d db
compose_rehearsal exec -T db dropdb --if-exists --force \
  --username "${POSTGRES_USER:-dragons}" "${POSTGRES_DB:-dragonsstash}"
compose_rehearsal exec -T db createdb --username "${POSTGRES_USER:-dragons}" \
  "${POSTGRES_DB:-dragonsstash}"
compose_rehearsal exec -T db pg_restore --no-owner --exit-on-error \
  --username "${POSTGRES_USER:-dragons}" --dbname "${POSTGRES_DB:-dragonsstash}" \
  < "$RESTORE_ROOT/database.dump"
```

Copy each restored TDLib tree into its matching **rehearsal** volume. Each
target is new and empty; the function rejects an ambiguous volume lookup.

```bash
restore_rehearsal_volume() {
  local logical_name="$1"
  local source_dir="$2"
  local volume_name
  volume_name="$(rehearsal_volume "$logical_name")"
  test -n "$volume_name"
  test "$(printf '%s\n' "$volume_name" | wc -l)" -eq 1
  compose_rehearsal --profile backup run --rm --no-deps \
    --entrypoint bash \
    -v "$source_dir:/restore-source:ro" \
    -v "$volume_name:/restore-target" \
    backup -ceu 'cp -a /restore-source/. /restore-target/'
}

restore_rehearsal_volume tdlib_state "$REHEARSAL_DIR/data/tdlib-worker"
restore_rehearsal_volume tdlib_bot_state "$REHEARSAL_DIR/data/tdlib-bot"
```

Start the disposable app, worker, and bot containers. The app and database
perform their normal health checks; the worker and bot remain inert `sleep
infinity` processes, so this does not execute Telegram clients or send
messages. Check the health endpoint, then retain the `ps` and log output as
rehearsal evidence.

```bash
compose_rehearsal --profile full up -d app worker bot
curl --fail --silent --show-error \
  "http://localhost:$REHEARSAL_APP_PORT/api/health"
compose_rehearsal --profile full ps
compose_rehearsal --profile full logs --tail=100 app worker bot
```

Optionally spot-check the restored database metadata that lets Dragon's Stash
locate Telegram-hosted STL binaries after restore. This checks database
metadata and Telegram IDs only; it does not assert local STL file presence,
STL checksums, Telegram forwarding behavior, or archive/STL binary integrity.

```bash
compose_rehearsal exec -T db psql --no-psqlrc --tuples-only --no-align --quiet \
  --username "${POSTGRES_USER:-dragons}" \
  --dbname "${POSTGRES_DB:-dragonsstash}" \
  --command 'SELECT count(*) FROM "packages" WHERE "destChannelId" IS NOT NULL AND "destMessageId" IS NOT NULL;'
```

After recording the evidence, destroy only the explicitly named disposable
project and its project-labeled volumes. Do not remove `REHEARSAL_DIR` until
the evidence is recorded; then remove only that generated child directory by
your approved host cleanup procedure. Production services, volumes, and backup
snapshots must remain untouched.

```bash
compose_rehearsal --profile full down --volumes --remove-orphans
docker volume ls --filter "label=com.docker.compose.project=$REHEARSAL_PROJECT"
test -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$REHEARSAL_PROJECT")"
```

Record this evidence for every rehearsal; do not include secrets, database
dumps, Telegram session contents, or private NAS details.

```text
Disposable restore rehearsal
Date/time (UTC):
Operator:
Snapshot ID:
Snapshot backup date:
Disposable Compose project:
Full restic check --read-data result:
Database dump manifest checksum result:
TDLib worker tree restored:
TDLib bot tree restored:
Health endpoint result (HTTP/body):
docker compose ps result:
app/worker/bot log review result:
Database Telegram metadata/mapping spot-check result:
Cleanup result (project and rehearsal volumes absent):
Notes/caveats:
```

This document describes the procedure only; it has not been run by this
documentation update.

## 7. Restore modes

Run restore commands from the production Compose checkout after loading the
same backup environment used by systemd, for example as root with
`/etc/dragons-stash/backup.env` exported. All restore staging directories must
be children of `BACKUP_STAGING_PATH`.

| Mode | Command | Effect |
| --- | --- | --- |
| List snapshots | `./scripts/backup/restore.sh list` | Lists available Restic snapshots. Does not stop services or change volumes. |
| Verify a snapshot | `./scripts/backup/restore.sh verify SNAPSHOT_ID` | Confirms the snapshot exists and runs a Restic repository check. Does not change live data. |
| Restore to staging | `./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID STAGING_DIR` | Restores and validates a snapshot in a new or empty child directory of `BACKUP_STAGING_PATH`. Does not stop services or change volumes. |
| Replace live data | `./scripts/backup/restore.sh restore-live SNAPSHOT_ID --confirm-replace-live-data` | Stops application services and replaces the PostgreSQL database plus both TDLib session volumes after validation. |

`restore-live` is destructive. It requires the exact
`--confirm-replace-live-data` flag and should be used only after a successful
staging restore has been inspected. It creates a safety database dump and
archives of the current TDLib volumes in local staging before replacement. If a
live restore fails, it leaves the application services stopped, retains the
safety artifacts and staging directory, and attempts rollback after replacement
has begun. Review the reported paths and service health before manually
starting services.

After a successful live restore, confirm the services are running and inspect
their recent logs before declaring recovery complete:

```bash
docker compose ps
docker compose logs --tail=100 app worker bot
```

For a non-destructive recovery rehearsal, choose a snapshot from `list` and
restore it to a fresh staging directory, for example:

```bash
./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID /var/lib/dragons-stash/backup-staging/rehearsal-SNAPSHOT_ID
```

The restored tree must contain a non-empty PostgreSQL dump, its manifest,
worker TDLib state, and bot TDLib state. STL binaries remain in Telegram, and
the restored database mappings and Telegram IDs are what recovery preserves for
normal lookup and delivery.
