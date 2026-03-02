# Telegram ZIP Ingestion & Indexing — Integration Plan

> **Status:** Planning phase — no implementation code yet
> **Date:** 2026-02-24
> **Base system:** DragonsStash — Next.js 16 / Prisma 7.4 / PostgreSQL 16 / Docker

---

## 1. Architecture Summary

### Current State

DragonsStash is a monolithic Next.js 16 App Router application for 3D printing inventory management. It uses:

- **Prisma 7.4** with `@prisma/adapter-pg` and native `pg.Pool` connection pooling
- **NextAuth.js 5 beta** with JWT strategy (credentials + optional GitHub OAuth)
- **Docker** multi-stage build (`node:20-alpine`), standalone output
- **PostgreSQL 16-alpine** via docker-compose
- **No background job infrastructure** — all mutations are synchronous Server Actions

### Proposed Architecture

```
┌─────────────────────────────────────────────────┐
│                  Docker Compose                  │
│                                                  │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │   next-app   │  │   telegram-worker      │   │
│  │  (control    │  │   (data plane)         │   │
│  │   plane)     │  │                        │   │
│  │  Port 3000   │  │  - TDLib per account   │   │
│  │              │  │  - ZIP processing      │   │
│  │  - Admin UI  │  │  - Upload to channel   │   │
│  │  - API routes│  │  - Metadata indexing   │   │
│  │  - Auth      │  │                        │   │
│  └──────┬───────┘  └───────────┬────────────┘   │
│         │                      │                 │
│         └──────────┬───────────┘                 │
│                    │                             │
│         ┌──────────▼──────────┐                  │
│         │   PostgreSQL 16     │                  │
│         │   (shared state)    │                  │
│         └─────────────────────┘                  │
│                                                  │
│  Volumes:                                        │
│  - postgres_data (persistent)                    │
│  - tdlib_state (persistent per account)          │
│  - tmp_zips (ephemeral, bounded)                 │
└─────────────────────────────────────────────────┘
```

**Key principle:** The Next.js app is the **control plane** (UI, API, scheduling triggers). The worker container is the **data plane** (TDLib sessions, ZIP download/hash/upload). They communicate exclusively through PostgreSQL.

---

## 2. Proposed Folder Structure

```
DragonsStash/
├── src/                              # Existing Next.js app (unchanged)
│   ├── app/
│   │   ├── (app)/
│   │   │   ├── telegram/             # NEW — admin UI pages
│   │   │   │   ├── accounts/         # Manage Telegram accounts
│   │   │   │   │   └── [id]/
│   │   │   │   │       └── auth/     # [Q2] Phone code entry UI for TDLib auth
│   │   │   │   ├── channels/         # Manage source/destination channels
│   │   │   │   ├── packages/         # Browse indexed ZIPs
│   │   │   │   └── ingestion/        # Ingestion run history & status
│   │   │   └── ...existing...
│   │   └── api/
│   │       ├── ...existing...
│   │       ├── zips/                 # NEW — ZIP query endpoints
│   │       │   ├── route.ts          # GET /api/zips
│   │       │   ├── search/
│   │       │   │   └── route.ts      # GET /api/zips/search
│   │       │   └── [id]/
│   │       │       ├── route.ts      # GET /api/zips/:id
│   │       │       └── files/
│   │       │           └── route.ts  # GET /api/zips/:id/files
│   │       └── ingestion/            # NEW — ingestion control endpoints
│   │           ├── trigger/
│   │           │   └── route.ts      # POST /api/ingestion/trigger
│   │           └── status/
│   │               └── route.ts      # GET /api/ingestion/status
│   ├── lib/
│   │   ├── ...existing...
│   │   └── telegram/                 # NEW — shared types & DB queries
│   │       ├── queries.ts            # Prisma queries for telegram models
│   │       └── types.ts              # Shared TypeScript types
│   └── schemas/
│       ├── ...existing...
│       └── telegram.ts               # NEW — Zod schemas for telegram models
│
├── worker/                           # NEW — separate process, NOT bundled by Next.js
│   ├── Dockerfile                    # Worker-specific Dockerfile (Debian, not Alpine)
│   ├── package.json                  # Worker-only dependencies (tdl, node-stream-zip, unrar, etc.)
│   ├── tsconfig.json                 # Worker TS config (Node target, not bundler)
│   ├── src/
│   │   ├── index.ts                  # Entry point — spawns per-account workers
│   │   ├── scheduler.ts              # Hourly scheduler with jitter
│   │   ├── worker.ts                 # Single-account worker loop
│   │   ├── tdlib/
│   │   │   ├── client.ts             # TDLib client wrapper
│   │   │   └── download.ts           # File download logic
│   │   ├── archive/                  # Renamed from zip/ — handles ZIP + RAR
│   │   │   ├── hash.ts               # Streaming SHA-256 (single + concatenated multipart)
│   │   │   ├── detect.ts             # Archive type & multipart detection
│   │   │   ├── zip-reader.ts         # ZIP central directory reader (yauzl)
│   │   │   ├── rar-reader.ts         # RAR metadata reader (via unrar binary)
│   │   │   ├── multipart.ts          # Multipart grouping & concatenation logic
│   │   │   └── split.ts              # Byte-level splitting for >2GB re-upload
│   │   ├── upload/
│   │   │   └── channel.ts            # Upload to private channel
│   │   ├── db/
│   │   │   ├── client.ts             # Prisma client (shared schema)
│   │   │   ├── locks.ts              # Advisory lock helpers
│   │   │   └── queries.ts            # Worker-specific DB operations
│   │   └── util/
│   │       ├── logger.ts             # Structured logging
│   │       └── config.ts             # Environment config
│   └── tests/
│       └── ...
│
├── prisma/
│   ├── schema.prisma                 # MODIFIED — add telegram models
│   └── migrations/                   # NEW migration(s) added
│
├── docker-compose.yml                # MODIFIED — add worker service
├── docker-compose.dev.yml            # MODIFIED — add worker service for dev
└── ...existing config files...
```

### Boundary Rules

| Concern | Lives in | Reason |
|---------|----------|--------|
| Telegram admin UI | `src/app/(app)/telegram/` | Part of existing authenticated app |
| API routes for querying ZIPs | `src/app/api/zips/`, `src/app/api/ingestion/` | Served by Next.js, uses existing auth |
| Shared Prisma schema | `prisma/schema.prisma` | Single source of truth for all models |
| Worker process | `worker/` | Separate Node.js process, own Dockerfile, own dependencies |
| TDLib native bindings | `worker/` only | Never in the Next.js bundle |
| ZIP processing | `worker/` only | I/O-heavy, must not block Next.js |

### Why not a monorepo / separate package?

- The project is a single repo today. Adding a `worker/` directory is the lightest change.
- The worker shares the Prisma schema but has its own `package.json` — no dependency contamination.
- No need for turborepo/nx complexity for two processes.

---

## 3. Database Schema Proposal

### New Models

All new tables are prefixed with `telegram_` or `tg_` to avoid collision with existing models. Added to `prisma/schema.prisma`.

```prisma
// ──────────────────────────────────────────────
// Telegram Accounts
// ──────────────────────────────────────────────

model TelegramAccount {
  id            String    @id @default(cuid())
  phone         String    @unique                // Phone number (encrypted at rest recommended)
  displayName   String?                          // Friendly label
  apiId         Int                              // Telegram API credentials
  apiHash       String                           // Telegram API credentials
  sessionPath   String                           // Path to TDLib session directory
  isActive      Boolean   @default(true)         // Enabled/disabled toggle
  authState     AuthState @default(PENDING)      // [Q2] TDLib auth state for admin UI flow
  authCode      String?                          // Temporary: phone code entered via admin UI
  lastSeenAt    DateTime?                        // Last successful TDLib connection
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  channelMaps   AccountChannelMap[]
  ingestionRuns IngestionRun[]

  @@index([isActive])
  @@map("telegram_accounts")
}

enum AuthState {
  PENDING          // Account created, not yet authenticated
  AWAITING_CODE    // Worker requested code, waiting for admin to enter it
  AWAITING_PASSWORD // 2FA password needed
  AUTHENTICATED    // Session active
  EXPIRED          // Session expired, needs re-auth
}

// ──────────────────────────────────────────────
// Source & Destination Channels
// ──────────────────────────────────────────────

model TelegramChannel {
  id            String    @id @default(cuid())
  telegramId    BigInt    @unique                // Telegram's numeric channel ID
  title         String                           // Channel title (display only)
  type          ChannelType                      // SOURCE or DESTINATION
  isActive      Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  accountMaps   AccountChannelMap[]
  packages      Package[]                        // ZIPs sourced from / uploaded to

  @@index([type, isActive])
  @@map("telegram_channels")
}

enum ChannelType {
  SOURCE
  DESTINATION
}

// ──────────────────────────────────────────────
// Account ↔ Channel Mapping (many-to-many)
// ──────────────────────────────────────────────

model AccountChannelMap {
  id                      String           @id @default(cuid())
  accountId               String
  channelId               String
  role                    ChannelRole      @default(READER)  // READER for source, WRITER for destination
  lastProcessedMessageId  BigInt?          // [Q3] Last Telegram message ID processed for this account+channel
  createdAt               DateTime         @default(now())

  account     TelegramAccount  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  channel     TelegramChannel  @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([accountId, channelId])
  @@index([accountId])
  @@index([channelId])
  @@map("account_channel_map")
}

enum ChannelRole {
  READER
  WRITER
}

// ──────────────────────────────────────────────
// Packages (indexed archives — ZIP + RAR)
// ──────────────────────────────────────────────

model Package {
  id              String      @id @default(cuid())
  contentHash     String      @unique              // SHA-256 of full content (concatenated for multipart)
  fileName        String                           // Original filename (first part if multipart)
  fileSize        BigInt                            // Total size in bytes (sum of all parts)
  archiveType     ArchiveType                      // ZIP or RAR
  sourceChannelId String                            // Channel it was found in
  sourceMessageId BigInt                            // Telegram message ID (first part if multipart)
  destChannelId   String?                           // Channel it was re-uploaded to
  destMessageId   BigInt?                           // Telegram message ID after upload (first part)
  isMultipart     Boolean     @default(false)       // Was this a multipart archive?
  partCount       Int         @default(1)           // Number of parts (1 if single)
  fileCount       Int         @default(0)           // Number of entries inside archive
  indexedAt        DateTime   @default(now())
  createdAt       DateTime    @default(now())

  // Relations
  sourceChannel TelegramChannel @relation(fields: [sourceChannelId], references: [id])
  files         PackageFile[]
  ingestionRun  IngestionRun?   @relation(fields: [ingestionRunId], references: [id])
  ingestionRunId String?

  @@index([sourceChannelId])
  @@index([destChannelId])
  @@index([fileName])
  @@index([indexedAt])
  @@index([archiveType])
  @@index([contentHash])                          // Already unique, but explicit for search
  @@map("packages")
}

enum ArchiveType {
  ZIP
  RAR
}

// ──────────────────────────────────────────────
// Package Files (metadata only — no binary storage)
// ──────────────────────────────────────────────

model PackageFile {
  id            String    @id @default(cuid())
  packageId     String
  path          String                            // Full path inside archive
  fileName      String                            // Leaf filename
  extension     String?                           // Lowercase file extension
  compressedSize   BigInt  @default(0)            // Compressed size (from ZIP central dir or RAR header)
  uncompressedSize BigInt  @default(0)            // Uncompressed size
  crc32         String?                           // CRC-32 (available in both ZIP and RAR)

  package       Package   @relation(fields: [packageId], references: [id], onDelete: Cascade)

  @@index([packageId])
  @@index([extension])
  @@index([fileName])
  @@map("package_files")
}

// ──────────────────────────────────────────────
// Ingestion Runs (observability)
// ──────────────────────────────────────────────

model IngestionRun {
  id            String          @id @default(cuid())
  accountId     String
  status        IngestionStatus @default(RUNNING)
  startedAt     DateTime        @default(now())
  finishedAt    DateTime?
  messagesScanned Int           @default(0)
  zipsFound     Int             @default(0)
  zipsDuplicate Int             @default(0)
  zipsIngested  Int             @default(0)
  errorMessage  String?

  account       TelegramAccount @relation(fields: [accountId], references: [id])
  packages      Package[]

  @@index([accountId])
  @@index([status])
  @@index([startedAt])
  @@map("ingestion_runs")
}

enum IngestionStatus {
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}
```

### Index Strategy

| Table | Index | Purpose |
|-------|-------|---------|
| `packages` | `contentHash` (UNIQUE) | Global deduplication — the core constraint |
| `packages` | `sourceChannelId` | Filter ZIPs by source channel |
| `packages` | `fileName` | Search by filename |
| `packages` | `indexedAt` | Sort by recency |
| `package_files` | `packageId` | Lookup files per package |
| `package_files` | `extension` | Filter by file type (e.g., `.stl`, `.gcode`) |
| `package_files` | `fileName` | Full-text-like search on filenames |
| `ingestion_runs` | `accountId` + `status` | Find running jobs per account |
| `telegram_accounts` | `isActive` | Filter active accounts |
| `telegram_channels` | `type` + `isActive` | Filter active source/destination channels |

### Full-Text Search Consideration

For `GET /api/zips/search?q=`, Prisma's `contains` with `mode: insensitive` is sufficient for moderate data volumes (<100k packages). If search becomes a bottleneck:
- Add a PostgreSQL `GIN` index with `pg_trgm` on `package_files.fileName`
- This can be done via a raw SQL migration later without schema changes

### Migration Approach

1. Create a new Prisma migration: `npx prisma migrate dev --name add_telegram_models`
2. This is purely additive — no existing tables are modified
3. Deploy with existing `docker-entrypoint.sh` which already runs `prisma migrate deploy`
4. No data migration needed — all new tables start empty

---

## 4. Worker Lifecycle Design

### 4.1 Process Model

```
telegram-worker container
│
├── index.ts (main process)
│   ├── Reads active accounts from DB
│   ├── Starts scheduler
│   └── Handles SIGTERM/SIGINT for graceful shutdown
│
├── scheduler.ts
│   ├── Runs on configurable interval (default: 60 min)
│   ├── Adds random jitter (0–5 min) to avoid thundering herd
│   └── For each active account → enqueue work
│
└── worker.ts (per-account execution)
    ├── Acquires PostgreSQL advisory lock (account-specific)
    ├── If lock fails → skip (another instance is running)
    ├── Creates TDLib client for account
    ├── Iterates source channels
    ├── For each new message with ZIP attachment:
    │   ├── Download ZIP to temp directory
    │   ├── Stream SHA-256 hash
    │   ├── Check contentHash uniqueness in DB
    │   ├── If duplicate → delete temp file, record skip
    │   ├── If new:
    │   │   ├── Read central directory for metadata
    │   │   ├── If >2GB → repack into parts
    │   │   ├── Upload to destination channel via TDLib
    │   │   ├── Insert Package + PackageFile rows
    │   │   └── Delete temp file
    │   └── Update ingestion run counters
    ├── Finalize ingestion run (status = COMPLETED or FAILED)
    └── Release advisory lock
```

### 4.2 Advisory Lock Strategy

PostgreSQL advisory locks prevent concurrent ingestion for the same account, even across multiple worker containers (for future horizontal scaling).

```
Lock ID derivation:
  lock_id = hash(account.id) → stable 64-bit integer

Acquisition:
  SELECT pg_try_advisory_lock($lock_id)
  → Returns true if acquired, false if held by another session

Release:
  SELECT pg_advisory_unlock($lock_id)
  → Explicitly released at end of worker run

Crash recovery:
  Advisory locks are session-scoped — if the worker process dies,
  the DB connection closes and the lock is automatically released.
```

### 4.3 Worker Loop Pseudocode

```
async function runWorkerForAccount(accountId: string) {
  const lockId = stableHash(accountId)

  // 1. Acquire lock
  const acquired = await db.$queryRaw`SELECT pg_try_advisory_lock(${lockId})`
  if (!acquired) {
    log.info(`Account ${accountId} already locked, skipping`)
    return
  }

  try {
    // 2. Create ingestion run record
    const run = await db.ingestionRun.create({
      data: { accountId, status: 'RUNNING' }
    })

    // 3. Initialize TDLib client
    const client = await createTdlibClient(account)

    // 4. Get assigned source channels
    const channels = await getSourceChannels(accountId)

    for (const channel of channels) {
      // 5. Get messages since last processed message
      const mapping = await getChannelMapping(accountId, channel.id)
      const messages = await getChannelMessages(client, channel.telegramId, mapping.lastProcessedMessageId)

      // 6. Detect archives and group multipart sets
      const archiveSets = groupArchiveSets(messages)
      // archiveSets = [{ type: 'ZIP'|'RAR', parts: [msg, msg, ...], baseName: '...' }, ...]

      for (const archiveSet of archiveSets) {
        run.messagesScanned += archiveSet.parts.length
        const tempPaths: string[] = []

        try {
          // 7. Download all parts
          for (const part of archiveSet.parts) {
            const tempPath = path.join(TEMP_DIR, `${run.id}_${part.id}_${part.fileName}`)
            await downloadFile(client, part.fileId, tempPath)
            tempPaths.push(tempPath)
          }

          // 8. Concatenated SHA-256 hash (streams all parts in order)
          const contentHash = await hashParts(tempPaths)

          // 9. Deduplicate
          const exists = await db.package.findUnique({ where: { contentHash } })
          if (exists) {
            run.zipsDuplicate++
            continue  // temp files deleted in finally
          }

          // 10. Read archive metadata (without extraction)
          let entries: FileEntry[] = []
          if (archiveSet.type === 'ZIP') {
            // Read central directory from last part (or reassembled file)
            entries = await readZipCentralDirectory(tempPaths)
          } else {
            // RAR: unrar l -v on first part auto-discovers other parts
            entries = await readRarContents(tempPaths[0])
          }

          // 11. Prepare upload — byte-level split if single file >2GB
          const totalSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n)
          let uploadPaths = tempPaths
          if (!archiveSet.isMultipart && totalSize > 2n * 1024n * 1024n * 1024n) {
            uploadPaths = await byteLevelSplit(tempPaths[0])
          }

          // 12. Upload to destination channel
          const destResult = await uploadToChannel(client, destChannel, uploadPaths)

          // 13. Persist metadata
          await db.package.create({
            data: {
              contentHash,
              fileName: archiveSet.parts[0].fileName,
              fileSize: totalSize,
              archiveType: archiveSet.type,
              sourceChannelId: channel.id,
              sourceMessageId: archiveSet.parts[0].id,
              destChannelId: destChannel.id,
              destMessageId: destResult.messageId,
              isMultipart: archiveSet.parts.length > 1 || uploadPaths.length > 1,
              partCount: uploadPaths.length,
              fileCount: entries.length,
              ingestionRunId: run.id,
              files: {
                create: entries.map(e => ({
                  path: e.path,
                  fileName: e.fileName,
                  extension: e.extension,
                  compressedSize: e.compressedSize,
                  uncompressedSize: e.uncompressedSize,
                  crc32: e.crc32,
                }))
              }
            }
          })

          run.zipsIngested++
        } finally {
          // 14. ALWAYS delete all temp files
          await deleteFiles(...tempPaths, ...splitPaths)
        }
      }

      // 15. Update last processed message ID
      const lastMsg = messages[messages.length - 1]
      if (lastMsg) {
        await db.accountChannelMap.update({
          where: { id: mapping.id },
          data: { lastProcessedMessageId: lastMsg.id }
        })
      }
    }

    // 14. Finalize run
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', finishedAt: new Date(), ...run.counters }
    })

  } catch (error) {
    // 15. Record failure
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: error.message }
    })
  } finally {
    // 16. Release lock
    await db.$queryRaw`SELECT pg_advisory_unlock(${lockId})`
    // 17. Destroy TDLib client
    await client?.close()
  }
}
```

### 4.4 Crash Recovery

| Scenario | Recovery |
|----------|----------|
| Worker process crashes mid-ingestion | Advisory lock auto-released on DB disconnect. Next scheduled run picks up. Partial `IngestionRun` with `RUNNING` status is detected on startup and marked `FAILED`. |
| DB connection lost | Worker catches error, marks run as `FAILED`, exits. Scheduler retries on next cycle. |
| TDLib rate-limited (420/429) | Exponential backoff with max 5 retries. If exhausted, marks run as `FAILED` with error message. |
| Temp file left on disk | On worker startup, sweep `TEMP_DIR` and delete all files (no state depends on temp files). |
| Duplicate detection race | `contentHash` UNIQUE constraint is the final guard — `INSERT` will fail with unique violation, which is caught and treated as a duplicate. |

### 4.5 Scheduler Design

```
┌─────────────────────────────────────────────┐
│ Scheduler (runs in main worker process)     │
│                                             │
│  setInterval(runCycle, INTERVAL_MS)         │
│  + random jitter: Math.random() * 5min      │
│                                             │
│  runCycle():                                │
│    accounts = db.telegramAccount.findMany({ │
│      where: { isActive: true }              │
│    })                                       │
│    for (account of accounts):               │
│      // Sequential, not parallel            │
│      await runWorkerForAccount(account.id)  │
│                                             │
│  // Also responds to manual triggers:       │
│  // Polls ingestion_trigger table or uses   │
│  // PostgreSQL LISTEN/NOTIFY                │
└─────────────────────────────────────────────┘
```

**Manual trigger mechanism:** The `POST /api/ingestion/trigger` API route writes a row to a lightweight `ingestion_triggers` table (or uses `pg_notify`). The worker polls this table or listens on a channel.

---

## 5. Docker Strategy

### 5.1 Recommended Architecture: Separate Containers

**Reason:** TDLib requires Debian/Ubuntu (not Alpine) and native compilation. The Next.js app uses `node:20-alpine`. Mixing them bloats the app image and introduces risk.

### 5.2 Worker Dockerfile

```dockerfile
# worker/Dockerfile
FROM node:20-bookworm-slim AS base

# TDLib system dependencies + unrar for RAR metadata reading
RUN apt-get update && apt-get install -y \
    libssl-dev \
    zlib1g-dev \
    unrar \
    && rm -rf /var/lib/apt/lists/*

# Pre-built TDLib binary (or build from source in multi-stage)
COPY --from=tdlib-builder /usr/local/lib/libtdjson.so /usr/local/lib/
RUN ldconfig

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY prisma/ ./prisma/
RUN npx prisma generate

COPY dist/ ./dist/

# Non-root user
RUN addgroup --system worker && adduser --system --ingroup worker worker
USER worker

# Volumes
VOLUME ["/data/tdlib", "/tmp/zips"]

CMD ["node", "dist/index.js"]
```

### 5.3 Updated docker-compose.yml

```yaml
services:
  app:
    # ...existing config unchanged...
    depends_on:
      db:
        condition: service_healthy

  worker:
    build:
      context: .
      dockerfile: worker/Dockerfile
    environment:
      DATABASE_URL: ${DATABASE_URL}
      WORKER_INTERVAL_MINUTES: 60
      WORKER_TEMP_DIR: /tmp/zips
      TDLIB_STATE_DIR: /data/tdlib
      LOG_LEVEL: info
    volumes:
      - tdlib_state:/data/tdlib        # Persistent TDLib sessions
      - tmp_zips:/tmp/zips             # Ephemeral ZIP processing
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    # Resource limits (optional but recommended)
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 256M

  db:
    # ...existing config unchanged...

volumes:
  postgres_data:
  tdlib_state:
  tmp_zips:                          # Disk-backed (not tmpfs) — 16GB RAM is not enough for large archives
```

### 5.4 Volume Plan

| Volume | Type | Purpose | Lifecycle |
|--------|------|---------|-----------|
| `postgres_data` | Persistent | Database storage | Permanent |
| `tdlib_state` | Persistent | TDLib session databases (one subdirectory per account) | Permanent — losing this requires re-authentication |
| `tmp_zips` | Disk-backed volume | Temporary archive download/processing | Worker sweeps on startup + deletes after each archive. Not RAM-bound. |

### 5.5 Environment Variable Separation

| Variable | App | Worker | Description |
|----------|-----|--------|-------------|
| `DATABASE_URL` | Yes | Yes | Shared PostgreSQL connection |
| `AUTH_SECRET` | Yes | No | NextAuth session secret |
| `NEXT_PUBLIC_APP_URL` | Yes | No | Public URL |
| `WORKER_INTERVAL_MINUTES` | No | Yes | Scheduler interval |
| `WORKER_TEMP_DIR` | No | Yes | Temp ZIP storage path |
| `TDLIB_STATE_DIR` | No | Yes | TDLib session storage path |
| `WORKER_MAX_ZIP_SIZE_MB` | No | Yes | Max ZIP size before rejecting (default: 4096) |
| `TELEGRAM_API_KEY` | Yes | No | [Q4] Static API key for external app access (MVP) |
| `LOG_LEVEL` | Optional | Yes | Logging verbosity |

---

## 6. Archive Processing Strategy

Supports **ZIP** and **RAR** archives, including multipart variants of both.

### 6.1 Supported Archive Formats

| Format | Single file | Multipart patterns | Metadata reader |
|--------|------------|-------------------|-----------------|
| ZIP | `.zip` | `.zip.001`/`.002`/... or `.z01`/`.z02`/...+`.zip` | `yauzl` — reads central directory without extraction |
| RAR | `.rar` | `.part1.rar`/`.part2.rar`/... or `.r00`/`.r01`/...+`.rar` | `unrar l -v` — lists contents via CLI binary |

### 6.2 Processing Pipeline

```
Messages scanned in source channel
    │
    ▼
Detect archive attachments (.zip, .rar, .z01, .r01, .part1.rar, etc.)
    │
    ▼
Group multipart sets (by filename pattern + message proximity)
    │
    ├── Single-file archive → download one file
    └── Multipart set → download ALL parts
    │
    ▼
Concatenated SHA-256 hash (stream all parts in order through hasher)
    │                               ┌──────────────────────┐
    ▼                               │ contentHash exists?   │
Check contentHash against packages  │ YES → delete all temp │
    │                               │        files & skip   │
    │ NO (new archive)              └──────────────────────┘
    ▼
Reassemble if multipart (concatenate parts into single file)
    │
    ▼
Read archive metadata
    ├── ZIP → yauzl central directory reader (no extraction)
    └── RAR → `unrar l -v <file>` (lists contents without extraction)
    │
    ▼
Prepare for upload
    ├── Total size ≤2GB → upload as-is (single file)
    ├── Total size >2GB → byte-level split into ≤2GB parts
    └── Originally multipart → re-upload original parts as-is
    │
    ▼
Upload to destination channel via TDLib
    │
    ▼
Insert Package + PackageFile rows in single transaction
    │
    ▼
DELETE all temp files immediately (in finally block)
```

### 6.3 Multipart Grouping Logic

Archives split into multiple parts arrive as **separate Telegram messages**. The worker must group them before processing.

**Detection rules:**

```
For a message with filename "pack.zip.003":
  → base = "pack.zip", part = 3, type = ZIP_NUMBERED

For a message with filename "pack.z02":
  → base = "pack", part = 2, type = ZIP_LEGACY (final part is "pack.zip")

For a message with filename "pack.part2.rar":
  → base = "pack", part = 2, type = RAR_PART

For a message with filename "pack.r01":
  → base = "pack", part = 1, type = RAR_LEGACY (final part is "pack.rar")
```

**Grouping strategy:**
1. Scan channel messages and build a map: `base_name → [parts]`
2. A multipart set is complete when parts form a contiguous sequence (1..N)
3. **Timeout:** If parts span >24 hours of messages, treat as incomplete — log warning, skip
4. Incomplete sets are retried on next ingestion run (parts may still be uploading to source)

### 6.4 Concatenated Hashing

For multipart archives, all parts are streamed through a single SHA-256 hasher **in order**:

```typescript
import { createReadStream } from 'fs'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { PassThrough } from 'stream'

async function hashParts(filePaths: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const filePath of filePaths) {
    await pipeline(createReadStream(filePath), new PassThrough({ transform(chunk, _, cb) {
      hash.update(chunk)
      cb()
    }}))
  }
  return hash.digest('hex')
}
```

- Memory: O(1) — streams 64KB chunks regardless of total size
- For single files, this is equivalent to hashing one file
- Part order is determined by the numeric suffix (sorted ascending)

### 6.5 Metadata Reading

**ZIP (via `yauzl`):**
- Opens the (reassembled) ZIP file
- Iterates central directory entries at the end of the file — **no extraction**
- Collects: `path`, `fileName`, `extension`, `compressedSize`, `uncompressedSize`, `crc32`
- Memory: O(n) where n = number of entries (metadata only, typically <1MB)

**RAR (via `unrar` binary):**
- Runs `unrar l -v <file>` as a child process
- Parses stdout for file list with sizes and CRC
- **No extraction** — `l` (list) mode only
- Collects same fields: `path`, `fileName`, `extension`, `compressedSize`, `uncompressedSize`, `crc32`
- Requires `unrar` installed in worker Docker image

**Fallback:** If metadata reading fails (corrupted archive, unsupported format), the package is still ingested with `fileCount = 0` and no `PackageFile` rows. A warning is logged. The archive is still hashed, uploaded, and deduplicated — just without internal file listing.

### 6.6 Re-upload Strategy

| Scenario | Action |
|----------|--------|
| Single file ≤2GB | Upload as-is |
| Single file >2GB | Byte-level split into ≤2GB chunks, upload each as separate message |
| Originally multipart, each part ≤2GB | Re-upload each original part as-is (preserving original split) |
| Originally multipart, any part >2GB | This shouldn't happen (Telegram's own limit) — log error, skip |

**Byte-level splitting** uses `fs.createReadStream` with `start`/`end` byte offsets. Parts are named `filename.zip.001`, `.002`, etc. No decompression or recompression involved.

### 6.7 Disk Usage Guarantees

- **Bounded by `WORKER_MAX_ZIP_SIZE_MB` env var** (default: 4096MB per archive set)
- **One archive set per worker at a time** (sequential per account)
- **Immediate deletion** of all temp files after upload or on any error (in `finally` block)
- **Startup cleanup:** Worker sweeps `TEMP_DIR` on boot

**Worst-case disk usage scenarios:**

| Scenario | Temp disk needed | Notes |
|----------|-----------------|-------|
| Single 2GB ZIP | 2GB | Trivial |
| Single 10GB ZIP → split for upload | ~20GB (original + parts) | Needs free disk space |
| Multipart RAR (10 × 2GB parts) | 20GB (parts) | No reassembly needed for RAR |
| Multipart ZIP (10 × 2GB parts, no reassembly) | 20GB (parts only) | Central dir read from last part |
| Multipart ZIP (10 × 2GB parts) + reassembly fallback | ~40GB (parts + reassembled) | Only if last-part read fails |

Disk space is bounded per-archive-set, not globally. Worker processes one set at a time and deletes everything before moving to the next. Ensure the host has sufficient free disk space for the largest expected archive set.

**Optimization for multipart archives:** Avoid reassembly into a single file when possible:
- **Hashing:** Stream parts in order — no reassembly needed
- **ZIP metadata:** Read central directory from last part only (it's stored at the end) — avoids full reassembly in most cases
- **RAR metadata:** Run `unrar l -v` on the first part (it auto-discovers subsequent parts if co-located) — no reassembly needed
- **Full reassembly** only needed if the above approaches fail (corrupted or non-standard split)

---

## 7. API Route Plan

### 7.1 Endpoint List

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| `GET` | `/api/zips` | List packages with pagination & filters | Yes |
| `GET` | `/api/zips/:id` | Get single package details | Yes |
| `GET` | `/api/zips/:id/files` | List files inside a package | Yes |
| `GET` | `/api/zips/search?q=` | Search packages/files by name | Yes |
| `POST` | `/api/ingestion/trigger` | Trigger manual ingestion for account(s) | Yes (ADMIN) |
| `GET` | `/api/ingestion/status` | Get current ingestion status | Yes |

### 7.2 Endpoint Details

#### `GET /api/zips`

**Query Parameters:**
```
?page=1           (default: 1)
&limit=25         (default: 25, max: 100)
&channelId=...    (filter by source channel)
&sortBy=indexedAt  (indexedAt | fileName | fileSize)
&order=desc       (asc | desc)
```

**Response:**
```json
{
  "items": [
    {
      "id": "clx...",
      "fileName": "model-pack-v2.zip",
      "fileSize": 1073741824,
      "contentHash": "a1b2c3...",
      "archiveType": "ZIP",
      "fileCount": 47,
      "sourceChannel": { "id": "...", "title": "3D Models Group" },
      "isMultipart": false,
      "indexedAt": "2026-02-24T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 1234,
    "totalPages": 50
  }
}
```

#### `GET /api/zips/:id`

**Response:**
```json
{
  "id": "clx...",
  "fileName": "model-pack-v2.zip",
  "fileSize": 1073741824,
  "contentHash": "a1b2c3d4...",
  "archiveType": "ZIP",
  "fileCount": 47,
  "sourceChannel": { "id": "...", "title": "3D Models Group" },
  "destChannel": { "id": "...", "title": "Archive Channel" },
  "destMessageId": 12345,
  "isMultipart": false,
  "partCount": 1,
  "indexedAt": "2026-02-24T10:00:00Z",
  "ingestionRun": { "id": "...", "startedAt": "..." }
}
```

#### `GET /api/zips/:id/files`

**Query Parameters:**
```
?page=1
&limit=50          (default: 50, max: 500)
&extension=stl     (filter by extension)
```

**Response:**
```json
{
  "items": [
    {
      "id": "clx...",
      "path": "models/dragon/body.stl",
      "fileName": "body.stl",
      "extension": "stl",
      "compressedSize": 524288,
      "uncompressedSize": 1048576,
      "crc32": "deadbeef"
    }
  ],
  "pagination": { ... }
}
```

#### `GET /api/zips/search?q=`

**Query Parameters:**
```
?q=dragon          (search term — matches filename, file paths)
&page=1
&limit=25
&searchIn=files    (packages | files | both; default: both)
```

**Response:** Same format as `GET /api/zips` but with additional `matchedFiles` count per package.

#### `POST /api/ingestion/trigger`

**Request Body:**
```json
{
  "accountId": "clx..."     // Optional — omit to trigger all active accounts
}
```

**Response:**
```json
{
  "triggered": true,
  "accountIds": ["clx..."],
  "message": "Ingestion queued for 1 account(s)"
}
```

**Implementation:** Inserts into a `ingestion_triggers` table or sends `pg_notify('ingestion_trigger', accountId)`. Returns immediately — does NOT wait for ingestion to complete.

#### `GET /api/ingestion/status`

**Response:**
```json
{
  "accounts": [
    {
      "id": "clx...",
      "displayName": "Bot Account 1",
      "isActive": true,
      "lastRun": {
        "id": "clx...",
        "status": "COMPLETED",
        "startedAt": "2026-02-24T09:00:00Z",
        "finishedAt": "2026-02-24T09:12:34Z",
        "messagesScanned": 150,
        "zipsFound": 12,
        "zipsDuplicate": 3,
        "zipsIngested": 9
      },
      "currentRun": null
    }
  ]
}
```

### 7.3 Authentication Strategy

**For existing admin UI routes:** Use the existing NextAuth.js session — these routes are already behind the middleware auth check.

**For external app API access (MVP):** Single static API key via `TELEGRAM_API_KEY` env var. API route middleware checks `X-API-Key` header against this value first, then falls back to NextAuth session. No DB table needed. Upgrade to dynamic key management later if needed.

### 7.4 Security Considerations

- All endpoints require authentication (no public access)
- `POST /api/ingestion/trigger` requires ADMIN role
- Rate limiting on search endpoint (prevent abuse)
- No binary data returned — metadata only
- Input validation with Zod on all query parameters
- Pagination enforced with max limits to prevent large responses

---

## 8. Environment Audit Checklist

### Node.js & Runtime

| Check | Status | Notes |
|-------|--------|-------|
| Node.js version | **20.x** (current) | Compatible with TDLib bindings. Node 20 is LTS until 2026-10. |
| `node:20-alpine` for Next.js | **OK** | Keep as-is for app container |
| `node:20-bookworm-slim` for worker | **Required** | TDLib needs glibc, not musl (Alpine). Debian Bookworm is the right base. |
| ES module support | **OK** | tsconfig targets ES2017, worker can use same |

### TDLib

| Check | Status | Notes |
|-------|--------|-------|
| TDLib Node.js binding | Use `tdl` npm package | Wraps `libtdjson.so` via FFI |
| `libtdjson.so` availability | Must compile or use pre-built | Pre-built for Debian available via GitHub releases |
| Required OS packages | `libssl-dev`, `zlib1g-dev`, `unrar` | TDLib runtime + RAR metadata reading. Build needs `cmake`, `g++`, `git` (multi-stage). |
| TDLib state persistence | Volume-mount `/data/tdlib` | One subdirectory per account. Losing this = re-auth required. |
| TDLib version | Use latest stable (1.8.x+) | Check `tdl` compatibility matrix |

### PostgreSQL

| Check | Status | Notes |
|-------|--------|-------|
| PostgreSQL version | **16-alpine** (current) | Fully compatible, supports advisory locks, `pg_trgm`, `BigInt` |
| Connection pooling | **`pg.Pool`** via `@prisma/adapter-pg` | Worker needs its own pool (separate process). Default pool size = 10 is fine. |
| Max connections | Check `max_connections` | Default is 100. App + worker + Prisma Studio = ~30 connections typical. Safe. |
| Advisory lock support | **Built-in** | `pg_try_advisory_lock()` / `pg_advisory_unlock()` — no extensions needed |
| `BigInt` column support | **OK** | Prisma 7.4 supports `BigInt` natively. Telegram IDs need `BigInt`. |
| `pg_trgm` extension | **Not installed** | Optional — only needed if full-text search on filenames becomes a requirement |

### Docker

| Check | Status | Notes |
|-------|--------|-------|
| Multi-service compose | **Supported** | Current compose already has `app` + `db`. Adding `worker` is straightforward. |
| tmpfs volume | **Supported** | For bounded temp ZIP storage |
| Health checks | **Exists for `db`** | Add health check for worker (e.g., check DB connectivity) |
| Resource limits | **Not set** | Recommend adding `memory: 1G` limit for worker |

### Disk I/O

| Check | Status | Notes |
|-------|--------|-------|
| Temp archive storage | Disk-backed Docker volume | Not RAM-bound. Cleaned by worker on startup + after each set. |
| Max single set I/O | Depends on archive size | One set at a time. Bounded by `WORKER_MAX_ZIP_SIZE_MB`. |
| TDLib state I/O | Low | Session DB is small (<10MB per account) |
| PostgreSQL I/O | Moderate | Package metadata is small. 10k packages ≈ few MB. |

### Logging

| Check | Status | Notes |
|-------|--------|-------|
| App logging | Next.js default (console) | No change needed |
| Worker logging | **Needs structured logging** | Use `pino` for JSON-structured logs. Docker captures stdout. |
| Log volume | Moderate | Log ingestion run summaries, not per-message details |

---

## 9. Risk Assessment

### Risk Matrix

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Telegram rate limiting (420 FLOOD_WAIT)** | High | Medium — ingestion paused | Exponential backoff with jitter. Respect `retry_after` from Telegram. Sequential processing per account. Configurable inter-message delay (default: 1s). |
| R2 | **DB contention on `packages.contentHash` unique check** | Low | Low — single writer per account | Advisory locks serialize writes per account. Unique constraint handles races at DB level. No read contention (separate queries). |
| R3 | **Multi-account race on same ZIP** | Medium | Low — duplicate insert fails safely | `contentHash` UNIQUE constraint is the ultimate guard. Worker catches unique violation and treats as duplicate. No data corruption possible. |
| R4 | **TDLib session invalidation** | Medium | High — account becomes unusable | Monitor `lastSeenAt`. Alert in admin UI when >2 hours stale. Document re-authentication procedure. Store session in persistent volume. |
| R5 | **Worker OOM on large ZIP** | Low | Medium — worker crashes | Streaming hash (O(1) memory). Central directory reading is O(entries) not O(file-size). tmpfs bound prevents unbounded growth. Container memory limit enforced. |
| R6 | **Temp files not cleaned up** | Low | Low — bounded by tmpfs | `finally` blocks on all paths. Startup sweep of temp dir. tmpfs auto-cleared on container restart. |
| R7 | **TDLib native dependency breakage on upgrade** | Medium | High — worker won't start | Pin TDLib version. Test upgrades in CI. Multi-stage Docker build isolates build dependencies. |
| R8 | **PostgreSQL connection exhaustion** | Low | High — all services affected | Worker uses own pool (max 5 connections). App pool unchanged. Monitor with `pg_stat_activity`. Total < 50% of `max_connections`. |
| R9 | **Schema migration breaks existing app** | Very Low | High — production down | New tables only — no modifications to existing tables. Test migration on staging first. Rollback = drop new tables. |
| R10 | **Telegram account banned** | Medium | Medium — one account lost | Use multiple accounts across channels. Don't exceed rate limits. Implement per-account disable toggle. Monitor in admin UI. |
| R11 | **Multipart ZIP reassembly failure** | Low | Low — single ZIP skipped | Log error, mark run as partial. Don't block ingestion of other ZIPs. Admin can investigate specific failures. |
| R12 | **Database grows too large** | Low (long-term) | Medium | `PackageFile` is metadata only (~200 bytes/row). 100k ZIPs × 100 files = 10M rows ≈ 2GB. Add retention policy if needed later. |

### Critical Path Risks (ordered by priority)

1. **TDLib compilation & runtime in Docker** — This is the highest-risk item. TDLib native compilation is complex. Mitigate by using pre-built binaries from `https://github.com/nicknisi/tdlib-builds` or building in a dedicated multi-stage Dockerfile.

2. **Telegram rate limits** — Primary bottleneck for ingestion throughput. Cannot be eliminated, only managed. Design must be rate-limit-aware from day one.

3. **TDLib session persistence** — Losing session state means manual re-authentication (phone code). Volume mount is critical and must survive container rebuilds.

---

## 10. Assumptions & Open Questions

### Assumptions Made

| # | Assumption | Impact if Wrong |
|---|-----------|----------------|
| A1 | One Telegram account maps to multiple source channels | Schema supports this via `AccountChannelMap` |
| A2 | One shared destination channel for all re-uploads | If multiple destinations needed, `Package.destChannelId` already supports it |
| A3 | ZIP files are single-message attachments (not split across messages by Telegram) | Multipart detection logic may need adjustment |
| A4 | Worker runs 24/7 in Docker alongside the app | If serverless/on-demand execution needed, architecture changes |
| A5 | All Telegram accounts share the same `apiId`/`apiHash` | If not, the schema already supports per-account credentials |
| A6 | No need for real-time notifications (webhooks) on new ZIPs | If needed, add a webhook/event system later |
| A7 | Admin users manage Telegram config; regular users only query ZIPs | Role-based access matches existing `ADMIN`/`USER` enum |

### Decisions (Confirmed)

| # | Question | Decision | Implications |
|---|----------|----------|-------------|
| Q1 | Prisma schema sharing | **Shared** — single `prisma/schema.prisma` | Worker copies `prisma/` at build time. One migration path. Worker runs `prisma generate` in its own Dockerfile. |
| Q2 | TDLib authentication flow | **Admin UI** — Next.js page for phone code entry | Requires an `auth_state` column on `TelegramAccount` + a polling/SSE mechanism. Worker watches DB for auth completion. New page at `src/app/(app)/telegram/accounts/[id]/auth/`. |
| Q3 | Last processed message tracking | **In DB** — `lastProcessedMessageId BigInt?` on `AccountChannelMap` | Worker updates after each channel scan. Allows manual reset for re-processing. Survives TDLib session loss. |
| Q4 | API key management | **Env var for MVP** — single `TELEGRAM_API_KEY` in `.env` | API routes check `X-API-Key` header against env var. No DB table needed yet. Upgrade to dynamic keys later if needed. |
| Q5 | File search strategy | **Prisma `contains`** (case-insensitive `ILIKE`) | No extra extensions or indexes. Revisit with `pg_trgm` GIN index if search exceeds ~100k `PackageFile` rows. |
| Q6 | Repack strategy for >2GB | **Byte-level split** — raw file splitting into ≤2GB chunks | No decompression. Fast. Uses `fs.createReadStream` with `start`/`end` options. Parts named `filename.zip.001`, `.002`, etc. |
| Q7 | Worker package structure | **Standalone** `package.json` | Own `node_modules`, own lockfile. No npm workspace config. Simpler Docker builds. Copies `prisma/` from root at build time. |
| Q8 | Archive format support | **ZIP + RAR (full index)** | Both formats supported. RAR metadata via `unrar l -v` binary (no extraction). Worker Dockerfile includes `unrar` package. `ArchiveType` enum on `Package` model. |
| Q9 | Multipart hashing strategy | **Concatenate then hash** | All parts streamed in order through a single SHA-256 hasher. True content-level dedup. Disk must hold all parts simultaneously. Volume is disk-backed (not tmpfs) to avoid RAM pressure. |
| Q10 | Multipart metadata indexing | **Yes, full indexing** | ZIP: read central directory from last part. RAR: `unrar l -v` on first part auto-discovers siblings. Fallback: ingest without file listing if reading fails. |

---

## Summary of Changes to Existing System

| File/Area | Change Type | Risk |
|-----------|-------------|------|
| `prisma/schema.prisma` | **Add** new models (no modify) | Very Low |
| `prisma/migrations/` | **Add** new migration | Very Low |
| `docker-compose.yml` | **Modify** — add worker service + volumes | Low |
| `docker-compose.dev.yml` | **Modify** — add worker service | Low |
| `src/app/(app)/telegram/` | **Add** new pages | None — new route group |
| `src/app/api/zips/` | **Add** new API routes | None — new routes |
| `src/app/api/ingestion/` | **Add** new API routes | None — new routes |
| `src/lib/telegram/` | **Add** shared types & queries | None — new files |
| `worker/` | **Add** entire new directory | None — isolated process |
| Existing code | **No changes** | Zero risk |

**Total impact on existing system: Minimal.** All changes are additive. No existing files are modified except `prisma/schema.prisma` (additive models) and `docker-compose.yml` (additive service).
