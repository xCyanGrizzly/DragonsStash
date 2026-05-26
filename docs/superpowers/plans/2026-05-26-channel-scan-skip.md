# Channel-Scan Skip Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DB-persistent "skip if recently scanned and idle" guards so the worker stops re-scanning unchanged forum topics and channels every cycle, especially on restart. For the Model Printing Emporium channel (1,086 forum topics), drops per-cycle `searchChatMessages` calls from ~1,086 to ~50.

**Architecture:** Six new persisted columns (`lastScannedAt`, `lastScanFoundArchives`, `consecutiveEmptyScans`) on both `AccountChannelMap` (for non-forum channels) and `TopicProgress` (for forum topics). Three config knobs. A top-of-loop skip decision tree that checks recency, backoff, and pending failures before any TDLib call. After the existing `SkippedPackage` retry pass runs, a cheap `getChat` / `getForumTopicInfo` call short-circuits the paginated `searchChatMessages` when the channel/topic has nothing new server-side. The existing failure-retry semantics (`d99a506` watermark cap + `901f32f` retry pass) are preserved untouched — a channel sitting on retryable `SkippedPackage` rows is never skipped.

**Tech Stack:** TypeScript 5.9, Prisma 7.4 with PostgreSQL, TDLib via `tdl` 8.1.0, `prebuilt-tdlib` 1.8.64. No test framework — verification is manual via Docker logs.

---

## Spec reference

This plan implements [docs/superpowers/specs/2026-05-26-channel-scan-skip-design.md](../specs/2026-05-26-channel-scan-skip-design.md). Read that for the rationale, edge-case analysis, and risk register.

---

## File structure

Files modified — no new source files created:

- [prisma/schema.prisma](../../prisma/schema.prisma) — add 3 columns to each of `AccountChannelMap` and `TopicProgress`
- `prisma/migrations/20260526000000_channel_scan_state/migration.sql` — NEW migration file
- [worker/src/util/config.ts](../../worker/src/util/config.ts) — add 3 env vars
- [worker/src/db/queries.ts](../../worker/src/db/queries.ts) — add 2 helper functions
- [worker/src/tdlib/chats.ts](../../worker/src/tdlib/chats.ts) — add 2 helper functions for last-message lookup
- [worker/src/worker.ts](../../worker/src/worker.ts) — wire skip checks + `getChat` short-circuit into both forum and non-forum branches; update end-of-scan bookkeeping

The change is logically one feature but split into 6 tasks so each commit stays small and reviewable.

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (the `AccountChannelMap` and `TopicProgress` models)
- Create: `prisma/migrations/20260526000000_channel_scan_state/migration.sql`

- [ ] **Step 1: Add the three columns to `AccountChannelMap`**

Open `prisma/schema.prisma` and find the `model AccountChannelMap` block. Replace the existing model with:

```prisma
model AccountChannelMap {
  id                     String      @id @default(cuid())
  accountId              String
  channelId              String
  role                   ChannelRole @default(READER)
  lastProcessedMessageId BigInt?
  /// When this channel was last scanned (any reason, including skipped scans
  /// that bumped the timestamp). Used by the recency-skip guard.
  lastScannedAt          DateTime?
  /// True if the last scan found archives OR left retryable SkippedPackages
  /// pending. Tracks "this channel has work I might need to revisit" — not
  /// just "I uploaded something this cycle".
  lastScanFoundArchives  Boolean     @default(false)
  /// Number of consecutive cycles where this channel was trulyIdle (no
  /// archives, no failures, no retryables). Drives the backoff that lets
  /// cold channels skip cycles entirely.
  consecutiveEmptyScans  Int         @default(0)
  createdAt              DateTime    @default(now())

  account        TelegramAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  channel        TelegramChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  topicProgress  TopicProgress[]

  @@unique([accountId, channelId])
  @@index([accountId])
  @@index([channelId])
  @@map("account_channel_map")
}
```

- [ ] **Step 2: Add the same three columns to `TopicProgress`**

Find the `model TopicProgress` block and replace it with:

```prisma
model TopicProgress {
  id                     String  @id @default(cuid())
  accountChannelMapId    String
  topicId                BigInt
  topicName              String?
  lastProcessedMessageId BigInt?
  /// When this topic was last scanned (any reason). Used by recency-skip.
  lastScannedAt          DateTime?
  /// True if the last scan found archives OR has retryable SkippedPackages
  /// pending for this topic. See AccountChannelMap doc for details.
  lastScanFoundArchives  Boolean   @default(false)
  /// Number of consecutive cycles where this topic was trulyIdle. Drives
  /// backoff for cold topics.
  consecutiveEmptyScans  Int       @default(0)

  accountChannelMap AccountChannelMap @relation(fields: [accountChannelMapId], references: [id], onDelete: Cascade)

  @@unique([accountChannelMapId, topicId])
  @@index([accountChannelMapId])
  @@map("topic_progress")
}
```

- [ ] **Step 3: Create the migration file**

Create the directory and SQL file:

```bash
mkdir -p prisma/migrations/20260526000000_channel_scan_state
```

Create `prisma/migrations/20260526000000_channel_scan_state/migration.sql` with this content:

```sql
-- AlterTable: per-channel scan-state columns
ALTER TABLE "account_channel_map"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: per-topic scan-state columns (forum channels)
ALTER TABLE "topic_progress"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;
```

The defaults make this a metadata-only change in PostgreSQL — no table rewrite, runs in milliseconds even on production-size data.

- [ ] **Step 4: Regenerate the Prisma client and type-check**

Run from the project root (uses Docker because we don't have Node locally):

```bash
docker run --rm -v "$PWD:/work" -w /work node:20-bookworm-slim sh -c "npx prisma generate 2>&1 | tail -3 && cd worker && npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: `✔ Generated Prisma Client (v7.4.0) ...` and zero TypeScript errors. If you see "npm install" missing, run `npm install` in /work and /work/worker first.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260526000000_channel_scan_state/
git commit -m "$(cat <<'EOF'
feat(db): add scan-state columns to AccountChannelMap + TopicProgress

Three new fields on each table:
  - lastScannedAt          — when the worker last touched this scope
  - lastScanFoundArchives  — true if last scan had archives OR pending
                             retryables; tracks "work might need revisit"
  - consecutiveEmptyScans  — counter for cold-channel backoff

Schema change only. Worker logic in follow-up commits. Migration is a
metadata-only ALTER (NOT NULL with default) so it runs in ms even on
21k+ Package rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Config knobs

**Files:**
- Modify: `worker/src/util/config.ts`

- [ ] **Step 1: Add the three config fields**

Open `worker/src/util/config.ts`. Inside the `config` object literal, after the existing `maxSkipAttempts` line, add:

```typescript
  /** Window in which a recent successful empty scan lets us skip the next
   *  scan entirely. Default 5 minutes. */
  skipRecentScanWindowMs: parseInt(
    process.env.WORKER_SKIP_RECENT_SCAN_WINDOW_MS ?? "300000",
    10
  ),
  /** After this many consecutive empty scans, a channel/topic enters
   *  backoff and is only scanned every Nth cycle. */
  emptyScanBackoffThreshold: parseInt(
    process.env.WORKER_EMPTY_SCAN_BACKOFF_THRESHOLD ?? "5",
    10
  ),
  /** While in backoff, scan only every Nth cycle. Default 5 = scan every
   *  fifth cycle = once every ~5 hours given the 60-min default interval. */
  emptyScanBackoffEveryNth: parseInt(
    process.env.WORKER_EMPTY_SCAN_BACKOFF_EVERY_NTH ?? "5",
    10
  ),
```

The file's existing `as const` at the end of the object remains unchanged.

- [ ] **Step 2: Type-check**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/util/config.ts
git commit -m "$(cat <<'EOF'
feat(config): add three scan-skip tuning env vars

  WORKER_SKIP_RECENT_SCAN_WINDOW_MS    (default 300000 = 5 min)
  WORKER_EMPTY_SCAN_BACKOFF_THRESHOLD  (default 5 cycles)
  WORKER_EMPTY_SCAN_BACKOFF_EVERY_NTH  (default 5)

All optional with safe defaults. Not yet read by any code — the worker
integration lands in follow-up commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: DB helpers for atomic scan-state writes

**Files:**
- Modify: `worker/src/db/queries.ts`

These helpers wrap the existing watermark writes so callers update all four fields (watermark + 3 new fields) in one Prisma call. That keeps the data consistent and gives us one place to compute `consecutiveEmptyScans`.

- [ ] **Step 1: Add `upsertChannelScanState` and `upsertTopicScanState`**

Open `worker/src/db/queries.ts`. Find the existing `updateLastProcessedMessage` function. Right BELOW it, add:

```typescript
export interface ScanStateUpdate {
  /** New watermark to persist. Use the same value the caller would have
   *  passed to updateLastProcessedMessage / upsertTopicProgress. */
  lastProcessedMessageId: bigint | null;
  /** True if the scan found archives OR has retryable SkippedPackages
   *  pending. The caller computes this via the trulyIdle formula. */
  lastScanFoundArchives: boolean;
  /** Pre-incremented value of consecutiveEmptyScans. Caller passes:
   *    trulyIdle ? prev + 1 : 0
   *  We do the arithmetic outside the helper so the helper stays a pure
   *  setter — easier to reason about. */
  consecutiveEmptyScans: number;
}

/**
 * Atomically update an AccountChannelMap's watermark and scan-state fields.
 * Replaces the older updateLastProcessedMessage for the post-scan write.
 * Sets lastScannedAt = NOW() server-side.
 */
export async function upsertChannelScanState(
  mappingId: string,
  update: ScanStateUpdate
) {
  return db.accountChannelMap.update({
    where: { id: mappingId },
    data: {
      lastProcessedMessageId: update.lastProcessedMessageId ?? undefined,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
  });
}

/**
 * Atomically upsert a TopicProgress row with the new watermark + scan-state
 * fields. Same semantics as upsertChannelScanState but for forum topics.
 */
export async function upsertTopicScanState(
  accountChannelMapId: string,
  topicId: bigint,
  topicName: string | null,
  update: ScanStateUpdate
) {
  return db.topicProgress.upsert({
    where: {
      accountChannelMapId_topicId: { accountChannelMapId, topicId },
    },
    create: {
      accountChannelMapId,
      topicId,
      topicName,
      lastProcessedMessageId: update.lastProcessedMessageId,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
    update: {
      topicName,
      lastProcessedMessageId: update.lastProcessedMessageId ?? undefined,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
  });
}
```

- [ ] **Step 2: Type-check**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: zero errors. The new functions reference `db.accountChannelMap` and `db.topicProgress` which Prisma generated from the schema in Task 1, so the regen from Step 1.4 must have run.

- [ ] **Step 3: Commit**

```bash
git add worker/src/db/queries.ts
git commit -m "$(cat <<'EOF'
feat(db): add upsertChannelScanState / upsertTopicScanState helpers

Wraps the existing watermark write with the three new scan-state
columns from Task 1. Single transaction, sets lastScannedAt=NOW()
server-side. Caller is responsible for computing the trulyIdle bool
and the new consecutiveEmptyScans value (pre-increment vs reset).

Existing updateLastProcessedMessage / upsertTopicProgress are kept
for callers that don't need the new fields (the SkippedPackage retry
pass, which only adjusts the watermark).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TDLib `getChat` / `getForumTopicInfo` helpers

**Files:**
- Modify: `worker/src/tdlib/chats.ts`

These helpers read the channel's (or topic's) server-side last-message-id from TDLib's local cache. Cheap when the chat has already been loaded — which we already do via `loadChats` at the top of `runWorkerForAccount`.

- [ ] **Step 1: Add `getChannelLastMessageId` and `getForumTopicLastMessageId`**

Open `worker/src/tdlib/chats.ts`. Append at the bottom of the file (after the existing exports):

```typescript
/**
 * Return the chat's server-side last_message.id from TDLib's local cache.
 * Used by the channel-scan-skip guard to short-circuit a paginated
 * searchChatMessages when nothing has changed since our watermark.
 *
 * Returns null when the chat has no last_message (empty channel) or the
 * call fails — callers must treat null as "unknown" and run the scan.
 */
export async function getChannelLastMessageId(
  client: Client,
  chatId: bigint
): Promise<bigint | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chat = (await client.invoke({
      _: "getChat",
      chat_id: Number(chatId),
    })) as { last_message?: { id?: number } };
    const id = chat.last_message?.id;
    return id ? BigInt(id) : null;
  } catch (err) {
    log.debug({ err, chatId: chatId.toString() }, "getChannelLastMessageId failed");
    return null;
  }
}

/**
 * Return the forum topic's last_message_id from TDLib. Same purpose as
 * getChannelLastMessageId but scoped to a single topic in a forum
 * supergroup. TDLib's `getForumTopic` returns a `forumTopic` whose `info`
 * field contains the last_message_id.
 *
 * Returns null on failure or empty topic — caller treats as "unknown".
 */
export async function getForumTopicLastMessageId(
  client: Client,
  chatId: bigint,
  topicId: bigint
): Promise<bigint | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topic = (await client.invoke({
      _: "getForumTopic",
      chat_id: Number(chatId),
      message_thread_id: Number(topicId),
    })) as { last_message?: { id?: number }; info?: { last_message_id?: number } };
    const id = topic.last_message?.id ?? topic.info?.last_message_id;
    return id ? BigInt(id) : null;
  } catch (err) {
    log.debug(
      { err, chatId: chatId.toString(), topicId: topicId.toString() },
      "getForumTopicLastMessageId failed"
    );
    return null;
  }
}
```

Note the file already imports `Client` from `tdl` and has a `log` defined at the top — both will be reused.

- [ ] **Step 2: Type-check**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/tdlib/chats.ts
git commit -m "$(cat <<'EOF'
feat(tdlib): add getChannelLastMessageId / getForumTopicLastMessageId

Both read the server-side last message ID from TDLib's local cache.
Used by the channel-scan-skip guard to short-circuit a paginated
searchChatMessages when last_message.id <= our watermark.

Returns null on any failure so the caller can fall back to scanning —
we'd rather waste a scan than miss new content.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire the skip + short-circuit into the non-forum branch

**Files:**
- Modify: `worker/src/worker.ts` (the non-forum channel branch of `runWorkerForAccount`)

This task touches just the non-forum branch. The forum branch is Task 6 — same logic, different scope. Splitting them keeps the diff small.

- [ ] **Step 1: Update imports**

Open `worker/src/worker.ts`. Find the import block from `./db/queries.js` (around line 10) and add `upsertChannelScanState` to the list. Find the import from `./tdlib/chats.js` (around line 36) and add `getChannelLastMessageId`. The resulting imports look like:

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
  getCappedSkippedMessageIds,
  findRepostedPackage,
  findPackageByRemoteUniqueId,
  getRetryableSkippedMessageIds,
  updatePackageTopicContext,
  upsertChannelScanState,
} from "./db/queries.js";
```

And:

```typescript
import { getAccountChats, joinChatByInviteLink, getChannelLastMessageId } from "./tdlib/chats.js";
```

- [ ] **Step 2: Expose `cycleCount` from the scheduler**

The skip logic needs to know which cycle this is for the backoff "every Nth" check. Open `worker/src/scheduler.ts` and find the `let cycleCount = 0;` declaration near the top. Above the `async function runCycle()` declaration, add an exporter:

```typescript
/** Read-only access to the current cycle counter for code that needs to
 *  apply per-cycle modulo logic (e.g. the cold-channel backoff). */
export function getCurrentCycle(): number {
  return cycleCount;
}
```

- [ ] **Step 3: Import `getCurrentCycle` in worker.ts**

In `worker/src/worker.ts`, just below the existing `import { ... } from "./scheduler.js";` line (or add a new import if none exists), make sure `getCurrentCycle` is imported. If there's no scheduler import yet, add:

```typescript
import { getCurrentCycle } from "./scheduler.js";
```

- [ ] **Step 4: Add the skip decision at the top of the non-forum branch**

Find the non-forum branch inside `runWorkerForAccount`. It starts with the comment `// ── Non-forum channel: flat scan (existing behavior) ──` (around line 706 after recent commits). Immediately AFTER the `else {` line and BEFORE the existing `await updateRunActivity(...)` "Scanning ..." call, insert the skip guard:

```typescript
        } else {
          // ── Channel-scan-skip guard ──
          // Before any TDLib call, decide whether this channel can be
          // skipped entirely this cycle. Three signals (in order):
          //   1. retryable SkippedPackages exist → MUST scan
          //   2. lastScannedAt within window AND last scan was idle → skip
          //   3. in backoff AND not the Nth cycle → skip
          // See docs/superpowers/specs/2026-05-26-channel-scan-skip-design.md
          try {
            const retryable = await getRetryableSkippedMessageIds({
              accountId: account.id,
              sourceChannelId: channel.id,
              topicId: null,
              cap: config.maxSkipAttempts,
            });
            if (retryable.length === 0 && mapping.lastScannedAt) {
              const sinceLastScanMs = Date.now() - mapping.lastScannedAt.getTime();
              const withinRecencyWindow = sinceLastScanMs < config.skipRecentScanWindowMs;
              const inBackoff = mapping.consecutiveEmptyScans >= config.emptyScanBackoffThreshold;
              const backoffSkipsThisCycle =
                inBackoff && getCurrentCycle() % config.emptyScanBackoffEveryNth !== 0;

              if (
                (withinRecencyWindow && !mapping.lastScanFoundArchives) ||
                backoffSkipsThisCycle
              ) {
                accountLog.debug(
                  {
                    channel: channel.title,
                    sinceLastScanMs,
                    consecutiveEmptyScans: mapping.consecutiveEmptyScans,
                    reason: withinRecencyWindow ? "recent-idle" : "backoff",
                  },
                  "Skipping channel — recently scanned and idle, or in backoff"
                );
                continue;
              }
            }
          } catch (skipErr) {
            // Skip guard is best-effort. If the retryable query fails,
            // fall through and do the normal scan.
            accountLog.warn(
              { err: skipErr, channel: channel.title },
              "Skip guard failed, proceeding with scan"
            );
          }

          // ── Non-forum channel: flat scan (existing behavior) ──
          await updateRunActivity(activeRunId, {
```

- [ ] **Step 5: Add the `getChat` short-circuit after the retry pass**

In the same non-forum branch, find where the existing retry pass writes back the watermark (look for the comment `// Pull the watermark back below the lowest still-retryable SkippedPackage`). After the retry pass completes — the spot where `effectiveChannelWatermark` is set — and BEFORE the `const scanResult = await getChannelMessages(...)` call, insert:

```typescript
          // ── getChat short-circuit ──
          // After the retry pass has settled the effective watermark, ask
          // TDLib for the channel's last_message.id. If it's <= our watermark,
          // no new content exists since last cycle — skip the paginated
          // searchChatMessages entirely. Still update scan-state so the
          // recent-scan skip can kick in next cycle.
          const channelLastId = await getChannelLastMessageId(client, channel.telegramId);
          if (
            channelLastId !== null
            && effectiveChannelWatermark !== null
            && channelLastId <= effectiveChannelWatermark
          ) {
            accountLog.info(
              {
                channel: channel.title,
                channelLastId: channelLastId.toString(),
                watermark: effectiveChannelWatermark.toString(),
              },
              "Channel caught up via getChat — skipping searchChatMessages"
            );
            await upsertChannelScanState(mapping.id, {
              lastProcessedMessageId: effectiveChannelWatermark,
              lastScanFoundArchives: false,
              consecutiveEmptyScans: (mapping.consecutiveEmptyScans ?? 0) + 1,
            });
            continue;
          }
```

- [ ] **Step 6: Replace the end-of-scan watermark write with the new helper**

In the same non-forum branch, find the existing end-of-scan watermark write. It looks like:

```typescript
          if (channelWatermark !== null) {
            await updateLastProcessedMessage(mapping.id, channelWatermark);
          }
```

Replace it with the new helper, computing the `trulyIdle` value first:

```typescript
          // ── Persist scan state ──
          // trulyIdle: nothing new this scan AND nothing failed AND no
          // retryable SkippedPackages pending. The retryable check matters —
          // a chronically-failing archive should NEVER let the channel back
          // off, even though zipsFound stays at 0 for it.
          const retryablePendingNow = await getRetryableSkippedMessageIds({
            accountId: account.id,
            sourceChannelId: channel.id,
            topicId: null,
            cap: config.maxSkipAttempts,
          });
          const trulyIdle =
            scanResult.archives.length === 0
            && minFailedId === null
            && retryablePendingNow.length === 0;
          const newConsecutive = trulyIdle
            ? (mapping.consecutiveEmptyScans ?? 0) + 1
            : 0;
          if (channelWatermark !== null) {
            await upsertChannelScanState(mapping.id, {
              lastProcessedMessageId: channelWatermark,
              lastScanFoundArchives: !trulyIdle,
              consecutiveEmptyScans: newConsecutive,
            });
          }
```

- [ ] **Step 7: Type-check**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: zero errors. If TS complains that `mapping.lastScannedAt` doesn't exist, the Prisma client regen from Task 1 didn't take effect — re-run `npx prisma generate`.

- [ ] **Step 8: Commit**

```bash
git add worker/src/worker.ts worker/src/scheduler.ts
git commit -m "$(cat <<'EOF'
feat(worker): non-forum channel-scan-skip + getChat short-circuit

For non-forum channels in runWorkerForAccount, three guards:

  1. Top-of-loop recency/backoff skip — if recently scanned with no
     pending work, or in backoff and not its turn, skip entirely.
     Bypassed when retryable SkippedPackages exist.

  2. After the SkippedPackage retry pass, a getChat short-circuit —
     if TDLib's local cache says the channel's last_message.id <= our
     effective watermark, skip the paginated searchChatMessages.

  3. End-of-scan persists lastScannedAt + lastScanFoundArchives +
     consecutiveEmptyScans via the new upsertChannelScanState helper.
     trulyIdle requires: no archives, no failures, no retryable pending.

Forum-topic branch lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire the skip + short-circuit into the forum-topic branch

**Files:**
- Modify: `worker/src/worker.ts` (the forum branch of `runWorkerForAccount`)

Same logic as Task 5, scoped to forum topics. The forum branch loops over topics inside a channel, so the skip/short-circuit go inside the topic loop, not the channel loop.

- [ ] **Step 1: Update imports**

Open `worker/src/worker.ts`. The `db/queries.js` import block (modified in Task 5) needs `upsertTopicScanState` too:

```typescript
import {
  // ... all existing entries from Task 5 ...
  upsertChannelScanState,
  upsertTopicScanState,
} from "./db/queries.js";
```

And the `./tdlib/chats.js` import needs `getForumTopicLastMessageId`:

```typescript
import {
  getAccountChats,
  joinChatByInviteLink,
  getChannelLastMessageId,
  getForumTopicLastMessageId,
} from "./tdlib/chats.js";
```

- [ ] **Step 2: Add the top-of-topic-loop skip guard**

Find the forum branch in `runWorkerForAccount`. The topic loop starts with `for (let tIdx = 0; tIdx < topics.length; tIdx++) {`. Inside that loop, find the `try {` block and the `let progress = topicProgressList.find(...)` line. Just AFTER the existing General-topic-ID fallback (`if (!progress && topic.name === "General")` block), and BEFORE the existing SkippedPackage retry pass, insert:

```typescript
              // ── Topic-scan-skip guard ──
              // Same three-signal decision as the non-forum branch, but
              // scoped to a single topic. Uses `progress` for the persisted
              // scan-state fields (lastScannedAt etc).
              try {
                const retryableForTopic = await getRetryableSkippedMessageIds({
                  accountId: account.id,
                  sourceChannelId: channel.id,
                  topicId: topic.topicId,
                  cap: config.maxSkipAttempts,
                });
                if (retryableForTopic.length === 0 && progress?.lastScannedAt) {
                  const sinceLastScanMs = Date.now() - progress.lastScannedAt.getTime();
                  const withinRecencyWindow = sinceLastScanMs < config.skipRecentScanWindowMs;
                  const inBackoff =
                    (progress.consecutiveEmptyScans ?? 0) >= config.emptyScanBackoffThreshold;
                  const backoffSkipsThisCycle =
                    inBackoff && getCurrentCycle() % config.emptyScanBackoffEveryNth !== 0;

                  if (
                    (withinRecencyWindow && !progress.lastScanFoundArchives) ||
                    backoffSkipsThisCycle
                  ) {
                    accountLog.debug(
                      {
                        channel: channel.title,
                        topic: topic.name,
                        sinceLastScanMs,
                        consecutiveEmptyScans: progress.consecutiveEmptyScans,
                        reason: withinRecencyWindow ? "recent-idle" : "backoff",
                      },
                      "Skipping topic — recently scanned and idle, or in backoff"
                    );
                    continue;
                  }
                }
              } catch (skipErr) {
                accountLog.warn(
                  { err: skipErr, topic: topic.name },
                  "Topic skip guard failed, proceeding with scan"
                );
              }
```

- [ ] **Step 3: Add `getForumTopicInfo` short-circuit after the retry pass**

In the same forum branch, find where the topic-level retry pass updates `progress` (look for the lines after the `if (retryable.length > 0)` block where `progress = { ...(progress ?? ...), lastProcessedMessageId: resetTo } as typeof progress;`). The `getTopicMessages` call comes shortly after. Just BEFORE the `const scanResult = await getTopicMessages(...)` line, insert:

```typescript
              // ── getForumTopic short-circuit ──
              // After the retry pass has settled the effective watermark,
              // ask TDLib for the topic's last_message_id. If it's <= our
              // watermark, no new content — skip the paginated search.
              const topicLastId = await getForumTopicLastMessageId(
                client,
                channel.telegramId,
                topic.topicId
              );
              const effectiveTopicWatermark = progress?.lastProcessedMessageId ?? null;
              if (
                topicLastId !== null
                && effectiveTopicWatermark !== null
                && topicLastId <= effectiveTopicWatermark
              ) {
                accountLog.info(
                  {
                    channel: channel.title,
                    topic: topic.name,
                    topicLastId: topicLastId.toString(),
                    watermark: effectiveTopicWatermark.toString(),
                  },
                  "Topic caught up via getForumTopic — skipping searchChatMessages"
                );
                await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                  lastProcessedMessageId: effectiveTopicWatermark,
                  lastScanFoundArchives: false,
                  consecutiveEmptyScans: (progress?.consecutiveEmptyScans ?? 0) + 1,
                });
                continue;
              }
```

- [ ] **Step 4: Replace the end-of-topic-scan watermark write with the new helper**

Find the existing topic-progress write. It's an `upsertTopicProgress` call at the end of the topic-loop body (after `processArchiveSets`). Look for:

```typescript
              if (topicWatermark !== null) {
                await upsertTopicProgress(
                  mapping.id,
                  topic.topicId,
                  topic.name,
                  topicWatermark
                );
              }
```

Replace it with:

```typescript
              // ── Persist topic scan state ──
              const retryableTopicPendingNow = await getRetryableSkippedMessageIds({
                accountId: account.id,
                sourceChannelId: channel.id,
                topicId: topic.topicId,
                cap: config.maxSkipAttempts,
              });
              const topicTrulyIdle =
                scanResult.archives.length === 0
                && minFailedId === null
                && retryableTopicPendingNow.length === 0;
              const newTopicConsecutive = topicTrulyIdle
                ? (progress?.consecutiveEmptyScans ?? 0) + 1
                : 0;
              if (topicWatermark !== null) {
                await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                  lastProcessedMessageId: topicWatermark,
                  lastScanFoundArchives: !topicTrulyIdle,
                  consecutiveEmptyScans: newTopicConsecutive,
                });
              }
```

- [ ] **Step 5: Same treatment for the "no archives found in topic" branch**

Earlier in the forum branch, there's a path that handles "scan returned zero archives" — it writes the watermark without going through `processArchiveSets`. Look for:

```typescript
              if (scanResult.archives.length === 0) {
                accountLog.info(
                  { channelId: channel.id, topic: topic.name, totalScanned: scanResult.totalScanned },
                  "No new archives in topic"
                );
                // Still advance topic watermark so we don't re-scan these messages next cycle
                if (scanResult.maxScannedMessageId) {
                  await upsertTopicProgress(
                    mapping.id,
                    topic.topicId,
                    topic.name,
                    scanResult.maxScannedMessageId
                  );
                }
                continue;
              }
```

Replace it with:

```typescript
              if (scanResult.archives.length === 0) {
                accountLog.info(
                  { channelId: channel.id, topic: topic.name, totalScanned: scanResult.totalScanned },
                  "No new archives in topic"
                );
                // Still advance topic watermark so we don't re-scan these messages next cycle.
                // Counts as truly idle UNLESS retryable SkippedPackages exist for this topic.
                const retryableTopicNoArchives = await getRetryableSkippedMessageIds({
                  accountId: account.id,
                  sourceChannelId: channel.id,
                  topicId: topic.topicId,
                  cap: config.maxSkipAttempts,
                });
                const topicTrulyIdleNoArchives = retryableTopicNoArchives.length === 0;
                if (scanResult.maxScannedMessageId) {
                  await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                    lastProcessedMessageId: scanResult.maxScannedMessageId,
                    lastScanFoundArchives: !topicTrulyIdleNoArchives,
                    consecutiveEmptyScans: topicTrulyIdleNoArchives
                      ? (progress?.consecutiveEmptyScans ?? 0) + 1
                      : 0,
                  });
                }
                continue;
              }
```

- [ ] **Step 6: Same treatment for the non-forum "no archives" path**

Symmetric to Step 5 but for the non-forum branch. Find:

```typescript
          if (scanResult.archives.length === 0) {
            accountLog.info({ channelId: channel.id, title: channel.title, totalScanned: scanResult.totalScanned }, "No new archives in channel");
            // Still advance watermark to highest scanned message so we don't
            // re-scan these messages next cycle
            if (scanResult.maxScannedMessageId) {
              await updateLastProcessedMessage(mapping.id, scanResult.maxScannedMessageId);
            }
            continue;
          }
```

Replace with:

```typescript
          if (scanResult.archives.length === 0) {
            accountLog.info({ channelId: channel.id, title: channel.title, totalScanned: scanResult.totalScanned }, "No new archives in channel");
            const retryableNoArchives = await getRetryableSkippedMessageIds({
              accountId: account.id,
              sourceChannelId: channel.id,
              topicId: null,
              cap: config.maxSkipAttempts,
            });
            const channelTrulyIdleNoArchives = retryableNoArchives.length === 0;
            if (scanResult.maxScannedMessageId) {
              await upsertChannelScanState(mapping.id, {
                lastProcessedMessageId: scanResult.maxScannedMessageId,
                lastScanFoundArchives: !channelTrulyIdleNoArchives,
                consecutiveEmptyScans: channelTrulyIdleNoArchives
                  ? (mapping.consecutiveEmptyScans ?? 0) + 1
                  : 0,
              });
            }
            continue;
          }
```

- [ ] **Step 7: Type-check**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npx tsc --noEmit 2>&1 | grep -v 'npm notice'"
```

Expected: zero errors.

- [ ] **Step 8: Full build to be sure runtime is also clean**

```bash
docker run --rm -v "$PWD:/work" -w /work/worker node:20-bookworm-slim sh -c "npm run build 2>&1 | tail -3"
```

Expected: silent success (just the `> tsc` line).

- [ ] **Step 9: Commit**

```bash
git add worker/src/worker.ts
git commit -m "$(cat <<'EOF'
feat(worker): forum-topic scan-skip + getForumTopic short-circuit

Mirror of the non-forum guards from the previous commit, scoped to
forum topics inside the topic loop:

  - Top-of-topic-loop recency/backoff skip
  - getForumTopic short-circuit after the SkippedPackage retry pass
  - upsertTopicScanState for the end-of-scan persistence (both the
    archives-found path and the no-archives path)
  - Symmetric no-archives path for the non-forum branch

Same trulyIdle definition throughout: no archives this scan, no
failures this scan, no retryable SkippedPackage rows pending. Channels
with chronic failures stay out of backoff because their counter never
increments.

For MPE specifically (1,086 forum topics), per-cycle searchChatMessages
calls drop from ~1,086 to roughly the count of topics with new
activity in the last 5 minutes — typically <50.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual verification against the live worker

This project has no automated tests. Verification is by Docker deploy + log inspection. Each step below corresponds to one risk identified in the design spec.

- [ ] **Step 1: Rebuild and restart the worker**

```bash
docker compose up -d --build worker
```

Wait for the migration to apply (visible in the dragonsstash app's startup logs — the worker container shares the DB). Expected: `Migration 20260526000000_channel_scan_state ... applied`.

- [ ] **Step 2: Confirm the first cycle scans everything**

```bash
docker logs --since 5m dragonsstash-worker 2>&1 | grep -E "(Scanning|caught up|Skipping channel|Skipping topic)" | tail -30
```

Expected: many "Scanning forum channel by topic" lines for MPE and other forums. No "Skipping" lines yet because all rows have `lastScannedAt = NULL`.

- [ ] **Step 3: Trigger an immediate second cycle (from admin UI's Trigger Cycle button, or via psql)**

```bash
docker exec dragonsstash-db psql -U admin -d dragonsstash -c "SELECT pg_notify('ingestion_trigger', '');"
```

Wait ~20 seconds.

- [ ] **Step 4: Confirm the second cycle skips idle channels/topics**

```bash
docker logs --since 1m dragonsstash-worker 2>&1 | grep -E "(Skipping channel|Skipping topic|caught up via)" | wc -l
```

Expected: a number >> 100 for an MPE-sized account. If you see 0, the recency window may be set wrong — confirm `WORKER_SKIP_RECENT_SCAN_WINDOW_MS` is unset or `300000`.

- [ ] **Step 5: Verify failure retry is NOT broken**

Pick a `SkippedPackage` row with `attemptCount < 5` (the default cap):

```bash
docker exec dragonsstash-db psql -U admin -d dragonsstash -c "
SELECT id, \"fileName\", \"attemptCount\", \"sourceChannelId\", \"sourceMessageId\"
FROM skipped_packages
WHERE \"attemptCount\" < 5
ORDER BY \"createdAt\" DESC
LIMIT 1;
"
```

Note the `sourceChannelId`. Trigger a cycle and confirm the channel containing that row is **not skipped**:

```bash
docker logs --since 30s dragonsstash-worker 2>&1 | grep "Skipping channel" | grep "<channel-title>"
```

Expected: no match (the channel was scanned, not skipped). And:

```bash
docker logs --since 30s dragonsstash-worker 2>&1 | grep "Resetting channel watermark to retry skipped messages"
```

Expected: at least one line indicating the retry pass ran.

- [ ] **Step 6: Verify backoff kicks in**

Pick a topic that's been idle for a while (e.g., MPE → "Erevan's Guide [Completed]"). After 5+ clean cycles, confirm:

```bash
docker exec dragonsstash-db psql -U admin -d dragonsstash -c "
SELECT \"topicName\", \"consecutiveEmptyScans\"
FROM topic_progress
WHERE \"consecutiveEmptyScans\" >= 5
ORDER BY \"consecutiveEmptyScans\" DESC
LIMIT 10;
"
```

Expected: at least a few topics with counter >= 5. Subsequent cycles should log "Skipping topic ... reason: backoff" for them, scanning only every 5th cycle.

- [ ] **Step 7: Verify restart safety**

Restart the worker container:

```bash
docker compose restart worker
```

Tail the logs during the first post-restart cycle:

```bash
docker logs --since 30s -f dragonsstash-worker 2>&1 | grep -E "(Skipping|caught up|Scanning .*topic)" | head -30
```

Expected: many "Skipping" / "caught up" lines well before any heavy scan starts. The first cycle after restart should take a fraction of the time it used to.

- [ ] **Step 8: If anything is wrong, do not commit further — the implementation commits from Tasks 1-6 produced the code.**

If a regression is detected (e.g., failure retries no longer fire), revert the relevant task commit with `git revert <hash>` and investigate. The changes are layered so reverting later tasks first is safe (config knobs and DB columns are inert without the worker.ts logic).

---

## Self-review

### Spec coverage

Walking each spec requirement against tasks:

- ✅ Schema columns on AccountChannelMap → Task 1, Step 1
- ✅ Schema columns on TopicProgress → Task 1, Step 2
- ✅ Migration SQL → Task 1, Step 3
- ✅ Three config knobs → Task 2
- ✅ DB helpers (`upsertChannelScanState`, `upsertTopicScanState`) → Task 3
- ✅ TDLib helpers (`getChannelLastMessageId`, `getForumTopicLastMessageId`) → Task 4
- ✅ Top-of-loop skip guard — non-forum → Task 5, Step 4
- ✅ Top-of-loop skip guard — forum topic → Task 6, Step 2
- ✅ `getChat` short-circuit — non-forum → Task 5, Step 5
- ✅ `getForumTopic` short-circuit — forum → Task 6, Step 3
- ✅ End-of-scan bookkeeping — non-forum (both archives-found and no-archives paths) → Task 5 Step 6 + Task 6 Step 6
- ✅ End-of-scan bookkeeping — forum (both paths) → Task 6 Steps 4 + 5
- ✅ `consecutiveEmptyScans` reset/increment logic → embedded in the bookkeeping steps
- ✅ `cycleCount % N` backoff modulo → Task 5 Step 4 / Task 6 Step 2 via `getCurrentCycle()`
- ✅ `getCurrentCycle()` exporter from scheduler → Task 5, Step 2
- ✅ "trulyIdle" formula consistent across all four bookkeeping sites → uses `getRetryableSkippedMessageIds`, `scanResult.archives.length`, `minFailedId`
- ✅ Manual verification covering each edge case → Task 7

No gaps.

### Placeholder scan

Searched for "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", "handle edge cases" — none present. All code blocks are complete; every step that says "do X" shows X verbatim.

### Type consistency

- `ScanStateUpdate` interface (Task 3) — `lastProcessedMessageId: bigint | null`, `lastScanFoundArchives: boolean`, `consecutiveEmptyScans: number`. All call sites in Tasks 5 and 6 pass these names.
- `upsertChannelScanState(mappingId, update)` — Task 5 always passes `mapping.id`. Consistent.
- `upsertTopicScanState(accountChannelMapId, topicId, topicName, update)` — Task 6 always passes `mapping.id, topic.topicId, topic.name, update`. Consistent.
- `getChannelLastMessageId(client, chatId)` returns `bigint | null` — Task 5 Step 5 checks `if (channelLastId !== null && ... && channelLastId <= ...)`. Consistent.
- `getForumTopicLastMessageId(client, chatId, topicId)` — same shape and same Task 6 usage. Consistent.
- `getCurrentCycle()` returns `number` — Task 5/6 use `% config.emptyScanBackoffEveryNth` which is also `number`. Consistent.
- `config.skipRecentScanWindowMs` / `emptyScanBackoffThreshold` / `emptyScanBackoffEveryNth` — all `number`, all read with `parseInt`. Consistent with `Date.now() - X.getTime()` (also number) comparisons.

### Build green at every commit

Each task ends with a type-check step before its commit, so the tree should compile after every commit individually. Task 6 adds a full build for extra safety.

---

## Execution Handoff

Plan complete and saved to [docs/superpowers/plans/2026-05-26-channel-scan-skip.md](docs/superpowers/plans/2026-05-26-channel-scan-skip.md). Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
