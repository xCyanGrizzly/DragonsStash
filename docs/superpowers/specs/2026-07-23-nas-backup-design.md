# NAS Backup for Postgres + TDLib State — Design

**Date:** 2026-07-23
**Status:** Approved for planning

## Summary

Add a dedicated `backup` container to the DragonsStash stack that takes daily,
encrypted, deduplicated backups of the two things that can't be regenerated —
the Postgres database (inventory/STL metadata, users, everything the app
manages) and the two TDLib state volumes (Telegram session/auth state for the
worker and bot) — and ships them to a Synology NAS over NFS. STL archive
contents themselves are explicitly out of scope: they only live on this host
temporarily and are not backed up.

Backups are stored via [restic](https://restic.net/), which provides
encryption-at-rest, block-level dedup, and retention pruning natively, so no
custom encryption or pruning scripts need to be written or maintained.

## Context

Current state (as of this design):

- Production stack runs from `/opt/stacks/DragonsStash/docker-compose.yml` on
  this Dockge-managed host, pulling prebuilt images from
  `git.samagsteribbe.nl`. The `docker-compose.yml` in this repo is the
  build/dev reference and should be kept in sync.
- Named volumes in use: `postgres_data` (Postgres 16 data directory),
  `tdlib_state` (worker's TDLib session), `tdlib_bot_state` (bot's TDLib
  session), `tmp_zips` and `manual_uploads` (both transient, explicitly out of
  scope here).
- No backup mechanism, NFS mount, or host cron currently exists anywhere in
  this deployment.
- The host already runs Uptime Kuma (used here for backup alerting) and Loki
  (container logs are presumably already collected there).

## Requirements

1. Daily backup of the Postgres database and both TDLib state volumes.
2. Backups stored on a Synology NAS via NFS, not on local disk.
3. 14-day retention, oldest snapshots pruned automatically.
4. Backups encrypted at rest (Postgres dumps and TDLib session files both
   contain sensitive material — password hashes, Telegram API secrets, live
   session state).
5. Postgres backups must be transactionally consistent regardless of live app
   traffic. TDLib state backups are best-effort (see Decisions below) — this
   is an accepted trade-off, not a defect.
6. Alert (via existing Uptime Kuma) if a backup run fails or doesn't happen.
7. No new host-level state (no `/etc/fstab` entries, no host crontab) — the
   backup mechanism should be a container, consistent with how everything
   else on this host is deployed and versioned.
8. No new privileged access — specifically, the backup container must not
   have Docker socket access or any ability to control sibling containers.

## Decisions

- **NFS mounted via Docker's native NFS volume driver** (`driver_opts: type:
  nfs`), not a host-level mount. Keeps all backup-related state inside the
  compose file instead of split across host config.
- **Restic, not hand-rolled tar+age+find.** Restic already solves encryption,
  dedup, and retention correctly; hand-rolled scripts would be reinventing
  that logic with more room for bugs.
- **TDLib state is tarred live (best-effort), not paused.** Pausing the
  worker/bot for a clean snapshot would require mounting the Docker socket
  into the backup container so it could stop/start sibling containers — a
  real privilege escalation (a compromised backup container could then
  control any container on the host). The downside of a best-effort tar is
  bounded: worst case, a bad TDLib restore means redoing the Telegram SMS
  auth flow, which is the same outcome as having no backup at all. That
  bounded, low-severity downside doesn't justify the privilege escalation.
- **Fixed-time cron (`crond`), not a sleep-loop.** A `sleep 86400` loop drifts
  on every container restart; a real crontab entry fires at a fixed time of
  day regardless of restarts, for negligible extra complexity.
- **Restore is manual, not automated.** A script capable of restoring can
  overwrite live state; that should always require a human deliberately
  running it, not run unattended.

## Design

### New service: `backup`

Added to both `/opt/stacks/DragonsStash/docker-compose.yml` (production) and
this repo's `docker-compose.yml` (dev/build reference).

- **Image**: custom, `FROM alpine:3.20`, `apk add --no-cache restic
  postgresql16-client curl tzdata dcron tar bash`. No dependency on app
  source — independent Dockerfile, e.g. `backup/Dockerfile`.
- **Scheduling**: `crond -f` in the foreground as the container's entrypoint,
  with a crontab installed at build time:
  ```
  0 3 * * * /backup.sh >> /proc/1/fd/1 2>&1
  0 4 * * 0 restic check >> /proc/1/fd/1 2>&1
  ```
  (daily dump/backup at 03:00, weekly repo integrity check at 04:00 Sunday).
  `restic init` runs once at container startup (entrypoint, before `crond`
  starts), swallowing the "already initialized" error on subsequent
  container (re)starts.
- **Network**: `internal` only — reaches `dragonsstash-db:5432` for
  `pg_dump`. No ports exposed.
- **Volumes**:
  - `tdlib_state:/data/tdlib-worker:ro`
  - `tdlib_bot_state:/data/tdlib-bot:ro`
  - `nas_backups:/backups`, a named volume defined with:
    ```yaml
    nas_backups:
      driver_opts:
        type: nfs
        o: "addr=${NAS_HOST},rw,nfsvers=4,soft,timeo=100"
        device: ":${NAS_EXPORT_PATH}"
    ```
- **New `.env` entries**: `NAS_HOST`, `NAS_EXPORT_PATH` (NFS share details),
  `RESTIC_PASSWORD` (repo encryption key), `KUMA_PUSH_URL` (Uptime Kuma push
  monitor URL). All four are inputs to gather during implementation, not
  hardcoded.
- `restart: unless-stopped`, no `privileged`, no Docker socket mount.

### `backup.sh`

```
set -euo pipefail
trap 'curl -fsS "$KUMA_PUSH_URL" --get --data-urlencode "status=down" \
  --data-urlencode "msg=$BASH_COMMAND failed"' ERR

pg_dump -h dragonsstash-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -f /tmp/dragonsstash.dump

tar czf /tmp/tdlib.tar.gz -C /data tdlib-worker tdlib-bot

restic backup /tmp/dragonsstash.dump /tmp/tdlib.tar.gz
restic forget --keep-daily 14 --prune

rm -f /tmp/dragonsstash.dump /tmp/tdlib.tar.gz

curl -fsS "$KUMA_PUSH_URL" --get --data-urlencode "status=up" \
  --data-urlencode "msg=OK"
```

`PGPASSWORD` and `RESTIC_REPOSITORY=/backups/restic-repo` are set as
container environment variables (from `.env`), not inline in the script.

### Data flow

```
crond (daily 03:00)
  → pg_dump (consistent snapshot via Postgres MVCC) → /tmp/dragonsstash.dump
  → tar tdlib_state + tdlib_bot_state (best-effort, live) → /tmp/tdlib.tar.gz
  → restic backup (encrypt + dedup) → NFS-mounted repo on Synology NAS
  → restic forget --keep-daily 14 --prune
  → curl Uptime Kuma push monitor (up on success, down + reason on any failure)
```

### Restore (manual, documented procedure — not scripted/automated)

```
restic -r /backups/restic-repo restore latest --target /tmp/restore
pg_restore -h dragonsstash-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists /tmp/restore/tmp/dragonsstash.dump
# untar /tmp/restore/tmp/tdlib.tar.gz back into the tdlib_state /
# tdlib_bot_state volumes (via a throwaway container mounting both)
```

## Alerting

- One Uptime Kuma **Push** monitor, created manually in the existing Kuma
  instance, with an expected heartbeat interval of ~26 hours (slack past the
  24h schedule so one slow run doesn't false-positive). Whatever notification
  channels are already configured on that monitor fire automatically — no new
  alerting integration.
- `backup.sh` pushes `status=up` on success and `status=down` (with the
  failing command in `msg`) on any failure, via the `ERR` trap.
- Container logs go to stdout, collected the same way every other container's
  logs already are on this host.

## Testing

This repo has no automated test framework (documented convention: manual
testing). For this infra change:

- After deploy: manually run `docker exec dragonsstash-backup /backup.sh`
  once, confirm a snapshot appears (`restic snapshots`), confirm the Kuma
  monitor goes green.
- **Restore drill** (once, during setup): actually restore the dump into a
  scratch Postgres and untar the TDLib archive into scratch volumes, to prove
  the backup is really restorable. Not automated or recurring for now.

## Out of scope / non-goals

- Backing up `tmp_zips` or `manual_uploads` — both transient by design.
- Automated/scheduled restore testing.
- Backing up any other stack on this host (this design is DragonsStash-only,
  though the pattern — Docker-native NFS volume + restic — could be reused
  for other stacks later).
- Pausing worker/bot for a guaranteed-consistent TDLib snapshot (see
  Decisions).

## Files touched

- `docker-compose.yml` (this repo) and
  `/opt/stacks/DragonsStash/docker-compose.yml` (production) — add `backup`
  service, `nas_backups` volume.
- `backup/Dockerfile` — new.
- `backup/backup.sh` — new.
- `backup/crontab` — new.
- `.env.example` / `.env` — add `NAS_HOST`, `NAS_EXPORT_PATH`,
  `RESTIC_PASSWORD`, `KUMA_PUSH_URL`.
