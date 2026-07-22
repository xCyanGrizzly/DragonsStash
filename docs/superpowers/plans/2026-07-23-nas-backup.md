# NAS Backup for Postgres + TDLib State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `backup` container to the DragonsStash stack that takes daily, encrypted, deduplicated backups of the Postgres database and both TDLib state volumes, and ships them to a Synology NAS over NFS.

**Architecture:** A small Alpine-based image (restic + postgresql16-client + curl + dcron) runs as its own compose service. A crontab fires `backup.sh` daily at 03:00, which dumps Postgres, tars the TDLib volumes, hands both to `restic backup` against an NFS-backed Docker volume, prunes with `restic forget --keep-daily 14`, and reports success/failure to an Uptime Kuma push monitor. Matches the existing `worker`/`bot` pattern: build context in the repo's `docker-compose.yml`, prebuilt image in `/opt/stacks/DragonsStash/docker-compose.yml`, built and pushed by `.drone.yml`.

**Tech Stack:** Alpine 3.20, restic 0.16, postgresql16-client, dcron, bash, Docker Compose NFS volume driver.

## Global Constraints

- Retention: `restic forget --keep-daily 14 --prune` (14-day window, per approved spec).
- Schedule: daily backup at 03:00, weekly `restic check` at 04:00 Sunday.
- No Docker socket mount, no `privileged: true` — the backup container must not be able to control sibling containers.
- No host-level mount — NFS access only via Docker's native `driver_opts: type: nfs` volume, never `/etc/fstab`.
- Encryption and retention are restic's job — no hand-rolled `age`/`gpg`/`find -mtime` logic.
- TDLib volumes are tarred live (best-effort) — never pause `worker`/`bot` for the backup.
- Restore is a manual, documented procedure only — never scripted/automated.

**Required user input before Task 5 can run:** `NAS_HOST` and `NAS_EXPORT_PATH` (the Synology NFS share details) and a Kuma Push-monitor URL (`KUMA_PUSH_URL`, created manually in the existing Uptime Kuma instance, ~26h expected heartbeat interval). Tasks 1–4 need none of these and can proceed immediately; do not substitute placeholder values for them in Task 5 — stop and ask the user instead.

---

### Task 1: Backup image (Dockerfile + entrypoint)

**Files:**
- Create: `backup/Dockerfile`
- Create: `backup/entrypoint.sh`
- Create: `backup/crontab`

**Interfaces:**
- Produces: a buildable image tagged `dragonsstash-backup:test` locally, with `/entrypoint.sh` as `ENTRYPOINT`, `/backup.sh` present at the image root (written in Task 2 — this task only needs the `COPY` line and a placeholder-free stub isn't acceptable, so create an empty‑body-but-real `backup/backup.sh` here containing just `#!/bin/bash` + `exit 0`, and Task 2 replaces its contents), `restic`, `pg_dump`/`pg_restore`, `curl`, `tar`, `bash`, `dcron` all on `PATH`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write `backup/backup.sh` stub**

```bash
#!/bin/bash
set -euo pipefail
exit 0
```

- [ ] **Step 2: Write `backup/entrypoint.sh`**

```bash
#!/bin/bash
set -euo pipefail

if ! restic snapshots >/dev/null 2>&1; then
  restic init
fi

exec crond -f -l 2
```

- [ ] **Step 3: Write `backup/crontab`**

```
0 3 * * * /backup.sh >> /proc/1/fd/1 2>&1
0 4 * * 0 restic check >> /proc/1/fd/1 2>&1
```

- [ ] **Step 4: Write `backup/Dockerfile`**

```dockerfile
FROM alpine:3.20

RUN apk add --no-cache restic postgresql16-client curl tzdata dcron tar bash

COPY backup/backup.sh /backup.sh
COPY backup/entrypoint.sh /entrypoint.sh
COPY backup/crontab /etc/crontabs/root

RUN chmod +x /backup.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 5: Build the image**

Run: `cd /home/sam/Documents/DragonsStash && docker build -t dragonsstash-backup:test -f backup/Dockerfile .`
Expected: build completes with `Successfully tagged dragonsstash-backup:test` (or Buildkit's equivalent final `naming to docker.io/library/dragonsstash-backup:test done`), no errors.

- [ ] **Step 6: Verify the tools are present**

Run: `docker run --rm dragonsstash-backup:test restic version && docker run --rm dragonsstash-backup:test pg_dump --version`
Expected: `restic 0.16.x ...` and `pg_dump (PostgreSQL) 16.x` printed, both commands exit 0.

- [ ] **Step 7: Verify the entrypoint initializes an empty repo and starts cron**

```bash
mkdir -p /tmp/backup-repo-smoke
docker run -d --name backup-smoke \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=smoketest \
  -v /tmp/backup-repo-smoke:/backups \
  dragonsstash-backup:test
sleep 2
docker logs backup-smoke
docker exec backup-smoke restic snapshots
docker rm -f backup-smoke
rm -rf /tmp/backup-repo-smoke
```

Expected: `docker logs` shows no errors (restic init ran silently); `restic snapshots` prints an empty snapshot list (repo exists, header row only, no error).

- [ ] **Step 8: Commit**

```bash
git add backup/Dockerfile backup/entrypoint.sh backup/backup.sh backup/crontab
git commit -m "Add backup service image (Dockerfile, entrypoint, crontab)"
```

---

### Task 2: `backup.sh` script

**Files:**
- Modify: `backup/backup.sh` (replace Task 1's stub with the real script)

**Interfaces:**
- Consumes: the image built in Task 1 (`dragonsstash-backup:test`), rebuilt after this change.
- Produces: `/backup.sh`, invoked by cron in Task 1's `crontab` and manually in Task 6's verification. Reads env vars `POSTGRES_USER`, `PGPASSWORD`, `POSTGRES_DB`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `KUMA_PUSH_URL`. Assumes network hostname `dragonsstash-db:5432` for Postgres and mounts `/data/tdlib-worker`, `/data/tdlib-bot` (read-only) for TDLib state.

- [ ] **Step 1: Replace `backup/backup.sh` with the real script**

```bash
#!/bin/bash
set -euo pipefail

report_failure() {
  curl -fsS "$KUMA_PUSH_URL" --get \
    --data-urlencode "status=down" \
    --data-urlencode "msg=$BASH_COMMAND failed" || true
}
trap report_failure ERR

DUMP_FILE=/tmp/dragonsstash.dump
TAR_FILE=/tmp/tdlib.tar.gz

pg_dump -h dragonsstash-db -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$DUMP_FILE"

tar czf "$TAR_FILE" -C /data tdlib-worker tdlib-bot

restic backup "$DUMP_FILE" "$TAR_FILE"
restic forget --keep-daily 14 --prune

rm -f "$DUMP_FILE" "$TAR_FILE"

curl -fsS "$KUMA_PUSH_URL" --get \
  --data-urlencode "status=up" \
  --data-urlencode "msg=OK"
```

- [ ] **Step 2: Rebuild the image**

Run: `docker build -t dragonsstash-backup:test -f backup/Dockerfile .`
Expected: build succeeds.

- [ ] **Step 3: Stand up a scratch Postgres aliased as `dragonsstash-db`**

```bash
docker network create backup-test-net 2>/dev/null || true
docker run -d --name test-pg --network backup-test-net --network-alias dragonsstash-db \
  -e POSTGRES_USER=dragons -e POSTGRES_PASSWORD=stash -e POSTGRES_DB=dragonsstash \
  postgres:16-alpine
sleep 5
docker exec test-pg pg_isready -U dragons -d dragonsstash
```

Expected: `accepting connections`.

- [ ] **Step 4: Stand up a mock Kuma push endpoint**

```bash
mkdir -p /tmp/mock-kuma-root && touch /tmp/mock-kuma-root/push
docker run -d --name mock-kuma --network backup-test-net \
  -v /tmp/mock-kuma-root:/srv -w /srv python:3-alpine \
  python3 -m http.server 8000
sleep 1
```

- [ ] **Step 5: Prepare fake TDLib state and a local restic repo dir**

```bash
mkdir -p /tmp/backup-test/tdlib-worker /tmp/backup-test/tdlib-bot /tmp/backup-test/repo
echo "fake-session" > /tmp/backup-test/tdlib-worker/state.bin
echo "fake-session" > /tmp/backup-test/tdlib-bot/state.bin
```

- [ ] **Step 6: Initialize the test restic repo and run `backup.sh` (success path)**

```bash
docker run --rm --network backup-test-net \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=testpassword \
  -v /tmp/backup-test/repo:/backups \
  --entrypoint restic dragonsstash-backup:test init

docker run --rm --network backup-test-net \
  -e POSTGRES_USER=dragons -e POSTGRES_PASSWORD=stash -e PGPASSWORD=stash -e POSTGRES_DB=dragonsstash \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=testpassword \
  -e KUMA_PUSH_URL=http://mock-kuma:8000/push \
  -v /tmp/backup-test/tdlib-worker:/data/tdlib-worker:ro \
  -v /tmp/backup-test/tdlib-bot:/data/tdlib-bot:ro \
  -v /tmp/backup-test/repo:/backups \
  --entrypoint /backup.sh dragonsstash-backup:test
echo "exit code: $?"
```

Expected: exit code `0`, restic prints a line like `snapshot xxxxxxxx saved`, no error output.

- [ ] **Step 7: Verify the snapshot landed and contains both files**

```bash
docker run --rm -v /tmp/backup-test/repo:/backups \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=testpassword \
  --entrypoint restic dragonsstash-backup:test snapshots

docker run --rm -v /tmp/backup-test/repo:/backups \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=testpassword \
  --entrypoint restic dragonsstash-backup:test ls latest
```

Expected: `snapshots` shows exactly one entry; `ls latest` lists `/tmp/dragonsstash.dump` and `/tmp/tdlib.tar.gz`.

- [ ] **Step 8: Verify the failure path reports to Kuma**

```bash
docker run --rm --network backup-test-net \
  -e POSTGRES_USER=dragons -e POSTGRES_PASSWORD=wrongpass -e PGPASSWORD=wrongpass -e POSTGRES_DB=dragonsstash \
  -e RESTIC_REPOSITORY=/backups/restic-repo -e RESTIC_PASSWORD=testpassword \
  -e KUMA_PUSH_URL=http://mock-kuma:8000/push \
  -v /tmp/backup-test/tdlib-worker:/data/tdlib-worker:ro \
  -v /tmp/backup-test/tdlib-bot:/data/tdlib-bot:ro \
  -v /tmp/backup-test/repo:/backups \
  --entrypoint /backup.sh dragonsstash-backup:test
echo "exit code: $?"
docker logs mock-kuma | tail -5
```

Expected: exit code nonzero (pg_dump auth failure trips `set -e`); `docker logs mock-kuma` shows a GET request line containing `status=down`.

- [ ] **Step 9: Clean up test resources**

```bash
docker rm -f test-pg mock-kuma
docker network rm backup-test-net
rm -rf /tmp/backup-test /tmp/mock-kuma-root
```

- [ ] **Step 10: Commit**

```bash
git add backup/backup.sh
git commit -m "Implement backup.sh: pg_dump + tdlib tar + restic backup/forget + Kuma reporting"
```

---

### Task 3: Wire the `backup` service into the repo's `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `backup/Dockerfile` (Task 1), `backup/backup.sh` (Task 2).
- Produces: a `backup` compose service buildable via `docker compose build backup`, and a `nas_backups` named volume other tasks (5) will mirror into the production compose file.

- [ ] **Step 1: Add the `backup` service to `docker-compose.yml`**

Insert after the existing `bot` service (before `db`):

```yaml
  backup:
    build:
      context: .
      dockerfile: backup/Dockerfile
    pull_policy: never
    environment:
      - POSTGRES_USER=${POSTGRES_USER:-dragons}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-stash}
      - PGPASSWORD=${POSTGRES_PASSWORD:-stash}
      - POSTGRES_DB=${POSTGRES_DB:-dragonsstash}
      - RESTIC_REPOSITORY=/backups/restic-repo
      - RESTIC_PASSWORD=${RESTIC_PASSWORD:?Set RESTIC_PASSWORD in .env}
      - KUMA_PUSH_URL=${KUMA_PUSH_URL:?Set KUMA_PUSH_URL in .env}
      - TZ=${TZ:-Etc/UTC}
    volumes:
      - tdlib_state:/data/tdlib-worker:ro
      - tdlib_bot_state:/data/tdlib-bot:ro
      - nas_backups:/backups
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M
    networks:
      - backend
```

- [ ] **Step 2: Add the `nas_backups` volume to the `volumes:` block**

```yaml
  nas_backups:
    driver_opts:
      type: nfs
      o: "addr=${NAS_HOST},rw,nfsvers=4,soft,timeo=100"
      device: ":${NAS_EXPORT_PATH}"
```

- [ ] **Step 3: Document the new env vars in `.env.example`**

Append:

```
# Backup (NAS via NFS + restic)
NAS_HOST=""              # Synology NAS IP or hostname reachable from this host
NAS_EXPORT_PATH=""       # NFS export path, e.g. /volume1/dragonsstash-backups
RESTIC_PASSWORD=""       # generate with: openssl rand -base64 32
KUMA_PUSH_URL=""         # Uptime Kuma Push monitor URL (create the monitor first)
TZ="Etc/UTC"
```

- [ ] **Step 4: Validate the compose file parses**

Run (with dummy values so the `:?` guards don't fail parsing — `AUTH_SECRET` is required by the existing `app` service, not by this change, but `config` validates the whole file):
```bash
RESTIC_PASSWORD=dummy KUMA_PUSH_URL=http://dummy NAS_HOST=dummy NAS_EXPORT_PATH=/dummy AUTH_SECRET=dummy \
  docker compose -f docker-compose.yml config --quiet
```
Expected: no output, exit code 0 (a syntax/interpolation error would print to stderr and exit nonzero).

- [ ] **Step 5: Validate the service actually builds through Compose**

Run:
```bash
RESTIC_PASSWORD=dummy KUMA_PUSH_URL=http://dummy NAS_HOST=dummy NAS_EXPORT_PATH=/dummy AUTH_SECRET=dummy \
  docker compose -f docker-compose.yml build backup
```
Expected: build succeeds (reuses Task 1's image layers).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "Add backup service and nas_backups volume to docker-compose.yml"
```

---

### Task 4: CI — build and push the backup image

**Files:**
- Modify: `.drone.yml`

**Interfaces:**
- Consumes: `backup/Dockerfile` (Task 1).
- Produces: `git.samagsteribbe.nl/admin/dragonsstash-backup:latest` (and `:<short-sha>`), pushed on every push to `main`. Task 5's production compose file references this image tag.

- [ ] **Step 1: Add a `build-backup` step, mirroring `build-worker`/`build-bot`**

Insert after the existing `build-bot` step in `.drone.yml`:

```yaml
  - name: build-backup
    image: plugins/docker
    depends_on: [clone]
    settings:
      repo: git.samagsteribbe.nl/admin/dragonsstash-backup
      registry: git.samagsteribbe.nl
      dockerfile: backup/Dockerfile
      tags:
        - latest
        - "${DRONE_COMMIT_SHA:0:8}"
      username:
        from_secret: gitea_username
      password:
        from_secret: gitea_password
```

- [ ] **Step 2: Add `build-backup` to the `deploy` step's `depends_on`**

Change:
```yaml
  - name: deploy
    image: alpine
    depends_on: [build-app, build-worker, build-bot]
```
to:
```yaml
  - name: deploy
    image: alpine
    depends_on: [build-app, build-worker, build-bot, build-backup]
```

- [ ] **Step 3: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.drone.yml')); print('OK')"`
Expected: `OK` printed, no exception.

- [ ] **Step 4: Commit**

```bash
git add .drone.yml
git commit -m "Add build-backup CI step, include it in deploy dependencies"
```

---

### Task 5: Wire production (`/opt/stacks/DragonsStash`) — requires NAS + Kuma details from the user

**Do not start this task until the user has supplied `NAS_HOST` and `NAS_EXPORT_PATH` for the Synology NFS share, and has created an Uptime Kuma Push monitor (name it `dragonsstash-backup`, ~26h expected heartbeat interval) and shared its push URL. If any of these are missing, stop and ask — do not substitute placeholder values here, since this file drives the real deployment.**

**Files:**
- Modify: `/opt/stacks/DragonsStash/docker-compose.yml`
- Modify: `/opt/stacks/DragonsStash/.env`

**Interfaces:**
- Consumes: `git.samagsteribbe.nl/admin/dragonsstash-backup:latest` (published by Task 4's CI step once merged/pushed), the real `NAS_HOST`/`NAS_EXPORT_PATH`/`KUMA_PUSH_URL` values gathered above.
- Produces: a running `dragonsstash-backup` container on the production host, verified in Task 6.

- [ ] **Step 1: Generate `RESTIC_PASSWORD` and add all four new vars to `/opt/stacks/DragonsStash/.env`**

```bash
cd /opt/stacks/DragonsStash
printf '\n# Backup (NAS via NFS + restic)\nNAS_HOST="<value from user>"\nNAS_EXPORT_PATH="<value from user>"\nRESTIC_PASSWORD="%s"\nKUMA_PUSH_URL="<value from user>"\nTZ="Etc/UTC"\n' "$(openssl rand -base64 32)" >> .env
```

Replace the two `<value from user>` placeholders with the real NAS details and Kuma push URL before saving — this step cannot be completed with the literal placeholder text left in place.

- [ ] **Step 2: Add the `backup` service to `/opt/stacks/DragonsStash/docker-compose.yml`**

Insert after the existing `bot` service (before `db`):

```yaml
  backup:
    image: git.samagsteribbe.nl/admin/dragonsstash-backup:latest
    container_name: dragonsstash-backup
    restart: unless-stopped
    environment:
      - POSTGRES_USER=${POSTGRES_USER:-dragons}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-stash}
      - PGPASSWORD=${POSTGRES_PASSWORD:-stash}
      - POSTGRES_DB=${POSTGRES_DB:-dragonsstash}
      - RESTIC_REPOSITORY=/backups/restic-repo
      - RESTIC_PASSWORD=${RESTIC_PASSWORD:?Set RESTIC_PASSWORD in .env}
      - KUMA_PUSH_URL=${KUMA_PUSH_URL:?Set KUMA_PUSH_URL in .env}
      - TZ=${TZ:-Etc/UTC}
    volumes:
      - tdlib_state:/data/tdlib-worker:ro
      - tdlib_bot_state:/data/tdlib-bot:ro
      - nas_backups:/backups
    depends_on:
      db:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 256M
    networks:
      - internal
```

- [ ] **Step 3: Add the `nas_backups` volume**

```yaml
  nas_backups:
    driver_opts:
      type: nfs
      o: "addr=${NAS_HOST},rw,nfsvers=4,soft,timeo=100"
      device: ":${NAS_EXPORT_PATH}"
```

- [ ] **Step 4: Validate the production compose file parses with the real `.env`**

Run: `cd /opt/stacks/DragonsStash && docker compose config --quiet`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit is not applicable here** — `/opt/stacks/DragonsStash` is a deployed copy, not the git repo (confirm with `git -C /opt/stacks/DragonsStash status` — expect "not a git repository"). Skip committing; Task 6 deploys these file changes directly.

---

### Task 6: Deploy and verify

**Files:** none (operational task)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a running, verified backup on the real NAS, and one completed restore drill.

- [ ] **Step 1: Confirm with the user before pushing/deploying**

Pushing to `main` triggers Drone CI to build all four images and deploy to the production host via SSH (`docker compose pull && docker compose up -d`). Confirm the user wants this to happen now before proceeding — this affects the live stack.

- [ ] **Step 2: Push to `main`**

```bash
cd /home/sam/Documents/DragonsStash
git push origin main
```

Expected: Drone pipeline runs `build-app`, `build-worker`, `build-bot`, `build-backup`, then `deploy`, all green. Check via the Drone UI or `drone build info admin/DragonsStash <build-number>` if the `drone` CLI is configured.

- [ ] **Step 3: Confirm the container is up on the production host**

```bash
ssh sam@192.168.68.68 "docker ps --filter name=dragonsstash-backup --format '{{.Names}}\t{{.Status}}'"
```

Expected: `dragonsstash-backup   Up ...`.

- [ ] **Step 4: Trigger one manual backup run and confirm a snapshot lands on the NAS**

```bash
ssh sam@192.168.68.68 "docker exec dragonsstash-backup /backup.sh"
ssh sam@192.168.68.68 "docker exec dragonsstash-backup restic snapshots"
```

Expected: `backup.sh` exits 0; `restic snapshots` lists exactly one entry.

- [ ] **Step 5: Confirm the Uptime Kuma push monitor shows green**

Open the Uptime Kuma dashboard and check the `dragonsstash-backup` monitor's status is up with a recent heartbeat.

- [ ] **Step 6: Restore drill — prove the backup is actually restorable**

```bash
ssh sam@192.168.68.68 "docker exec dragonsstash-backup restic restore latest --target /tmp/restore-drill"
ssh sam@192.168.68.68 "docker exec dragonsstash-backup ls -la /tmp/restore-drill/tmp"
```

Expected: `/tmp/restore-drill/tmp/dragonsstash.dump` and `/tmp/restore-drill/tmp/tdlib.tar.gz` both present with nonzero size. Then, on a scratch Postgres (not the live `dragonsstash-db`), confirm the dump restores cleanly:

```bash
ssh sam@192.168.68.68 "docker run -d --rm --name restore-drill-pg --network dragonsstash_internal \
  -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill postgres:16-alpine"
ssh sam@192.168.68.68 "docker cp dragonsstash-backup:/tmp/restore-drill/tmp/dragonsstash.dump /tmp/dragonsstash.dump"
ssh sam@192.168.68.68 "docker cp /tmp/dragonsstash.dump restore-drill-pg:/tmp/dragonsstash.dump"
ssh sam@192.168.68.68 "docker exec -e PGPASSWORD=drill restore-drill-pg pg_restore -U drill -d drill --clean --if-exists /tmp/dragonsstash.dump"
ssh sam@192.168.68.68 "docker exec -e PGPASSWORD=drill restore-drill-pg psql -U drill -d drill -c '\\dt' | head -20"
ssh sam@192.168.68.68 "docker rm -f restore-drill-pg"
```

Expected: `pg_restore` completes without fatal errors; `\dt` lists the app's tables (e.g. `Package`, `User`, `TelegramLink`).

- [ ] **Step 7: Clean up drill artifacts**

```bash
ssh sam@192.168.68.68 "docker exec dragonsstash-backup rm -rf /tmp/restore-drill"
ssh sam@192.168.68.68 "rm -f /tmp/dragonsstash.dump"
```
