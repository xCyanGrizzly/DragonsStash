# Design: Search Match Indicators, Size Limit Increase, Skipped/Failed Files Overview

**Date:** 2026-03-24
**Status:** Approved

## Overview

Three related improvements to the STL packages system:

1. **Search match indicators** — Show which internal files matched a search query, with highlighted files in the drawer
2. **Size limit increase** — Raise the ingestion limit from 4 GB to 200 GB so large multipart archives aren't skipped
3. **Skipped/failed files overview** — Track and display archives that were skipped or failed, with retry capability

---

## Feature 1: Size Limit Increase

### Change

`worker/src/util/config.ts` line 6 — change default from `"4096"` to `"204800"`.

One-line change. The split/upload pipeline already handles arbitrary sizes. The 2 GB per-part Telegram API limit is a separate hard-coded constant and stays as-is.

### Impact

- Archives up to 200 GB will now be attempted
- Multipart archives where individual parts are under 2 GB (but total exceeds 4 GB) will no longer be skipped — these upload directly without any splitting
- Single files over 2 GB are automatically split into 2 GB parts (existing behavior)
- Temp disk usage during processing can now reach up to ~200 GB per archive

---

## Feature 2: Search Match Indicators

### Backend Changes

**File:** `src/lib/telegram/queries.ts` — `searchPackages()`

When `searchIn` is `"files"` or `"both"`, change the PackageFile query from `distinct` to a **grouped count**:

```typescript
// Current: findMany with select: { packageId }, distinct: ["packageId"]
// New: groupBy packageId with _count
const fileMatches = await prisma.packageFile.groupBy({
  by: ["packageId"],
  where: {
    OR: [
      { fileName: { contains: q, mode: "insensitive" } },
      { path: { contains: q, mode: "insensitive" } },
    ],
  },
  _count: { _all: true },
});
```

This returns `{ packageId: string, _count: { _all: number } }[]`.

Note: `PackageRow` in `package-columns.tsx` mirrors `PackageListItem` and must also receive the two new fields.

**File:** `src/lib/telegram/types.ts` — `PackageListItem`

Add two fields:
- `matchedFileCount: number` — how many files inside matched (0 if matched by package name only)
- `matchedByContent: boolean` — true if any files inside matched

### Frontend Changes

**File:** `src/app/(app)/stls/page.tsx`

Pass the search term to `StlTable` as a new prop.

**File:** `src/app/(app)/stls/_components/stl-table.tsx`

Pass search term to columns via TanStack Table column meta.

**File:** `src/app/(app)/stls/_components/package-columns.tsx`

When search is active and `matchedByContent` is true, render a clickable badge below the filename: e.g., "3 file matches". Clicking opens the `PackageFilesDrawer` with a `highlightTerm` prop set to the search term.

**File:** `src/app/(app)/stls/_components/package-files-drawer.tsx`

- Accept optional `highlightTerm: string` prop
- Render full file tree as normal (all files visible)
- Files whose `fileName` or `path` case-insensitively contains `highlightTerm` get a subtle highlight (amber/yellow background on the row)
- Auto-expand folders that contain highlighted files
- The drawer's own search input remains independent

### Data Flow

1. User types search term in STL table search input
2. URL updates with `?search=value`, page reloads
3. `page.tsx` calls `searchPackages()` with `searchIn: "both"`
4. Query returns packages with `matchedFileCount` and `matchedByContent`
5. Table renders "N file matches" badge on content-matched rows
6. User clicks badge -> drawer opens with full tree, matching files highlighted
7. Folders containing matches auto-expanded

---

## Feature 3: Skipped/Failed Files Overview

### Database Schema

New model in `prisma/schema.prisma`:

```prisma
enum SkipReason {
  SIZE_LIMIT
  DOWNLOAD_FAILED
  EXTRACT_FAILED
  UPLOAD_FAILED
}

model SkippedPackage {
  id              String           @id @default(cuid())
  fileName        String
  fileSize        BigInt
  reason          SkipReason
  errorMessage    String?
  sourceChannelId String
  sourceChannel   TelegramChannel  @relation(fields: [sourceChannelId], references: [id], onDelete: Cascade)
  sourceMessageId BigInt
  sourceTopicId   BigInt?
  isMultipart     Boolean          @default(false)
  partCount       Int              @default(1)
  accountId       String
  account         TelegramAccount  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  createdAt       DateTime         @default(now())

  @@unique([sourceChannelId, sourceMessageId])
  @@index([reason])
  @@index([accountId])
  @@map("skipped_packages")
}
```

Reverse relations must be added to `TelegramChannel` and `TelegramAccount` models:
```prisma
// In TelegramChannel:
skippedPackages SkippedPackage[]

// In TelegramAccount:
skippedPackages SkippedPackage[]
```

### Worker Changes

**File:** `worker/src/worker.ts`

Extend `PipelineContext` interface to include `accountId` (derived from the ingestion run's account).

At each skip/failure point, upsert a `SkippedPackage` record:

- **Size limit skip** (line 784): reason `SIZE_LIMIT`, no error message
- **Download failure** (catch in download loop): reason `DOWNLOAD_FAILED` + error text
- **Extract/metadata failure** (catch in extract): reason `EXTRACT_FAILED` + error text
- **Upload failure** (catch in upload): reason `UPLOAD_FAILED` + error text

On **successful ingestion** of a package, delete any existing `SkippedPackage` with the same `(sourceChannelId, sourceMessageId)` — so successful retries clean up after themselves.

**File:** `worker/src/db/queries.ts`

Add functions:
- `upsertSkippedPackage(data)` — create or update skip record
- `deleteSkippedPackage(sourceChannelId, sourceMessageId)` — remove on success

### Retry Mechanism

Retrying a skipped package:
1. Delete the `SkippedPackage` record
2. Find the `AccountChannelMap` record using both `accountId` and `sourceChannelId`, then reset its `lastProcessedMessageId` to `sourceMessageId - 1` (only if less than current watermark)
3. If `sourceTopicId` is non-null, also reset the corresponding `TopicProgress.lastProcessedMessageId` for that topic
4. The next ingestion cycle picks up the message and re-attempts processing

For "Retry All" (e.g., all `SIZE_LIMIT` skips after raising the limit):
- Delete all matching `SkippedPackage` records
- For each affected (account, channel) pair, reset `AccountChannelMap` watermark to the minimum `sourceMessageId - 1` among deleted records
- For each affected (account, channel, topic) triple, reset `TopicProgress` watermark similarly

**Note on behavioral distinction:** `DOWNLOAD_FAILED`, `EXTRACT_FAILED`, and `UPLOAD_FAILED` archives already naturally retry because the worker does not advance the watermark past failed sets. The `SkippedPackage` record provides visibility into these failures. The explicit retry/watermark reset is only strictly needed for `SIZE_LIMIT` skips (where the watermark does advance past the skipped message). The UI should present both types but the retry button is most impactful for `SIZE_LIMIT` skips.

**Performance note:** "Retry All" can cause the worker to re-scan large message ranges. The existing dedup logic (`packageExistsBySourceMessage`) ensures already-ingested packages are skipped quickly, but there is a scanning cost proportional to the number of messages between the reset watermark and the current position.

### Frontend Changes

**File:** `src/app/(app)/stls/_components/stl-table.tsx`

Add a "Skipped / Failed" tab alongside the main packages table.

**New file:** `src/app/(app)/stls/_components/skipped-packages-tab.tsx`

Table columns:
- **fileName** — archive name
- **fileSize** — formatted size
- **reason** — color-coded badge: `SIZE_LIMIT` (yellow), `DOWNLOAD_FAILED` (red), `EXTRACT_FAILED` (red), `UPLOAD_FAILED` (red)
- **errorMessage** — truncated with expandable tooltip/popover for full text
- **channel** — source channel title
- **createdAt** — when the skip/failure was recorded

Actions:
- **Retry** button per row — server action that deletes record + resets watermark
- **Retry All** button in the header — bulk retry, filterable by reason

**File:** `src/app/(app)/stls/page.tsx`

Fetch skipped packages count (for tab badge) alongside existing queries.

**File:** `src/data/` or `src/lib/telegram/queries.ts`

Add query functions:
- `listSkippedPackages(options)` — paginated list with reason filter
- `countSkippedPackages()` — for tab badge
- `retrySkippedPackage(id)` — delete record + reset watermark
- `retryAllSkippedPackages(reason?)` — bulk retry

**File:** `src/app/(app)/stls/actions.ts`

Add server actions:
- `retrySkippedPackageAction(id)`
- `retryAllSkippedPackagesAction(reason?)`

---

## Files to Create/Modify

### Create
- `src/app/(app)/stls/_components/skipped-packages-tab.tsx` — skipped packages table UI
- Prisma migration for `SkippedPackage` model

### Modify
- `worker/src/util/config.ts` — raise default max size
- `worker/src/worker.ts` — record skips/failures, clean up on success
- `worker/src/db/queries.ts` — add skip record CRUD functions
- `prisma/schema.prisma` — add `SkippedPackage` model and `SkipReason` enum
- `src/lib/telegram/queries.ts` — modify `searchPackages()` for match counts, add skipped package queries
- `src/lib/telegram/types.ts` — add `matchedFileCount`/`matchedByContent` to `PackageListItem`, add skipped package types
- `src/app/(app)/stls/page.tsx` — pass search term, fetch skipped count, add tab
- `src/app/(app)/stls/_components/stl-table.tsx` — accept search prop, render tabs
- `src/app/(app)/stls/_components/package-columns.tsx` — render match badge
- `src/app/(app)/stls/_components/package-files-drawer.tsx` — accept highlightTerm, highlight matching files, auto-expand matched folders
- `src/app/(app)/stls/actions.ts` — add retry server actions
