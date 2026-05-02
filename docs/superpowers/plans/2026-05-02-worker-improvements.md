# Worker Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix double-uploads from concurrent accounts and crash-before-write scenarios, enable parallel account ingestion, and apply per-account Telegram Premium upload limits.

**Architecture:** Three independent changes wired together: (1) hash advisory lock + two-phase DB write closes both double-upload races; (2) per-key mutex replaces the global TDLib mutex so different accounts run in parallel while the same account is still serialized; (3) `getMe().is_premium` drives a per-account `maxUploadSize` that overrides the global `MAX_PART_SIZE_MB` default — effectively eliminating repacking for the Premium account.

**Tech Stack:** Node.js, TypeScript, TDLib (`tdl`), PostgreSQL (Prisma ORM + raw `pg` pool for advisory locks), Docker Compose. No test framework — verification is manual via logs, DB inspection, and Telegram channel checks.

---

## File Map

| File | What changes |
|---|---|
| `prisma/schema.prisma` | Add `isPremium Boolean @default(false)` to `TelegramAccount` |
| `worker/src/db/queries.ts` | Add `updateAccountPremiumStatus`, `createPackageStub`, `updatePackageWithMetadata` |
| `worker/src/db/locks.ts` | Add `tryAcquireHashLock`, `releaseHashLock` |
| `worker/src/tdlib/client.ts` | Return `{ client, isPremium }`, detect via `getMe()`, log speed limit events |
| `worker/src/util/mutex.ts` | Convert from single global boolean to per-key map; add `accountKey` param |
| `worker/src/worker.ts` | Two-phase write, hash lock, `maxUploadSize` from `isPremium`; update all `createTdlibClient` call sites |
| `worker/src/archive/split.ts` | Accept optional `maxPartSize` parameter in `byteLevelSplit` |
| `worker/src/scheduler.ts` | Replace sequential loop + `withTdlibMutex` with `Promise.allSettled`; update mutex call signatures |
| `worker/src/fetch-listener.ts` | Update 5 `withTdlibMutex` call sites to new signature |
| `worker/src/extract-listener.ts` | Update 1 `withTdlibMutex` call site to new signature |
| `worker/src/recovery.ts` | Update `createTdlibClient` call site to destructure |

---

## Task 1: Add `isPremium` to `TelegramAccount` schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: Prisma migration (via CLI)
- Modify: `worker/src/db/queries.ts`

- [ ] **Step 1: Add field to schema**

In `prisma/schema.prisma`, find `model TelegramAccount` and add `isPremium` after `authCode`:

```prisma
model TelegramAccount {
  id          String    @id @default(cuid())
  phone       String    @unique
  displayName String?
  isActive    Boolean   @default(true)
  authState   AuthState @default(PENDING)
  authCode    String?
  isPremium   Boolean   @default(false)
  lastSeenAt  DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  channelMaps     AccountChannelMap[]
  ingestionRuns   IngestionRun[]
  fetchRequests   ChannelFetchRequest[]
  skippedPackages SkippedPackage[]

  @@index([isActive])
  @@map("telegram_accounts")
}
```

- [ ] **Step 2: Generate migration**

```bash
npx prisma migrate dev --name add_is_premium_to_telegram_account
```

Expected output: `The following migration(s) have been created and applied ... add_is_premium_to_telegram_account`

- [ ] **Step 3: Add `updateAccountPremiumStatus` to `worker/src/db/queries.ts`**

Add after the `updateAccountAuthState` function:

```typescript
export async function updateAccountPremiumStatus(
  accountId: string,
  isPremium: boolean
): Promise<void> {
  await db.telegramAccount.update({
    where: { id: accountId },
    data: { isPremium },
  });
}
```

- [ ] **Step 4: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ worker/src/db/queries.ts
git commit -m "feat: add isPremium field to TelegramAccount"
```

---

## Task 2: Detect Premium status in `createTdlibClient`

**Files:**
- Modify: `worker/src/tdlib/client.ts`
- Modify: `worker/src/worker.ts` (two call sites)
- Modify: `worker/src/recovery.ts` (one call site)

- [ ] **Step 1: Update imports in `client.ts`**

```typescript
import {
  updateAccountAuthState,
  getAccountAuthCode,
  updateAccountPremiumStatus,
} from "../db/queries.js";
```

- [ ] **Step 2: Change return type of `createTdlibClient`**

```typescript
export async function createTdlibClient(
  account: AccountConfig
): Promise<{ client: Client; isPremium: boolean }> {
```

- [ ] **Step 3: Replace `return client` at the end of the try block**

Find `return client;` inside the try block and replace with:

```typescript
    await updateAccountAuthState(account.id, "AUTHENTICATED");
    log.info({ accountId: account.id }, "TDLib client authenticated");

    let isPremium = false;
    try {
      const me = await client.invoke({ _: "getMe" }) as { is_premium?: boolean };
      isPremium = me.is_premium ?? false;
      await updateAccountPremiumStatus(account.id, isPremium);
      log.info({ accountId: account.id, isPremium }, "Account Premium status detected");
    } catch (err) {
      log.warn({ err, accountId: account.id }, "Could not detect Premium status, defaulting to false");
    }

    client.on("update", (update: unknown) => {
      const u = update as { _?: string; is_upload?: boolean };
      if (u?._ === "updateSpeedLimitNotification") {
        log.warn(
          { accountId: account.id, isUpload: u.is_upload },
          u.is_upload
            ? "Upload speed limited by Telegram (account is not Premium)"
            : "Download speed limited by Telegram (account is not Premium)"
        );
      }
    });

    return { client, isPremium };
```

- [ ] **Step 4: Update `authenticateAccount` in `worker/src/worker.ts`**

Find the call in `authenticateAccount`:
```typescript
    client = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });
```

Change to:
```typescript
    client = (await createTdlibClient({
      id: account.id,
      phone: account.phone,
    })).client;
```

- [ ] **Step 5: Update `runWorkerForAccount` in `worker/src/worker.ts`**

Find the call in `runWorkerForAccount`:
```typescript
    const client = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });
```

Change to:
```typescript
    const { client, isPremium } = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });
```

(`isPremium` is used in Task 6.)

- [ ] **Step 6: Update `worker/src/recovery.ts`**

Find:
```typescript
  let client: Client | undefined;

  try {
    client = await createTdlibClient({ id: account.id, phone: account.phone });
```

Change to:
```typescript
  let client: Client | undefined;

  try {
    ({ client } = await createTdlibClient({ id: account.id, phone: account.phone }));
```

- [ ] **Step 7: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add worker/src/tdlib/client.ts worker/src/worker.ts worker/src/recovery.ts
git commit -m "feat: detect and persist Telegram Premium status after authentication"
```

---

## Task 3: Add hash advisory lock to `locks.ts`

**Files:**
- Modify: `worker/src/db/locks.ts`

The existing `tryAcquireLock` / `releaseLock` pattern (pool.connect → keep connection → release on unlock) is reused exactly. A `hash:` prefix on the lock key string prevents collision with account lock IDs in the 32-bit hash space.

- [ ] **Step 1: Add hash lock functions after `releaseLock`**

```typescript
/**
 * Derive a lock ID for a content hash. Prefixes with "hash:" so the resulting
 * 32-bit integer does not collide with account advisory lock IDs.
 */
function contentHashToLockId(contentHash: string): number {
  return hashToLockId(`hash:${contentHash}`);
}

/**
 * Acquire a per-content-hash advisory lock before uploading.
 * Prevents two concurrent workers from uploading the same archive
 * when both scan a shared source channel.
 *
 * Returns true if acquired (proceed with upload).
 * Returns false if already held (another worker is handling this archive — skip).
 *
 * MUST be released via releaseHashLock() after createPackageStub() completes,
 * including on all error paths (use try/finally).
 */
export async function tryAcquireHashLock(contentHash: string): Promise<boolean> {
  const lockId = contentHashToLockId(contentHash);
  const client = await pool.connect();
  try {
    const result = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1)",
      [lockId]
    );
    const acquired = result.rows[0]?.pg_try_advisory_lock ?? false;
    if (acquired) {
      heldConnections.set(`hash:${contentHash}`, client);
      log.debug({ hash: contentHash.slice(0, 16), lockId }, "Hash lock acquired");
      return true;
    } else {
      client.release();
      log.debug({ hash: contentHash.slice(0, 16), lockId }, "Hash lock held by another worker — skipping");
      return false;
    }
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Release the per-content-hash advisory lock.
 * Call after createPackageStub() completes (or on any error path).
 */
export async function releaseHashLock(contentHash: string): Promise<void> {
  const lockId = contentHashToLockId(contentHash);
  const client = heldConnections.get(`hash:${contentHash}`);
  if (!client) {
    log.warn({ hash: contentHash.slice(0, 16) }, "No held connection for hash lock release");
    return;
  }
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    log.debug({ hash: contentHash.slice(0, 16) }, "Hash lock released");
  } finally {
    heldConnections.delete(`hash:${contentHash}`);
    client.release();
  }
}
```

- [ ] **Step 2: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/db/locks.ts
git commit -m "feat: add per-content-hash advisory lock to prevent concurrent duplicate uploads"
```

---

## Task 4: Add `createPackageStub` and `updatePackageWithMetadata` to `queries.ts`

**Files:**
- Modify: `worker/src/db/queries.ts`

- [ ] **Step 1: Add `createPackageStub` after `getUploadedPackageByHash`**

```typescript
export interface CreatePackageStubInput {
  contentHash: string;
  fileName: string;
  fileSize: bigint;
  archiveType: ArchiveType;
  sourceChannelId: string;
  sourceMessageId: bigint;
  sourceTopicId?: bigint | null;
  destChannelId: string;
  destMessageId: bigint;
  destMessageIds: bigint[];
  isMultipart: boolean;
  partCount: number;
  ingestionRunId: string;
  creator?: string | null;
  tags?: string[];
}

/**
 * Write a minimal Package record immediately after Telegram confirms the upload.
 * Call this before preview/metadata extraction so recoverIncompleteUploads() can
 * detect and verify the package if the worker crashes mid-metadata.
 *
 * Follow with updatePackageWithMetadata() once file entries and preview are ready.
 */
export async function createPackageStub(
  input: CreatePackageStubInput
): Promise<{ id: string }> {
  const pkg = await db.package.create({
    data: {
      contentHash: input.contentHash,
      fileName: input.fileName,
      fileSize: input.fileSize,
      archiveType: input.archiveType,
      sourceChannelId: input.sourceChannelId,
      sourceMessageId: input.sourceMessageId,
      sourceTopicId: input.sourceTopicId ?? undefined,
      destChannelId: input.destChannelId,
      destMessageId: input.destMessageId,
      destMessageIds: input.destMessageIds,
      isMultipart: input.isMultipart,
      partCount: input.partCount,
      fileCount: 0,
      ingestionRunId: input.ingestionRunId,
      creator: input.creator ?? undefined,
      tags: input.tags?.length ? input.tags : undefined,
    },
    select: { id: true },
  });

  try {
    await db.$queryRawUnsafe(
      `SELECT pg_notify('new_package', $1)`,
      JSON.stringify({
        packageId: pkg.id,
        fileName: input.fileName,
        creator: input.creator ?? null,
        tags: input.tags ?? [],
      })
    );
  } catch {
    // Best-effort
  }

  return pkg;
}
```

- [ ] **Step 2: Add `updatePackageWithMetadata` after `createPackageStub`**

```typescript
/**
 * Update a stub Package with file entries and preview after metadata extraction.
 * Called as Phase 2 of the two-phase write after createPackageStub().
 */
export async function updatePackageWithMetadata(
  packageId: string,
  input: {
    files: {
      path: string;
      fileName: string;
      extension: string | null;
      compressedSize: bigint;
      uncompressedSize: bigint;
      crc32: string | null;
    }[];
    previewData?: Buffer | null;
    previewMsgId?: bigint | null;
  }
): Promise<void> {
  await db.package.update({
    where: { id: packageId },
    data: {
      fileCount: input.files.length,
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      previewMsgId: input.previewMsgId ?? undefined,
      files: {
        create: input.files,
      },
    },
  });
}
```

- [ ] **Step 3: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/db/queries.ts
git commit -m "feat: add createPackageStub and updatePackageWithMetadata for two-phase DB write"
```

---

## Task 5: Two-phase write + hash lock in `worker.ts`

**Files:**
- Modify: `worker/src/worker.ts`

This task rewires the upload + indexing section of `processOneArchiveSet`. No other function changes.

- [ ] **Step 1: Update imports from `./db/queries.js`**

Remove `createPackageWithFiles` and add the new functions:

```typescript
import {
  getSourceChannelMappings,
  getGlobalDestinationChannel,
  packageExistsByHash,
  packageExistsBySourceMessage,
  createPackageStub,
  updatePackageWithMetadata,
  createIngestionRun,
  completeIngestionRun,
  failIngestionRun,
  updateLastProcessedMessage,
  updateRunActivity,
  setChannelForum,
  getTopicProgress,
  upsertTopicProgress,
  upsertChannel,
  ensureAccountChannelLink,
  getGlobalSetting,
  getChannelFetchRequest,
  updateFetchRequestStatus,
  getAccountLinkedChannelIds,
  getExistingChannelsByTelegramId,
  getAccountById,
  deleteOrphanedPackageByHash,
  getUploadedPackageByHash,
  upsertSkippedPackage,
  deleteSkippedPackage,
} from "./db/queries.js";
```

- [ ] **Step 2: Update imports from `./db/locks.js`**

```typescript
import { tryAcquireLock, releaseLock, tryAcquireHashLock, releaseHashLock } from "./db/locks.js";
```

- [ ] **Step 3: Add `maxUploadSize` to `PipelineContext`**

Find the `PipelineContext` interface and add the field:

```typescript
interface PipelineContext {
  client: Client;
  runId: string;
  channelTitle: string;
  channel: TelegramChannel;
  destChannelTelegramId: bigint;
  destChannelId: string;
  throttled: ThrottledActivity;
  counters: RunCounters;
  topicCreator: string | null;
  sourceTopicId: bigint | null;
  accountLog: ReturnType<typeof childLogger>;
  accountId: string;
  maxUploadSize: bigint;
}
```

- [ ] **Step 4: Add hash lock + re-check after the `packageExistsByHash` skip block**

In `processOneArchiveSet`, find the end of the `packageExistsByHash` block (around line 979, just after `return null;`). Insert after it:

```typescript
    // ── Hash lock: prevent concurrent workers racing on shared-channel archives ──
    const hashLockAcquired = await tryAcquireHashLock(contentHash);
    if (!hashLockAcquired) {
      counters.zipsDuplicate++;
      accountLog.info(
        { fileName: archiveName, hash: contentHash.slice(0, 16) },
        "Hash lock held by another worker — skipping concurrent duplicate"
      );
      return null;
    }

    // Re-check after acquiring lock: another worker may have finished between
    // the first check above and this point.
    const existsAfterLock = await packageExistsByHash(contentHash);
    if (existsAfterLock) {
      await releaseHashLock(contentHash);
      counters.zipsDuplicate++;
      accountLog.debug(
        { fileName: archiveName, hash: contentHash.slice(0, 16) },
        "Duplicate detected after acquiring hash lock — skipping"
      );
      return null;
    }
```

- [ ] **Step 5: Wrap upload + stub creation in try/finally to guarantee lock release**

Find the `// ── Uploading ──` comment. Wrap everything from that comment through the end of the indexing section (the `deleteSkippedPackage` call) in a `try/finally`:

```typescript
    let stub: { id: string } | null = null;
    try {
      // ── Uploading ──
      const existingUpload = await getUploadedPackageByHash(contentHash);
      let destResult: { messageId: bigint; messageIds: bigint[] };

      if (existingUpload && existingUpload.destMessageId) {
        accountLog.info(
          { fileName: archiveName, destMessageId: Number(existingUpload.destMessageId) },
          "Reusing existing upload (file already on destination channel)"
        );
        destResult = {
          messageId: existingUpload.destMessageId,
          messageIds: existingUpload.destMessageIds?.length
            ? (existingUpload.destMessageIds as bigint[])
            : [existingUpload.destMessageId],
        };
      } else {
        const uploadLabel = uploadPaths.length > 1 ? ` (${uploadPaths.length} parts)` : "";
        await updateRunActivity(runId, {
          currentActivity: `Uploading ${archiveName} to archive channel${uploadLabel}`,
          currentStep: "uploading",
          currentChannel: channelTitle,
          currentFile: archiveName,
          currentFileNum: setIdx + 1,
          totalFiles: totalSets,
        });
        destResult = await uploadToChannel(client, destChannelTelegramId, uploadPaths);
      }

      // ── Post-upload integrity check ── (keep existing code as-is)
      // ...

      // ── Phase 1: Stub record — persisted before preview/metadata ──
      await deleteOrphanedPackageByHash(contentHash);

      const creator =
        topicCreator ??
        extractCreatorFromFileName(archiveName) ??
        extractCreatorFromChannelTitle(channelTitle) ??
        null;

      const tags: string[] = [];
      if (channel.category) {
        tags.push(channel.category);
      }

      stub = await createPackageStub({
        contentHash,
        fileName: archiveName,
        fileSize: totalSize,
        archiveType: archiveSet.type === "7Z" ? "SEVEN_Z" : archiveSet.type,
        sourceChannelId: channel.id,
        sourceMessageId: archiveSet.parts[0].id,
        sourceTopicId,
        destChannelId,
        destMessageId: destResult.messageId,
        destMessageIds: destResult.messageIds,
        isMultipart: archiveSet.parts.length > 1 || uploadPaths.length > 1,
        partCount: uploadPaths.length,
        ingestionRunId,
        creator,
        tags,
      });

      counters.zipsIngested++;
      await deleteSkippedPackage(channel.id, archiveSet.parts[0].id);
    } finally {
      await releaseHashLock(contentHash);
    }

    if (!stub) return null;
```

- [ ] **Step 6: Replace `createPackageWithFiles` call with `updatePackageWithMetadata`**

Find the old `createPackageWithFiles` call (and surrounding `updateRunActivity` + `accountLog.info`). Replace with:

```typescript
    await updateRunActivity(runId, {
      currentActivity: `Saving metadata for ${archiveName} (${entries.length} files)`,
      currentStep: "indexing",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    await updatePackageWithMetadata(stub.id, {
      files: entries,
      previewData,
      previewMsgId,
    });

    await updateRunActivity(runId, {
      currentActivity: `Ingested ${archiveName} (${entries.length} files indexed)`,
      currentStep: "complete",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
      zipsIngested: counters.zipsIngested,
    });

    accountLog.info(
      { fileName: archiveName, contentHash, fileCount: entries.length, creator: stub.creator ?? null },
      "Archive ingested"
    );

    return stub.id;
```

Note: Remove the old `const tags = []`, `deleteOrphanedPackageByHash`, and `deleteSkippedPackage` calls from after the preview section — they now live inside the `try/finally` above.

- [ ] **Step 7: Remove `creator` and `tags` derivation from after the preview section**

The old code derived `creator` and `tags` between the preview section and `createPackageWithFiles`. Since they now live in the stub creation (Step 5), remove those lines from the old location.

- [ ] **Step 8: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no TypeScript errors.

Manual check: run the worker (`cd worker && npm run dev`), process a test archive, and confirm:
1. Logs show `"Hash lock acquired"` and `"Hash lock released"` around each upload
2. Package is created in DB immediately after upload (check via Prisma Studio — `fileCount` will be 0 briefly, then updated)
3. No double messages appear in the destination Telegram channel

- [ ] **Step 9: Commit**

```bash
git add worker/src/worker.ts
git commit -m "feat: add two-phase DB write and hash advisory lock to prevent double-uploads"
```

---

## Task 6: Per-account upload size limit via `isPremium`

**Files:**
- Modify: `worker/src/archive/split.ts`
- Modify: `worker/src/worker.ts`

- [ ] **Step 1: Add optional `maxPartSize` parameter to `byteLevelSplit`**

In `worker/src/archive/split.ts`, change the signature of `byteLevelSplit`:

```typescript
export async function byteLevelSplit(
  filePath: string,
  maxPartSize?: bigint
): Promise<string[]> {
  const effectiveMax = maxPartSize ?? MAX_PART_SIZE;
  const stats = await stat(filePath);
  const fileSize = BigInt(stats.size);

  if (fileSize <= effectiveMax) {
    return [filePath];
  }

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const partSize = Number(effectiveMax);
  const totalParts = Math.ceil(Number(fileSize) / partSize);
  const parts: string[] = [];

  log.info({ filePath, fileSize: Number(fileSize), totalParts }, "Splitting file");

  for (let i = 0; i < totalParts; i++) {
    const partNum = String(i + 1).padStart(3, "0");
    const partPath = path.join(dir, `${baseName}.${partNum}`);
    const start = i * partSize;
    const end = Math.min(start + partSize - 1, Number(fileSize) - 1);

    await pipeline(
      createReadStream(filePath, { start, end }),
      createWriteStream(partPath)
    );

    parts.push(partPath);
  }

  log.info({ filePath, parts: parts.length }, "File split complete");
  return parts;
}
```

- [ ] **Step 2: Set `maxUploadSize` in `runWorkerForAccount` from `isPremium`**

In `worker/src/worker.ts`, in `runWorkerForAccount`, add after `const { client, isPremium } = await createTdlibClient(...)`:

```typescript
    const maxUploadSize = isPremium
      ? 3950n * 1024n * 1024n
      : BigInt(config.maxPartSizeMB) * 1024n * 1024n;
```

Then include `maxUploadSize` in the `PipelineContext` object passed to `processOneArchiveSet` calls.

- [ ] **Step 3: Use `ctx.maxUploadSize` in `processOneArchiveSet`**

Find:
```typescript
    const MAX_UPLOAD_SIZE = BigInt(config.maxPartSizeMB) * 1024n * 1024n;
```

Replace with:
```typescript
    const MAX_UPLOAD_SIZE = ctx.maxUploadSize;
```

- [ ] **Step 4: Pass `maxUploadSize` to `byteLevelSplit` calls**

Find the two `byteLevelSplit` calls in `processOneArchiveSet`:

```typescript
      splitPaths = await byteLevelSplit(concatPath);
```
and
```typescript
      splitPaths = await byteLevelSplit(tempPaths[0]);
```

Change both to pass the upload size:

```typescript
      splitPaths = await byteLevelSplit(concatPath, ctx.maxUploadSize);
```
and
```typescript
      splitPaths = await byteLevelSplit(tempPaths[0], ctx.maxUploadSize);
```

- [ ] **Step 5: Verify**

```bash
cd worker && npx tsc --noEmit
```

Manual check: confirm that a freshly authenticated Premium account logs `isPremium: true` and that the worker logs show `"Account Premium status detected" isPremium=true`. The non-Premium account should log `isPremium: false`. Repack/split will only trigger for Premium if a file part exceeds 3.95 GB.

- [ ] **Step 6: Commit**

```bash
git add worker/src/archive/split.ts worker/src/worker.ts
git commit -m "feat: apply per-account Premium 4GB upload limit to bypass repacking"
```

---

## Task 7: Per-key mutex and parallel account scheduler

**Files:**
- Modify: `worker/src/util/mutex.ts`
- Modify: `worker/src/scheduler.ts`
- Modify: `worker/src/fetch-listener.ts`
- Modify: `worker/src/extract-listener.ts`

**Why per-key:** The global boolean mutex serializes ALL TDLib operations across ALL accounts. Replacing it with a per-key map allows Account A and Account B to run their TDLib clients concurrently (different keys) while still preventing concurrent use of the SAME account's TDLib state dir (same key).

- [ ] **Step 1: Rewrite `worker/src/util/mutex.ts`**

Replace the entire file:

```typescript
import { childLogger } from "./logger.js";

const log = childLogger("mutex");

const MUTEX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const locks = new Map<string, boolean>();
const holders = new Map<string, string>();
const queues = new Map<
  string,
  Array<{ resolve: () => void; reject: (err: Error) => void; label: string }>
>();

/**
 * Ensures only one TDLib operation runs at a time FOR THE SAME KEY.
 * Different keys run concurrently — this allows two accounts to ingest in parallel
 * while still preventing concurrent use of the same account's TDLib state dir.
 *
 * key:   the account phone number for account-specific ops (auth, ingest),
 *        or 'global' for ops that don't belong to a specific account.
 * label: human-readable name for logging.
 */
export async function withTdlibMutex<T>(
  key: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (locks.get(key)) {
    log.info({ waiting: label, key, holder: holders.get(key) }, "Waiting for TDLib mutex");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const q = queues.get(key) ?? [];
        const idx = q.indexOf(entry);
        if (idx !== -1) {
          q.splice(idx, 1);
          reject(
            new Error(
              `TDLib mutex wait timeout after ${MUTEX_WAIT_TIMEOUT_MS / 60_000}min ` +
                `(waiting: ${label}, key: ${key}, holder: ${holders.get(key)})`
            )
          );
        }
      }, MUTEX_WAIT_TIMEOUT_MS);

      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
        label,
      };

      if (!queues.has(key)) queues.set(key, []);
      queues.get(key)!.push(entry);
    });
  }

  locks.set(key, true);
  holders.set(key, label);
  log.debug({ key, label }, "TDLib mutex acquired");

  try {
    return await fn();
  } finally {
    locks.delete(key);
    holders.delete(key);
    const next = queues.get(key)?.shift();
    if (next) {
      log.debug({ key, next: next.label }, "TDLib mutex releasing to next waiter");
      next.resolve();
    } else {
      queues.delete(key);
      log.debug({ key, label }, "TDLib mutex released");
    }
  }
}
```

- [ ] **Step 2: Update `withTdlibMutex` calls in `worker/src/scheduler.ts`**

Auth loop — add `account.phone` as key:
```typescript
        await withTdlibMutex(account.phone, `auth:${account.phone}`, () =>
          authenticateAccount(account)
        );
```

Ingest loop — change to `Promise.allSettled` and add key:
```typescript
    await Promise.allSettled(
      accounts.map((account) =>
        withTdlibMutex(account.phone, `ingest:${account.phone}`, () =>
          runWorkerForAccount(account)
        )
      )
    );
```

Also remove the cycle timeout check from the account loop — all accounts start simultaneously so there's nothing to gate. The `cycleStart` / `CYCLE_TIMEOUT_MS` logic in the auth loop can stay as-is.

- [ ] **Step 3: Update `withTdlibMutex` calls in `worker/src/fetch-listener.ts`**

All 5 calls use global operations (no specific account phone). Add `'global'` as the first argument to each:

```typescript
// fetch-channels
await withTdlibMutex("global", "fetch-channels", () => ...);

// generate-invite
await withTdlibMutex("global", "generate-invite", async () => { ... });

// create-destination
await withTdlibMutex("global", "create-destination", async () => { ... });

// join-channel
await withTdlibMutex("global", "join-channel", async () => { ... });

// rebuild-packages
await withTdlibMutex("global", "rebuild-packages", () => ...);
```

- [ ] **Step 4: Update `withTdlibMutex` call in `worker/src/extract-listener.ts`**

```typescript
await withTdlibMutex("global", "extract", async () => { ... });
```

- [ ] **Step 5: Verify**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Manual smoke test**

Start the worker with two active accounts:
```bash
cd worker && npm run dev
```

Confirm in logs:
1. Both accounts start ingestion at approximately the same time (timestamps within a second of each other)
2. Each account logs its own `"TDLib mutex acquired"` with its phone number as key
3. `"Ingestion cycle complete"` appears after both accounts finish (not just the first)
4. No `"Waiting for TDLib mutex"` between accounts (they don't block each other)

- [ ] **Step 7: Commit**

```bash
git add worker/src/util/mutex.ts worker/src/scheduler.ts worker/src/fetch-listener.ts worker/src/extract-listener.ts
git commit -m "feat: parallel account ingestion via per-key TDLib mutex"
```

---

## Self-Review Checklist

- [x] **Spec § Double-upload fix (crash):** Covered by Task 5 two-phase write — stub written immediately after `uploadToChannel()` returns.
- [x] **Spec § Double-upload fix (race):** Covered by Task 3 hash lock + Task 5 lock acquisition + re-check before upload.
- [x] **Spec § Re-check after lock acquisition:** Explicitly in Task 5 Step 4 — `existsAfterLock` check after acquiring lock.
- [x] **Spec § Parallel accounts:** Covered by Task 7 per-key mutex + `Promise.allSettled`.
- [x] **Spec § Premium 4GB limit:** Covered by Tasks 1–2 (detection) + Task 6 (application).
- [x] **Spec § Premium effectively eliminates repacking:** `MAX_UPLOAD_SIZE = 3,950 MB` → `hasOversizedPart` never true for normal archives.
- [x] **Spec § Speed limit notification:** Logged at warn level in Task 2 Step 3.
- [x] **Spec § No Docker changes needed:** Confirmed — single container, per-key mutex handles parallelism.
- [x] **`destMessageIds` field:** Included in `createPackageStub` input (Task 4 + Task 5).
- [x] **`deleteSkippedPackage` call:** Moved into `try/finally` block in Task 5 Step 5.
- [x] **`createPackageWithFiles` preserved:** Not deleted from `queries.ts` — kept for any future use.
