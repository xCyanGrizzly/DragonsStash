# Channel-Scan Skip Optimization — Design

**Goal:** stop the worker from re-scanning channels and forum topics that haven't changed since the last scan, especially on restart. Reduce the per-cycle API call count for the Model Printing Emporium channel (1,086 forum topics) from ~1,000+ to ~50.

**Non-goals:**
- Replacing polling with event-driven ingestion (`updateNewMessage`). That's a separate, larger design (Phase 2 in the original brainstorm).
- Surfacing per-channel scan history in the UI (also a separate, observability-only design).

**Architecture sketch:**
Add three persisted columns to `AccountChannelMap` and `TopicProgress`, plus one runtime `getChat`/`getForumTopicInfo` lookup before each scan. The new state survives restarts because it's in PostgreSQL; the lookup is a cheap TDLib local-cache call. Failure-retry semantics (`d99a506` + `901f32f`) must be preserved — a channel sitting on retryable `SkippedPackage` rows is never considered idle.

---

## Problem statement

### Today's behavior

Every ingestion cycle the worker walks every linked source channel for every authenticated account. For each channel/topic it calls TDLib's `searchChatMessages` paginated from `lastProcessedMessageId`. Even when nothing has changed since the previous scan:

- One `searchChatMessages` call (sometimes paginated) is still made
- For Model Printing Emporium, that's ~1,086 calls per cycle (one per forum topic)
- The 1-second `apiDelayMs` between pages multiplies the cost
- Most calls return zero new messages — the work is wasted

The cost is most acute right after a restart: the worker boots, runs recovery, then issues 1,000+ effectively-empty calls before any productive work happens.

### What we already track

- `AccountChannelMap.lastProcessedMessageId` — highest processed message ID (per non-forum channel, per account)
- `TopicProgress.lastProcessedMessageId` — same per forum topic
- Both are advanced incrementally per archive set (`77aeb4c`)
- Both are pulled back below failed messages by the `SkippedPackage` retry pass (`901f32f`)

### What we don't track and want to add

- When was the last scan?
- Did the last scan find any archives, OR is there outstanding retry work?
- How many cycles in a row have been totally idle?

These let us skip the scan entirely when nothing has changed.

---

## High-level approach

Three guards at the top of the per-channel and per-topic processing loops:

1. **DB-persistent "skip if recently scanned and truly idle"** — checks `lastScannedAt`, `lastScanFoundArchives`, and a `retryableSkippedCount` query. If all three say "nothing new, nothing failing", skip without any TDLib call.

2. **Adaptive backoff for cold channels** — `consecutiveEmptyScans` counter. After it crosses a threshold, scan only every Nth cycle. Reset to 0 whenever the channel is "not idle".

3. **`chat.last_message.id` short-circuit** — if (1) and (2) don't skip but the channel's last server-side message ID matches our watermark, skip the `searchChatMessages` paginated call. This runs after the existing `SkippedPackage` retry pass, which pulls the watermark back below failures, so it correctly forces a scan when retries are pending.

The retry pass from `901f32f` is preserved untouched — it runs in front of these guards and adjusts the watermark, so retries always happen.

---

## Schema changes

### `AccountChannelMap` (worker/src/db/schema.prisma)

```prisma
model AccountChannelMap {
  // ... existing fields ...
  lastScannedAt          DateTime?
  lastScanFoundArchives  Boolean   @default(false)
  consecutiveEmptyScans  Int       @default(0)
}
```

### `TopicProgress`

```prisma
model TopicProgress {
  // ... existing fields ...
  lastScannedAt          DateTime?
  lastScanFoundArchives  Boolean   @default(false)
  consecutiveEmptyScans  Int       @default(0)
}
```

### Migration

```sql
-- Both tables get the same three columns. Existing rows get defaults:
--   lastScannedAt        = NULL  (next scan will populate)
--   lastScanFoundArchives = false (safe default — will be overwritten by next scan)
--   consecutiveEmptyScans = 0    (resets backoff for existing channels)

ALTER TABLE "account_channel_map"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "topic_progress"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;
```

NULL `lastScannedAt` means "never scanned" — every channel will be scanned the first cycle after deploy. Subsequent cycles benefit from the new fields.

---

## Configuration

Two new env vars in `worker/src/util/config.ts`:

```typescript
/** Window in which a recent successful empty scan lets us skip. Default 5 min. */
skipRecentScanWindowMs:
  parseInt(process.env.WORKER_SKIP_RECENT_SCAN_WINDOW_MS ?? "300000", 10),

/** After this many consecutive empty scans, channel enters backoff mode. */
emptyScanBackoffThreshold:
  parseInt(process.env.WORKER_EMPTY_SCAN_BACKOFF_THRESHOLD ?? "5", 10),

/** Backoff factor — N means "scan every Nth cycle once in backoff". */
emptyScanBackoffEveryNth:
  parseInt(process.env.WORKER_EMPTY_SCAN_BACKOFF_EVERY_NTH ?? "5", 10),
```

All three are tunable per deployment without code changes.

---

## Decision logic per channel / topic

The skip decision sits at the top of each channel/topic iteration in `runWorkerForAccount`. It runs BEFORE the existing `SkippedPackage` retry pass.

```text
For each channel (or topic):

  1. Query retryableSkippedCount for this scope (already a query we do elsewhere)

  2. If retryableSkippedCount > 0:
       Force scan (don't skip — failures need retry)
       Proceed to existing flow (retry pass → scan)

  3. Else if lastScannedAt is NULL:
       Force scan (we've never touched this)
       Proceed to existing flow

  4. Else if Date.now() - lastScannedAt.getTime() < skipRecentScanWindowMs
          AND lastScanFoundArchives === false:
       Skip — recently scanned and truly idle

  5. Else if consecutiveEmptyScans >= emptyScanBackoffThreshold
          AND (cycleCount % emptyScanBackoffEveryNth !== 0):
       Skip — channel is cold, not its turn to scan

  6. Else:
       Run the existing flow:
         a. SkippedPackage retry pass (901f32f) — may pull watermark back
         b. NEW: getChat (or getForumTopicInfo) — if last_message.id <= watermark, skip
         c. searchChatMessages scan
```

`cycleCount` is the global ingestion-cycle counter from `scheduler.ts`. It already increments per cycle.

---

## End-of-scan bookkeeping

After every scan (whether it found archives or not), update the three new fields atomically with the existing watermark write:

```typescript
// "Truly idle" means: nothing new this scan AND nothing failed AND no leftover
// retryable failures. The retry-pending check is critical — without it, a
// scan that found no new archives but left SkippedPackage retries pending
// would be marked idle and incorrectly skipped next cycle.
const retryablePending = await getRetryableSkippedMessageIds({
  accountId, sourceChannelId, topicId, cap: maxSkipAttempts,
});
const trulyIdle =
  scanResult.archives.length === 0
  && minFailedId === null
  && retryablePending.length === 0;

const newConsecutiveEmpty = trulyIdle
  ? (prev.consecutiveEmptyScans ?? 0) + 1
  : 0;

await upsertChannelOrTopicScanState({
  // ... existing watermark fields ...
  lastScannedAt: new Date(),
  lastScanFoundArchives: !trulyIdle,
  consecutiveEmptyScans: newConsecutiveEmpty,
});
```

The `consecutiveEmptyScans` counter resets to 0 the moment *anything* happens — archives found, archives failed, or unresolved retries pending. A channel with a chronically-failing archive (whose attemptCount is still below the cap) keeps the counter at 0 and never enters backoff.

If a SkippedPackage hits `attemptCount === maxSkipAttempts`, it's no longer "retryable pending" (it's been given up on), so the counter increments correctly. Same for SkippedPackages that get deleted via the UI's "retry" button — the counter behaves correctly without special-casing.

---

## `getChat` / `getForumTopicInfo` short-circuit

After the retry pass has finalized the effective watermark, but before `searchChatMessages`:

```typescript
// For non-forum channels:
const chat = await client.invoke({ _: "getChat", chat_id: Number(channel.telegramId) });
const channelLastMessageId = chat.last_message?.id;

if (channelLastMessageId && BigInt(channelLastMessageId) <= effectiveWatermark) {
  // Nothing new server-side — skip the paginated search entirely.
  // Still update lastScannedAt / consecutiveEmptyScans so the recent-scan
  // skip kicks in next cycle.
  await persistScanState({ trulyIdle: true });
  continue;
}

// For forum topics:
const topicInfo = await client.invoke({
  _: "getForumTopicInfo",
  chat_id: Number(channel.telegramId),
  message_thread_id: Number(topic.topicId),
});
const topicLastMessageId = topicInfo.info?.last_message_id;

if (topicLastMessageId && BigInt(topicLastMessageId) <= effectiveWatermark) {
  await persistScanState({ trulyIdle: true });
  continue;
}
```

`getChat` is served from TDLib's local cache (no network) for chats we've already loaded, which we do up front via `loadChats`. `getForumTopicInfo` is a single round-trip but much cheaper than a paginated `searchChatMessages` call.

The comparison is `<=` because the watermark is the highest message we've fully processed — if the server's last is the same, we're caught up.

This step is correct in the failure-retry case because the retry pass runs FIRST: if there were retryable failures, the retry pass pulled the watermark back below them, and `channelLastMessageId > effectiveWatermark` (since the failed message exists in TG), so we don't skip — we scan and re-pick-up the failure.

---

## Restart behavior

The improvements compose for restart safety:

| Scenario | Today | After this change |
|---|---|---|
| Restart 5 min after a clean cycle | ~2,000 API calls for MPE | ~10 calls (only retryable + truly-active topics) |
| Restart 1 hour later (one missed cycle) | ~2,000 API calls | `getChat` per channel + scan only those where `last_message.id > watermark` (≈ 50 for MPE) |
| Restart after long downtime (12h) | ~2,000 calls + lots of new content | `getChat` per channel, scan everything with new activity |

The three new columns are in PostgreSQL — they survive container restarts directly. `consecutiveEmptyScans = 47` for a cold topic stays at 47 across restart, so backoff continues to apply.

---

## Edge cases and their handling

### 1. Manual SkippedPackage retry via UI between cycles
The UI's `retrySkippedPackageAction` lowers the watermark and deletes the SkippedPackage. Next cycle: `retryableSkippedCount === 0` (the row is gone), but the watermark is lower than `chat.last_message.id` (the retried message exists in TG). So step 6 in the decision tree triggers a scan via the `getChat` check. ✓

### 2. SkippedPackage hits the attempt cap mid-cycle
Once `attemptCount === maxSkipAttempts`, the row is no longer in `getRetryableSkippedMessageIds` results. The channel correctly becomes idle-eligible. The capped SkippedPackage stays in the table as "permanently failed (manual retry only)" — that's the existing behavior. ✓

### 3. New SkippedPackage is created mid-cycle (e.g., an upload fails)
At the end of that scan, `retryablePending` includes the new row → `trulyIdle = false` → `lastScanFoundArchives = true` → next cycle does NOT skip. ✓

### 4. Channel/topic added after deploy
New rows in `AccountChannelMap` / `TopicProgress` have `lastScannedAt = NULL`, so step 3 in the decision tree always triggers a scan. After the first scan, the fields are populated normally. ✓

### 5. Clock skew / drift
The `lastScannedAt < 5 min ago` check uses `Date.now() - lastScannedAt.getTime()`. Both are application-side clocks (Node.js + PostgreSQL `NOW()` at write). A few seconds of drift doesn't matter; an hour of clock jump (rare but possible) just means one cycle either skips or re-scans — recoverable.

### 6. TDLib `getChat` returns stale data
TDLib's local cache could theoretically be stale (e.g., the account hasn't received the latest update yet). If `channelLastMessageId` is stale (lower than server reality), we'd skip a scan that should have happened. Mitigation: the next cycle's `getChat` likely has fresh data; the watermark guards correctness (we don't lose data, we just process it one cycle later). Acceptable.

### 7. `getForumTopicInfo` rate limit
Calling it per-topic could add up for channels with 1000+ topics. Mitigation: skip-on-recent-scan (step 4) eliminates the call for most topics; only "stale-but-was-active" topics get the call. Worst case is ~50 calls per cycle for MPE, comfortably under the 30 req/sec global limit.

### 8. Channel becomes a forum (or vice versa) between cycles
Existing code handles this — `isChatForum` is rechecked each cycle and `setChannelForum` updates the DB. The new fields live on the same rows, so no extra handling needed.

---

## File-level changes

### New / modified

- `prisma/schema.prisma` — add the six new columns
- `prisma/migrations/<timestamp>_channel_scan_state/migration.sql` — the ALTER TABLE
- `worker/src/util/config.ts` — three new env vars
- `worker/src/db/queries.ts` — new helpers:
  - `getChannelScanState(mappingId)` and `getTopicScanState(topicProgressId)`
  - `upsertChannelScanState(...)` and `upsertTopicScanState(...)`
  - Both wrap the existing `updateLastProcessedMessage` / `upsertTopicProgress` so callers don't need to remember to update the new fields too.
- `worker/src/worker.ts` — top-of-loop skip checks in both the forum and non-forum branches, plus end-of-scan state writes
- `worker/src/tdlib/chats.ts` — small helper `getChatLastMessageId(client, chatId)` and `getForumTopicLastMessageId(client, chatId, topicId)` wrapping the TDLib calls with the existing `invokeWithTimeout` pattern

### Untouched

- `recovery.ts` — recovery is per-startup and one-shot; not affected
- `scheduler.ts` — `cycleCount` is already there; just expose it where needed
- The existing `SkippedPackage` retry pass logic in `runWorkerForAccount` is unchanged

---

## Testing plan

The project has no automated tests, so verification is manual via Docker logs after deploy:

1. **Build cleanly:** `docker compose up -d --build worker` — no migration errors
2. **First cycle after deploy:** all channels scan (NULL `lastScannedAt`), all fields populated at end of cycle. Log lines confirm normal scan flow.
3. **Second cycle 5 min later:**
   - Check logs for `"Skipping recently-scanned idle channel"` — should appear for any channel/topic that was empty last cycle
   - Total `searchChatMessages` calls per cycle should drop dramatically (compare to first cycle)
4. **Failure-retry preservation:**
   - Find a SkippedPackage with `attemptCount < cap`
   - Run a cycle — confirm the channel/topic is NOT skipped (log says it's scanned)
   - Confirm the SkippedPackage gets re-tried
5. **Backoff:**
   - Pick a cold channel, wait for it to scan 5+ cycles cleanly
   - Confirm `consecutiveEmptyScans` climbs to 5+
   - Confirm subsequent cycles skip it (only scan every 5th)
6. **`getChat` short-circuit:**
   - Pick an active channel
   - Trigger an immediate cycle (UI button)
   - If `last_message.id <= watermark`, expect log `"Channel caught up via getChat — skipping searchChatMessages"`
7. **Restart safety:**
   - Push the change, restart worker
   - First cycle after restart should log multiple "Skipping recently-scanned idle channel" lines (because the DB state survived)
   - Total cycle time should be a fraction of a baseline restart

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Skip incorrectly applied → real failures never retried | Rule 1 (truly-idle includes `retryablePending === 0`) + dedicated test step 4 |
| `getChat` returns stale data | Next cycle's `getChat` corrects it; watermark guards correctness (no data loss) |
| `getForumTopicInfo` not available in TDLib 1.8.64 | Verify the method exists in the schema; fall back to scan if it throws |
| Backoff applies during legitimate activity bursts | Counter resets to 0 the moment any archive is found OR any retry is pending |
| Migration takes too long on the live DB | Both columns have NOT NULL defaults — Postgres can add them as fast metadata changes (no table rewrite) |

---

## What's explicitly NOT in this design

To keep scope tight:
- **Event-driven ingestion via `updateNewMessage`.** Bigger design, addressed separately. This design is compatible with it — when (D) lands, polling becomes a 4-hour safety net using these same skip rules.
- **Per-channel scan history UI.** Observability layer; separate design.
- **Surfacing the new counters in the admin dashboard.** Can come after the worker-side change is verified.
- **Backfilling `consecutiveEmptyScans` from historical `IngestionRun` data.** Not worth it — it'll converge to the correct value within ~6 cycles.

---

## Open questions

None — the failure-retry interaction was the main risk and is handled by Rule 1 + the existing retry pass.
