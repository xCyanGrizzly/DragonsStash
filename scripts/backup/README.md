# Production backup and recovery

Dragon's Stash backs up its PostgreSQL database, durable STL uploads, and the
worker and bot Telegram (TDLib) session volumes to an encrypted Restic
repository on a Synology NFS share. Docker volumes are local runtime storage;
they are not, by themselves, backups.

The backup job runs as `root` because it reads the Restic password file and
mounts host paths into the backup container. Keep the Synology share on the
private network. Do **not** expose NFS to the Internet.

## Protected data and limits

Each snapshot contains:

- a custom-format PostgreSQL dump;
- the `manual_uploads` volume at `/data/uploads` (including newly completed
  manual STL uploads);
- the worker TDLib session volume; and
- the bot TDLib session volume.

New manual-upload STL files are retained in `manual_uploads` and can therefore
be included in future backups. STL files that an older worker run already
deleted cannot be recovered by this backup feature. Their legacy database rows
are reported as warnings during restore validation; only files marked as
retained must be present in a restored snapshot.

## 1. Configure the Synology NFS share

On the Synology DSM host:

1. In **Control Panel > Shared Folder**, create a shared folder named
   `dragonsstash-backups`.
2. In **Control Panel > File Services > NFS**, enable NFS.
3. Edit the new shared folder and add an **NFS Permissions** entry for the
   Docker host's fixed private-network IP address. Grant read/write access.
   Use the least permissive squash and authentication settings that work for
   the root-run backup job, and do not use a broad subnet or public address.
4. Record the NFS export path shown by DSM (for example,
   `/volume1/dragonsstash-backups`).

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

Set these production values (replace the example paths and retention period as
needed):

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
secrets; do not add any secrets to Git.

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
catches up after downtime. The first run can take a long time because it uploads
all existing STL and session data. Later Restic snapshots deduplicate unchanged
data.

## 5. Monitor and maintain backups

Inspect the next scheduled run and the last service result:

```bash
systemctl list-timers dragons-stash-backup.timer
systemctl status dragons-stash-backup.timer
systemctl status dragons-stash-backup.service
sudo journalctl -u dragons-stash-backup.service -n 100 --no-pager
sudo systemctl --failed
```

List the snapshots through the configured backup container:

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

Also rehearse recovery using a disposable staging directory and verify the
database dump checksum before deleting the rehearsal directory:

```bash
REHEARSAL_DIR=/var/lib/dragons-stash/backup-staging/monthly-rehearsal-SNAPSHOT_ID
./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID "$REHEARSAL_DIR"
(
  cd "$REHEARSAL_DIR"/staging/backup-*
  sha256sum --check manifest/database.dump.sha256
)
```

The staging restore also verifies the custom PostgreSQL dump and required data
directories. Inspect the restored data as appropriate, then remove the
disposable directory using your approved host cleanup procedure.

## 6. Restore modes

Run restore commands from the production Compose checkout after loading the
same backup environment used by systemd (for example, as root with
`/etc/dragons-stash/backup.env` exported). All restore staging directories must
be children of `BACKUP_STAGING_PATH`.

| Mode | Command | Effect |
| --- | --- | --- |
| List snapshots | `./scripts/backup/restore.sh list` | Lists available Restic snapshots. Does not stop services or change volumes. |
| Verify a snapshot | `./scripts/backup/restore.sh verify SNAPSHOT_ID` | Confirms the snapshot exists and runs a Restic repository check. Does not change live data. |
| Restore to staging | `./scripts/backup/restore.sh restore-to-staging SNAPSHOT_ID STAGING_DIR` | Restores and validates a snapshot in a new or empty child directory of `BACKUP_STAGING_PATH`. Does not stop services or change volumes. |
| Replace live data | `./scripts/backup/restore.sh restore-live SNAPSHOT_ID --confirm-replace-live-data` | Stops application services and replaces the PostgreSQL database plus all protected volumes after validation. |

`restore-live` is destructive. It requires the exact
`--confirm-replace-live-data` flag and should be used only after a successful
staging restore has been inspected. It creates a safety database dump and
archives of the current protected volumes in local staging before replacement.
If a live restore fails, it leaves the application services stopped, retains the
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
uploads, worker TDLib state, and bot TDLib state. Live restore additionally
checks every retained manual-upload file reference against the staged uploads
before replacing any live volume.
