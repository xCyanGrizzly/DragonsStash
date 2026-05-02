# Grouping Phase 1: Foundation + Time-Window Grouping

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Add grouping infrastructure (schema, enums, notifications model), an ungrouped staging queue in the UI, and time-window auto-grouping as the first automatic signal beyond album grouping.

**Architecture:** Schema changes lay the foundation. Ungrouped tab is a query filter. Time-window grouping runs as a post-processing pass after album grouping in the worker pipeline.

**Tech Stack:** Prisma schema + migration, worker TypeScript, Next.js App Router.

---

## Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration SQL

Add:
1. `GroupingSource` enum: `ALBUM`, `MANUAL`, `AUTO_TIME`, `AUTO_PATTERN`, `AUTO_REPLY`, `AUTO_ZIP`, `AUTO_CAPTION`
2. `groupingSource GroupingSource @default(MANUAL)` on `PackageGroup`
3. `SystemNotification` model with `type`, `severity`, `title`, `message`, `context` (Json), `isRead`
4. `NotificationType` enum: `HASH_MISMATCH`, `MISSING_PART`, `UPLOAD_FAILED`, `DOWNLOAD_FAILED`, `GROUPING_CONFLICT`, `INTEGRITY_AUDIT`
5. `NotificationSeverity` enum: `INFO`, `WARNING`, `ERROR`

Backfill: `UPDATE package_groups SET "groupingSource" = 'ALBUM' WHERE "mediaAlbumId" IS NOT NULL`

---

## Task 2: Ungrouped Staging Tab in STL Page

**Files:**
- Modify: `src/lib/telegram/queries.ts` — add `listUngroupedPackages()` query
- Modify: `src/app/(app)/stls/page.tsx` — add tab parameter support
- Modify: `src/app/(app)/stls/_components/stl-table.tsx` — add "Ungrouped" tab

Add a tab next to the existing "Skipped" tab that shows packages where `packageGroupId IS NULL`. Uses the existing `PackageListItem` type and table rendering. This gives users a clear view of files that need manual grouping.

---

## Task 3: Time-Window Auto-Grouping in Worker

**Files:**
- Create: `worker/src/grouping.ts` — add `processTimeWindowGroups()` after existing `processAlbumGroups()`
- Modify: `worker/src/worker.ts` — call time-window grouping after album grouping
- Modify: `worker/src/util/config.ts` — add `autoGroupTimeWindowMinutes` config

After album grouping completes, find remaining ungrouped packages from the same channel scan. Cluster packages whose `sourceMessageId` timestamps are within the configured window (default 5 minutes). Create groups for clusters of 2+ with `groupingSource = AUTO_TIME` and name derived from the common filename prefix or first file's base name.

---

## Task 4: Hash Verification After Split

**Files:**
- Modify: `worker/src/worker.ts` — add hash re-check after concat+split
- Modify: `worker/src/archive/hash.ts` — (no changes needed, reuse `hashParts`)

After `concatenateFiles()` + `byteLevelSplit()`, re-hash the split parts and compare to the original `contentHash`. If mismatch, log error and create a `SystemNotification` (once that table exists). This closes the integrity gap identified in the audit.

---

## Task 5: Build & Deploy

Rebuild worker and app images. Deploy. Verify:
- Worker logs show `maxPartSizeMB` and new `autoGroupTimeWindowMinutes` in config
- Ungrouped tab visible in STL page
- Previously-skipped large archives begin processing
