# Dragonstash Grouping System Audit & Enhancement Report

## Appendix: Real-World Failure Cases (2026-03-29/30)

These skipped packages reveal two concrete issues:

### Issue A: `WORKER_MAX_ZIP_SIZE_MB` was 4 GB — blocking all large multipart archives

| File | Parts | Total Size | Status |
|------|-------|-----------|--------|
| DM-Stash - Guide to Tharador - Complete STL | 19 | 70.5 GB | SIZE_LIMIT |
| DM-Stash - 2023-05 - Greywinds All-in | 16 | 58.9 GB | SIZE_LIMIT |
| Axolote Gaming - Castle of the Vampire Lord | 10 | 18 GB | SIZE_LIMIT |
| Dungeon Blocks - THE ULTIMATE DUNGEON | 5 | 7.6 GB | SIZE_LIMIT |
| Dungeon Blocks - The Toxic sewer | 4 | 6.2 GB | SIZE_LIMIT |
| Soulmist | 4 | 6.3 GB | SIZE_LIMIT |
| Medieval Town PT1 | 3 | 5.7 GB | SIZE_LIMIT |
| Knight Models - Game Of Thrones | 3 | 5.5 GB | SIZE_LIMIT |
| Dungeon Blocks - The Lost Cave | 3 | 4.9 GB | SIZE_LIMIT |
| El Miniaturista 2025-05 Fulgrim Part II and III | 5 | 4.7 GB | SIZE_LIMIT |

**Root cause:** Production env had `WORKER_MAX_ZIP_SIZE_MB=4096`. The default in code is 204800 (200 GB), but docker-compose.yml defaulted to 4096.

**Fix applied:** Raised to 204800 in `/opt/stacks/DragonsStash/.env`. Worker restarted. These archives will be retried on the next ingestion cycle. The worker downloads parts individually (each under 2-4 GB), concatenates, re-splits at 1950 MiB for upload. Peak temp disk usage for the 70.5 GB archive: ~211 GB (353 GB available).

**Code fix:** `MAX_PART_SIZE` is now configurable via `MAX_PART_SIZE_MB` env var (was hardcoded at 1950). Set to 3900 for Telegram Premium accounts to avoid unnecessary splitting.

### Issue B: Download failure at 98% (DE1-Supported.7z)

| File | Size | Error |
|------|------|-------|
| DE1-Supported.7z | 1.9 GB | Download stopped unexpectedly at 2043674624/2078338541 bytes (98%) |

**Root cause:** Download stalled near completion with no retry mechanism.

**Fix applied:** Earlier in this session, download retry logic was added (max 3 retries with `cancelDownloadFile` before each retry). This file will be retried automatically on next ingestion cycle.

---

## Deliverable 1: Audit Report — Current State

### 1.1 Grouping Signal Stack (Current)

The system currently uses exactly **one automatic grouping signal**:

| Priority | Signal | Status | Location |
|----------|--------|--------|----------|
| 1 | `mediaAlbumId` | Implemented | `worker/src/grouping.ts:26-33` |
| 2 | Manual override | Implemented | `src/lib/telegram/queries.ts:606-639` |

**How it works:**
- `processAlbumGroups()` in `worker/src/grouping.ts` groups indexed packages by `mediaAlbumId` (filtering out "0" and null)
- For albums with 2+ members: creates `PackageGroup`, links packages, assigns name from album photo caption or first filename
- Manual grouping via UI: select 2+ packages, enter name, creates group in `createManualGroup()`

**What does NOT exist:**
- No `message_thread_id` (forum topic) scoping
- No project/month pattern extraction from filenames
- No creator/sender grouping
- No time-window + sender clustering
- No reply chain analysis
- No ZIP internal path prefix matching
- No caption fuzzy matching
- No staging queue for ungrouped files

### 1.2 Multipart Archive Detection (`worker/src/archive/multipart.ts`)

This is a **separate system** from display grouping. `groupArchiveSets()` groups Telegram messages into `ArchiveSet[]` based on filename patterns:

- `.zip.001`, `.zip.002` → ZIP_NUMBERED
- `.z01`, `.z02`, `.zip` → ZIP_LEGACY
- `.part1.rar`, `.part2.rar` → RAR_PART
- `.r00`, `.r01`, `.rar` → RAR_LEGACY

These are grouped by `format:baseName.toLowerCase()` key. This is about **reassembling split archives**, not UI grouping. An `ArchiveSet` becomes a single `Package` in the database.

### 1.3 TDLib Ingestion Handler

**Pipeline in `worker/src/worker.ts:801-1197`:**
```
processOneArchiveSet():
  1. Early skip check (source message ID)
  2. Size guard (maxZipSizeMB)
  3. Download all parts
  4. Compute SHA-256 hash
  5. Check hash dedup
  6. Read archive metadata
  7. Split/repack if needed
  8. Upload to destination
  9. Download preview
 10. Extract fallback preview
 11. Resolve creator
 12. Index in database
 13. Cleanup temp files
```

**Post-indexing:** `processAlbumGroups()` is called once per channel/topic scan to create album-based groups.

**Gaps:**
- Messages are never "dropped" silently — failures go to `SkippedPackage` table with reason
- Watermark only advances past successfully processed sets (failed sets block advancement)
- No messages are missed within a channel, but there's no audit to verify completeness after the fact

### 1.4 Hash Verification

**What IS verified:**
| Check | Where | When |
|-------|-------|------|
| Download file size | `download.ts:verifyAndMove()` | After each file download |
| SHA-256 content hash | `worker.ts:952` | After download, used for dedup |
| Telegram upload confirmation | `channel.ts:updateMessageSendSucceeded` | Waits for server ACK |

**What is NOT verified:**
| Gap | Impact |
|-----|--------|
| No hash after upload | Can't detect Telegram-side corruption |
| No hash after split | Split files could be silently corrupted |
| CRC-32 extracted but never checked | ZIP/RAR per-file integrity not validated |
| No end-to-end hash | Split files have different hash than original |
| No periodic audit job | Stale/missing data never detected |

### 1.5 File Size Limit

| Setting | Value | Configurable? | Location |
|---------|-------|---------------|----------|
| `MAX_PART_SIZE` | 1950 MiB | **Hardcoded** | `worker/src/archive/split.ts:14` |
| `MAX_UPLOAD_SIZE` | 1950 MiB | **Hardcoded** | `worker/src/worker.ts:1023` |
| `maxZipSizeMB` | 200 GB | `WORKER_MAX_ZIP_SIZE_MB` env var | `worker/src/util/config.ts:6` |

The 1950 MiB limit is deliberately below 2 GiB to avoid TDLib's `FILE_PARTS_INVALID` error. There is **no Premium awareness** — all accounts are treated as non-Premium.

### 1.6 Search Implementation

- **No fuzzy search** — uses Prisma's `contains` with `mode: "insensitive"` (translates to PostgreSQL `ILIKE`)
- **No full-text search infrastructure** — no `tsvector`, no GiST/GIN indexes
- **Indexes:** B-tree on `fileName`, `creator`, `archiveType`, `indexedAt`, plus `PackageFile.fileName` and `extension`
- Search works for substring matching but won't match typos or similar names

### 1.7 Notification Infrastructure

- **pg_notify channels:** `bot_send`, `new_package` (bot), plus 7 worker channels
- **Bot subscriptions:** pattern-match (case-insensitive substring) on `fileName` and `creator`
- **UI notifications:** Sonner toast (ephemeral only)
- **No persistent notification store** — no database model for notifications
- **No notification UI panel** in the web app
- **No alerts for:** grouping conflicts, hash mismatches, missing parts, upload failures (beyond SkippedPackage table)

---

## Deliverable 2: Revised Grouping Signal Stack

### Recommended Implementation Plan

I recommend an **incremental approach** — implement signals in phases, starting with highest-value/lowest-risk.

### Phase 1: Foundation (Required Before Other Signals)

#### Signal 9: Manual Override Persistence
**Status:** Partially implemented. Manual groups exist but don't influence future auto-grouping.

**Implementation:**
- Add `groupingSource` field to `PackageGroup`: `"ALBUM" | "MANUAL" | "AUTO_PATTERN" | "AUTO_TIME" | "AUTO_REPLY" | "AUTO_ZIP" | "AUTO_CAPTION"`
- Manual groups already persist. What's missing is the **training feedback** where a manual grouping teaches the system to auto-group similar future files.
- This requires a `GroupingRule` model (see schema diff below) that stores learned patterns from manual overrides.

#### Ungrouped Staging Queue
**Implementation:**
- After ingestion, packages without a `packageGroupId` are naturally "ungrouped"
- Add a filter/tab to the STL page: "Ungrouped" showing packages where `packageGroupId IS NULL`
- No schema change needed — just a query filter

### Phase 2: High-Value Automatic Signals

#### Signal 1: `mediaAlbumId` (Already Implemented)
No changes needed. This is working correctly.

#### Signal 2: `message_thread_id` Forum Topic Scoping
**Status:** Already used for scan scoping (worker scans by topic), but not used as a grouping signal.

**Implementation:**
- `sourceTopicId` is already stored on `Package` (schema line 469)
- Use it as a **scoping constraint** for all other signals: time-window, caption matching, etc. only apply within the same topic
- No additional schema changes needed

#### Signal 5: Time Window + Sender Grouping
**Implementation:**
- After album grouping, find ungrouped packages from the same source channel + topic
- Within a configurable window (default 5 min), cluster by proximity
- Since we don't have `sender_id` from the source channel (TDLib `searchChatMessages` doesn't return it for channels), this becomes **time-window within topic/channel**
- New config: `AUTO_GROUP_TIME_WINDOW_MINUTES` (default: 5)

#### Signal 3: Project/Month Pattern Extraction
**Implementation:**
- Extract date patterns from filenames/captions: `YYYY-MM`, `YYYY_MM`, `MonthName Year`
- Extract project slugs: common prefix before separator (e.g., "ProjectName - File1.zip" and "ProjectName - File2.zip")
- Group packages with matching patterns from the same channel
- This should run as a **post-processing pass** after time-window grouping, merging small time-window groups that share a pattern

#### Signal 4: Creator Grouping
**Implementation:**
- The `creator` field is already extracted from filenames and stored per-package
- Within a channel, if multiple ungrouped packages have the same `creator` and were indexed within the same ingestion run, auto-group them
- Lower priority than time-window (might create overly broad groups)

### Phase 3: Advanced Signals

#### Signal 6: Reply Chain
**Implementation:**
- TDLib messages have `reply_to_message_id` but this isn't currently captured during scanning
- Would need to modify `getChannelMessages()` in `download.ts` to extract `reply_to_message_id`
- Then: if message B replies to message A, and both are archives, group them
- **Moderate complexity**, deferred to Phase 3

#### Signal 7: ZIP Internal Path Prefix
**Implementation:**
- Already have `PackageFile.path` stored for each file inside an archive
- After indexing, find the common root folder across all files
- If two packages share the same root prefix and same channel, suggest grouping
- This is a **post-hoc analysis** that could run as a background job

#### Signal 8: Caption Fuzzy Match
**Implementation:**
- Currently captions from source messages are NOT stored (only photo captions for preview matching)
- Would need to capture `msg.content?.caption?.text` during scanning and store on Package
- Then: fuzzy-match captions from nearby messages in same channel
- **Requires schema change + scan modification**, deferred to Phase 3

---

## Deliverable 3: Schema Diff

All changes are **additive** — no columns dropped, no types changed.

```prisma
// ── PackageGroup additions ──
model PackageGroup {
  // ... existing fields ...
  groupingSource  GroupingSource  @default(MANUAL)  // NEW: how this group was created
}

// NEW enum
enum GroupingSource {
  ALBUM           // From Telegram mediaAlbumId
  MANUAL          // User-created via UI
  AUTO_PATTERN    // Filename/date pattern matching
  AUTO_TIME       // Time-window clustering
  AUTO_REPLY      // Reply chain
  AUTO_ZIP        // ZIP path prefix
  AUTO_CAPTION    // Caption fuzzy match
}

// ── Package additions ──
model Package {
  // ... existing fields ...
  sourceCaption   String?         // NEW: caption text from source Telegram message
}

// ── New model: GroupingRule (training from manual overrides) ──
model GroupingRule {
  id              String          @id @default(cuid())
  sourceChannelId String
  pattern         String          // Regex or glob pattern learned from manual grouping
  signalType      GroupingSource  // Which signal this rule applies to
  confidence      Float           @default(1.0)
  createdAt       DateTime        @default(now())
  createdByGroupId String?        // The manual group that spawned this rule

  sourceChannel   TelegramChannel @relation(fields: [sourceChannelId], references: [id], onDelete: Cascade)

  @@index([sourceChannelId])
  @@map("grouping_rules")
}

// ── New model: SystemNotification ──
model SystemNotification {
  id              String              @id @default(cuid())
  type            NotificationType
  severity        NotificationSeverity @default(INFO)
  title           String
  message         String
  context         Json?               // Structured data: packageId, groupId, sourceMessageId, etc.
  isRead          Boolean             @default(false)
  createdAt       DateTime            @default(now())

  @@index([isRead, createdAt])
  @@index([type])
  @@map("system_notifications")
}

enum NotificationType {
  HASH_MISMATCH
  MISSING_PART
  UPLOAD_FAILED
  DOWNLOAD_FAILED
  GROUPING_CONFLICT
  INTEGRITY_AUDIT
}

enum NotificationSeverity {
  INFO
  WARNING
  ERROR
}

// ── Config additions (worker/src/util/config.ts) ──
// maxPartSizeMB: parseInt(process.env.MAX_PART_SIZE_MB ?? "1950", 10)
// autoGroupTimeWindowMinutes: parseInt(process.env.AUTO_GROUP_TIME_WINDOW_MINUTES ?? "5", 10)
// telegramPremium: process.env.TELEGRAM_PREMIUM === "true"
```

**Migration notes:**
- All new fields are optional/have defaults — zero-risk to existing data
- `GroupingSource` enum added with `@default(MANUAL)` — existing groups unaffected
- `GroupingRule` and `SystemNotification` are new tables — no impact on existing
- Backfill: set `groupingSource = ALBUM` for groups where `mediaAlbumId IS NOT NULL`

---

## Deliverable 4: Notification Contract

### Event Shape

```typescript
interface SystemNotificationEvent {
  type: NotificationType;
  severity: "INFO" | "WARNING" | "ERROR";
  title: string;
  message: string;
  context: {
    packageId?: string;
    groupId?: string;
    sourceChannelId?: string;
    sourceMessageId?: bigint;
    fileName?: string;
    partNumber?: number;
    totalParts?: number;
    expectedHash?: string;
    actualHash?: string;
    reason?: string;
  };
}
```

### Where Notifications Fire

| Event | Where | Trigger |
|-------|-------|---------|
| `HASH_MISMATCH` | `worker/src/worker.ts` after split | SHA-256 of concatenated split parts != original hash |
| `MISSING_PART` | Periodic audit job (new) | Group has `partCount > 1` but fewer than `partCount` dest messages exist |
| `UPLOAD_FAILED` | `worker/src/worker.ts` catch block | Upload fails after all retries exhausted |
| `DOWNLOAD_FAILED` | `worker/src/worker.ts` catch block | Download fails after all retries |
| `GROUPING_CONFLICT` | Auto-grouping pass (new) | Two signals suggest different groups for the same package |
| `INTEGRITY_AUDIT` | Periodic job (new) | Scheduled check finds inconsistencies |

### Delivery

1. **Database:** Always persisted to `SystemNotification` table
2. **pg_notify:** `SELECT pg_notify('system_notification', jsonPayload)` for real-time
3. **Web UI:** Notification bell/panel that polls or listens for new notifications
4. **Telegram (optional):** Forward critical notifications to admin via bot

---

## Deliverable 5: Feature Flag Plan

### Runtime Configuration (Environment Variables)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `TELEGRAM_PREMIUM` | boolean | `false` | Enable 4GB upload limit |
| `MAX_PART_SIZE_MB` | number | `1950` | Split threshold in MiB (overrides hardcoded value) |
| `AUTO_GROUP_ENABLED` | boolean | `false` | Enable automatic grouping beyond album |
| `AUTO_GROUP_TIME_WINDOW_MINUTES` | number | `5` | Time-window clustering threshold |
| `AUTO_GROUP_PATTERN_ENABLED` | boolean | `false` | Enable filename/date pattern grouping |
| `INTEGRITY_AUDIT_ENABLED` | boolean | `false` | Enable periodic integrity audit |
| `INTEGRITY_AUDIT_INTERVAL_HOURS` | number | `24` | How often to run the audit |

### Premium Mode Behavior

When `TELEGRAM_PREMIUM=true`:
1. `MAX_PART_SIZE_MB` defaults to `3900` (safely under 4 GiB) instead of `1950`
2. Files under 4 GB: uploaded as-is (no splitting)
3. Files over 4 GB: split using existing `byteLevelSplit()` at the new threshold
4. Existing split/rejoin logic is **kept as fallback** — never removed
5. `isMultipart` and `partCount` continue to track actual upload state

### Implementation in `split.ts`:

```typescript
// Replace hardcoded constant with config-driven:
const MAX_PART_SIZE = BigInt(config.maxPartSizeMB) * 1024n * 1024n;
```

And in `config.ts`:
```typescript
maxPartSizeMB: parseInt(
  process.env.MAX_PART_SIZE_MB ??
    (process.env.TELEGRAM_PREMIUM === "true" ? "3900" : "1950"),
  10
),
```

### Rollout Strategy

1. **All flags default to off** — zero behavior change on deploy
2. Enable `TELEGRAM_PREMIUM` first (simple, well-understood)
3. Enable `AUTO_GROUP_ENABLED` on a **per-channel basis** (see test plan) before globally
4. Enable `INTEGRITY_AUDIT_ENABLED` after manual validation
5. Pattern-based grouping enabled last (highest complexity)

---

## Deliverable 6: Test Plan

### Phase 0: Pre-Implementation Validation

Before touching any code, verify the current system baseline:

1. **Pick one test channel** with known content (a mix of albums, single files, and multipart archives)
2. Run an ingestion cycle and record: number of packages, groups, skipped
3. Verify all album-based groups are correct
4. Note any ungrouped files that "should" be grouped
5. This becomes the **regression baseline**

### Phase 1: Premium Mode Testing

1. Set `TELEGRAM_PREMIUM=true` and `MAX_PART_SIZE_MB=3900`
2. Manually upload a 3 GB test file to a source channel
3. Trigger ingestion — verify it uploads as a single message (not split)
4. Manually upload a 5 GB test file
5. Trigger ingestion — verify it splits at ~3.9 GB threshold
6. Verify `isMultipart`, `partCount`, `destMessageIds` are correct
7. Send the package via bot — verify all parts arrive

### Phase 2: Time-Window Grouping Testing

1. Enable `AUTO_GROUP_ENABLED=true` on the test channel only
2. Post 3 files to the channel within 2 minutes (no album)
3. Trigger ingestion — verify they auto-group
4. Post 2 files 10 minutes apart
5. Trigger ingestion — verify they stay ungrouped
6. Manually group them — verify `GroupingRule` is created
7. Post similar files — verify auto-grouping kicks in

### Phase 3: Manual QA via API

Add a **test endpoint** (dev-only) that accepts a fake message payload and runs it through the grouping pipeline without hitting Telegram:

```
POST /api/dev/test-grouping
Body: { messages: [...], channelId: "..." }
Response: { suggestedGroups: [...] }
```

This allows testing grouping logic against crafted scenarios without waiting for real Telegram messages.

### Phase 4: Integrity Audit Testing

1. Enable `INTEGRITY_AUDIT_ENABLED=true`
2. Manually corrupt a record (set wrong `contentHash` in DB)
3. Run audit — verify `HASH_MISMATCH` notification is created
4. Delete one `destMessageId` from a multipart package's `destMessageIds`
5. Run audit — verify `MISSING_PART` notification is created
6. Check notification UI shows both

### Regression Checks After Each Phase

- Re-run ingestion on test channel — same number of packages/groups as baseline
- Search for known filenames — still returns correct results
- Send a package via bot — still delivers correctly
- Album groups unchanged
- Manual groups unchanged
