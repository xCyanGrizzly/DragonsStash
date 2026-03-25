# Search Match Indicators, Size Limit Increase, Skipped/Failed Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add search match indicators to the STL files table, raise the ingestion size limit to 200 GB, and track skipped/failed archives with a retry UI.

**Architecture:** Three independent features sharing one migration. Feature 1 (size limit) is a one-line config change. Feature 2 (search indicators) modifies `searchPackages()` to return per-package match counts and pipes that through to the table and file drawer. Feature 3 (skipped files) adds a new `SkippedPackage` model, worker-side recording, and a UI tab with retry capability.

**Tech Stack:** Prisma 7.4, Next.js 16 (App Router), TanStack Table, shadcn/ui, TypeScript 5.9

**Spec:** `docs/superpowers/specs/2026-03-24-search-indicators-size-limit-skipped-files-design.md`

---

## File Structure

### Create
- `src/app/(app)/stls/_components/skipped-packages-tab.tsx` — Skipped/failed packages table with retry buttons
- `src/app/(app)/stls/_components/skipped-columns.tsx` — Column definitions for skipped packages table

### Modify
- `worker/src/util/config.ts` — Raise default `maxZipSizeMB` from 4096 to 204800
- `prisma/schema.prisma` — Add `SkipReason` enum, `SkippedPackage` model, reverse relations
- `worker/src/worker.ts` — Add `accountId` to `PipelineContext`, record skips/failures, clean up on success
- `worker/src/db/queries.ts` — Add `upsertSkippedPackage()` and `deleteSkippedPackage()` functions
- `src/lib/telegram/types.ts` — Add `matchedFileCount`/`matchedByContent` to `PackageListItem`, add `SkippedPackageItem` type
- `src/lib/telegram/queries.ts` — Modify `searchPackages()` for grouped counts, add skipped package queries
- `src/app/(app)/stls/page.tsx` — Pass search term, fetch skipped count
- `src/app/(app)/stls/_components/stl-table.tsx` — Accept search prop, pass to columns/drawer, add tabs
- `src/app/(app)/stls/_components/package-columns.tsx` — Add `matchedFileCount`/`matchedByContent` to `PackageRow`, render match badge
- `src/app/(app)/stls/_components/package-files-drawer.tsx` — Accept `highlightTerm`, highlight matching files, auto-expand matched folders
- `src/app/(app)/stls/actions.ts` — Add retry server actions

---

## Task 1: Raise Ingestion Size Limit

**Files:**
- Modify: `worker/src/util/config.ts:6`

- [ ] **Step 1: Change the default max size**

In `worker/src/util/config.ts`, change line 6:

```typescript
// Before:
maxZipSizeMB: parseInt(process.env.WORKER_MAX_ZIP_SIZE_MB ?? "4096", 10),
// After:
maxZipSizeMB: parseInt(process.env.WORKER_MAX_ZIP_SIZE_MB ?? "204800", 10),
```

- [ ] **Step 2: Verify worker builds**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/src/util/config.ts
git commit -m "feat: raise default ingestion size limit from 4GB to 200GB"
```

---

## Task 2: Prisma Schema — SkippedPackage Model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add SkipReason enum and SkippedPackage model**

Add after the `ArchiveExtractRequest` model (end of file area) in `prisma/schema.prisma`:

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

- [ ] **Step 2: Add reverse relations to existing models**

In `TelegramAccount` model (line ~401-418), add inside the relations block (after `fetchRequests`):

```prisma
  skippedPackages SkippedPackage[]
```

In `TelegramChannel` model (line ~420-437), add inside the relations block (after `packages`):

```prisma
  skippedPackages SkippedPackage[]
```

- [ ] **Step 3: Generate Prisma client and verify**

Run: `npx prisma generate`
Expected: Success, no errors

- [ ] **Step 4: Create migration**

Run: `npx prisma migrate dev --name add-skipped-packages`
Expected: Migration created successfully

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat: add SkippedPackage model for tracking skipped/failed archives"
```

---

## Task 3: Worker — Record Skipped/Failed Archives

**Files:**
- Modify: `worker/src/db/queries.ts`
- Modify: `worker/src/worker.ts:279-298` (PipelineContext), `worker/src/worker.ts:436-448` (pipelineCtx creation), `worker/src/worker.ts:781-802` (size guard), `worker/src/worker.ts:726-732` (set failure catch)

- [ ] **Step 1: Add worker DB functions for skipped packages**

In `worker/src/db/queries.ts`, add these functions:

```typescript
export async function upsertSkippedPackage(data: {
  fileName: string;
  fileSize: bigint;
  reason: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
  errorMessage?: string;
  sourceChannelId: string;
  sourceMessageId: bigint;
  sourceTopicId?: bigint | null;
  isMultipart: boolean;
  partCount: number;
  accountId: string;
}) {
  return db.skippedPackage.upsert({
    where: {
      sourceChannelId_sourceMessageId: {
        sourceChannelId: data.sourceChannelId,
        sourceMessageId: data.sourceMessageId,
      },
    },
    update: {
      reason: data.reason,
      errorMessage: data.errorMessage ?? null,
      fileName: data.fileName,
      fileSize: data.fileSize,
      createdAt: new Date(),
    },
    create: {
      fileName: data.fileName,
      fileSize: data.fileSize,
      reason: data.reason,
      errorMessage: data.errorMessage ?? null,
      sourceChannelId: data.sourceChannelId,
      sourceMessageId: data.sourceMessageId,
      sourceTopicId: data.sourceTopicId ?? null,
      isMultipart: data.isMultipart,
      partCount: data.partCount,
      accountId: data.accountId,
    },
  });
}

export async function deleteSkippedPackage(
  sourceChannelId: string,
  sourceMessageId: bigint
) {
  return db.skippedPackage.deleteMany({
    where: { sourceChannelId, sourceMessageId },
  });
}
```

- [ ] **Step 2: Add `accountId` to PipelineContext**

In `worker/src/worker.ts`, add `accountId` to the `PipelineContext` interface (line ~279-298):

```typescript
interface PipelineContext {
  client: Client;
  runId: string;
  accountId: string; // <-- ADD THIS
  channelTitle: string;
  channel: TelegramChannel;
  // ... rest unchanged
}
```

And add it to the `pipelineCtx` creation (line ~436-448):

```typescript
const pipelineCtx: PipelineContext = {
  client,
  runId: activeRunId,
  accountId: account.id, // <-- ADD THIS
  channelTitle: channel.title,
  // ... rest unchanged
};
```

- [ ] **Step 3: Record SIZE_LIMIT skips**

In `worker/src/worker.ts` at the size guard (line ~784-802), after the `updateRunActivity` call and before the `return`, add:

```typescript
    await upsertSkippedPackage({
      fileName: archiveName,
      fileSize: totalArchiveSize,
      reason: "SIZE_LIMIT",
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId: ctx.sourceTopicId,
      isMultipart: archiveSet.isMultipart,
      partCount: archiveSet.parts.length,
      accountId: ctx.accountId,
    });
```

Add the import at top of worker.ts:
```typescript
import { upsertSkippedPackage, deleteSkippedPackage } from "./db/queries.js";
```

- [ ] **Step 4: Record processing failures in the catch block**

In `worker/src/worker.ts` at the archive set failure catch (the `processArchiveSets` function, line ~726-732), enhance the catch block:

```typescript
    } catch (setErr) {
      // If a set fails, do NOT advance the watermark past it
      accountLog.warn(
        { err: setErr, baseName: archiveSets[setIdx].baseName },
        "Archive set failed, watermark will not advance past this set"
      );
      // Record the failure for visibility in the UI
      try {
        const archiveSet = archiveSets[setIdx];
        const totalSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);
        await upsertSkippedPackage({
          fileName: archiveSet.parts[0].fileName,
          fileSize: totalSize,
          reason: "DOWNLOAD_FAILED", // Catch-all for any pipeline failure at this level
          errorMessage: setErr instanceof Error ? setErr.message : String(setErr),
          sourceChannelId: ctx.channel.id,
          sourceMessageId: archiveSet.parts[0].id,
          sourceTopicId: ctx.sourceTopicId,
          isMultipart: archiveSet.isMultipart,
          partCount: archiveSet.parts.length,
          accountId: ctx.accountId,
        });
      } catch {
        // Best-effort — don't fail the run if skip recording fails
      }
    }
```

- [ ] **Step 5: Clean up skip records on successful ingestion**

In `worker/src/worker.ts`, in `processOneArchiveSet`, after the `createPackageWithFiles` call succeeds (near the end of the function where `counters.zipsIngested++` is), add:

```typescript
      // Clean up any prior skip record for this archive
      await deleteSkippedPackage(channel.id, archiveSet.parts[0].id);
```

- [ ] **Step 6: Verify worker builds**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add worker/src/db/queries.ts worker/src/worker.ts
git commit -m "feat: record skipped/failed archives in database for UI visibility"
```

---

## Task 4: Search Match Indicators — Backend

**Files:**
- Modify: `src/lib/telegram/types.ts:1-17`
- Modify: `src/lib/telegram/queries.ts:165-257`

- [ ] **Step 1: Add match fields to PackageListItem**

In `src/lib/telegram/types.ts`, add to the `PackageListItem` interface (after `sourceChannel`):

```typescript
  matchedFileCount: number;
  matchedByContent: boolean;
```

- [ ] **Step 2: Update listPackages to include default match fields**

In `src/lib/telegram/queries.ts`, in the `listPackages` function's mapping (line ~47-60), add the two default fields:

```typescript
  const mapped: PackageListItem[] = items.map((pkg) => ({
    // ... existing fields ...
    sourceChannel: pkg.sourceChannel,
    matchedFileCount: 0,
    matchedByContent: false,
  }));
```

- [ ] **Step 3: Rewrite searchPackages to return match counts**

Replace the `searchPackages` function in `src/lib/telegram/queries.ts` (lines 165-257):

```typescript
export async function searchPackages(options: {
  query: string;
  page: number;
  limit: number;
  searchIn: "packages" | "files" | "both";
}) {
  const q = options.query;

  if (options.searchIn === "files" || options.searchIn === "both") {
    // Get per-package file match counts
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

    const fileMatchMap = new Map(
      fileMatches.map((m) => [m.packageId, m._count._all])
    );
    const fileMatchedIds = fileMatches.map((f) => f.packageId);

    const packageNameIds =
      options.searchIn === "both"
        ? (
            await prisma.package.findMany({
              where: { fileName: { contains: q, mode: "insensitive" } },
              select: { id: true },
            })
          ).map((p) => p.id)
        : [];

    const allIds = [...new Set([...fileMatchedIds, ...packageNameIds])];

    const [items, total] = await Promise.all([
      prisma.package.findMany({
        where: { id: { in: allIds } },
        orderBy: { indexedAt: "desc" },
        skip: (options.page - 1) * options.limit,
        take: options.limit,
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          contentHash: true,
          archiveType: true,
          fileCount: true,
          isMultipart: true,
          indexedAt: true,
          creator: true,
          tags: true,
          previewData: true,
          sourceChannel: { select: { id: true, title: true } },
        },
      }),
      Promise.resolve(allIds.length),
    ]);

    const mapped: PackageListItem[] = items.map((pkg) => ({
      id: pkg.id,
      fileName: pkg.fileName,
      fileSize: pkg.fileSize.toString(),
      contentHash: pkg.contentHash,
      archiveType: pkg.archiveType,
      fileCount: pkg.fileCount,
      isMultipart: pkg.isMultipart,
      hasPreview: pkg.previewData !== null,
      creator: pkg.creator,
      tags: pkg.tags,
      indexedAt: pkg.indexedAt.toISOString(),
      sourceChannel: pkg.sourceChannel,
      matchedFileCount: fileMatchMap.get(pkg.id) ?? 0,
      matchedByContent: fileMatchMap.has(pkg.id),
    }));

    return {
      items: mapped,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    };
  }

  // Search packages only
  return listPackages({
    page: options.page,
    limit: options.limit,
    sortBy: "indexedAt",
    order: "desc",
  });
}
```

- [ ] **Step 4: Verify app builds**

Run: `npx tsc --noEmit` (from project root)
Expected: Errors about `PackageRow` missing the new fields — this is expected, we fix it in the next task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/telegram/types.ts src/lib/telegram/queries.ts
git commit -m "feat: return per-package file match counts from searchPackages"
```

---

## Task 5: Search Match Indicators — Frontend (Table)

**Files:**
- Modify: `src/app/(app)/stls/page.tsx:25-53`
- Modify: `src/app/(app)/stls/_components/stl-table.tsx:26-32, 34-40, 78-110, 116-168`
- Modify: `src/app/(app)/stls/_components/package-columns.tsx:10-26, 28-32, 61-65, 75-88`

- [ ] **Step 1: Add match fields to PackageRow**

In `src/app/(app)/stls/_components/package-columns.tsx`, add to the `PackageRow` interface (after `sourceChannel`, line ~22-26):

```typescript
  matchedFileCount: number;
  matchedByContent: boolean;
```

- [ ] **Step 2: Add searchTerm to PackageColumnsProps and render match badge**

In `src/app/(app)/stls/_components/package-columns.tsx`, add `searchTerm` to `PackageColumnsProps` (line ~28-32):

```typescript
interface PackageColumnsProps {
  onViewFiles: (pkg: PackageRow) => void;
  onSetCreator: (pkg: PackageRow) => void;
  onSetTags: (pkg: PackageRow) => void;
  searchTerm: string;
}
```

Update the `getPackageColumns` destructuring to include `searchTerm`:

```typescript
export function getPackageColumns({
  onViewFiles,
  onSetCreator,
  onSetTags,
  searchTerm,
}: PackageColumnsProps): ColumnDef<PackageRow, unknown>[] {
```

Update the `fileName` column cell (line ~78-88) to render the match badge:

```typescript
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File Name" />,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate max-w-[300px]">{row.original.fileName}</span>
            {row.original.isMultipart && (
              <Badge variant="outline" className="text-[10px] shrink-0">
                Multi
              </Badge>
            )}
          </div>
          {searchTerm && row.original.matchedByContent && (
            <button
              className="text-[11px] text-amber-500 hover:text-amber-400 hover:underline cursor-pointer mt-0.5"
              onClick={() => onViewFiles(row.original)}
            >
              {row.original.matchedFileCount.toLocaleString()} file match{row.original.matchedFileCount !== 1 ? "es" : ""}
            </button>
          )}
        </div>
      ),
      enableHiding: false,
    },
```

- [ ] **Step 3: Pass searchTerm from page to StlTable**

In `src/app/(app)/stls/page.tsx`, pass `search` to `StlTable` (line ~45-53):

```typescript
  return (
    <StlTable
      data={result.items}
      pageCount={result.pagination.totalPages}
      totalCount={result.pagination.total}
      ingestionStatus={ingestionStatus}
      availableTags={availableTags}
      searchTerm={search}
    />
  );
```

- [ ] **Step 4: Accept searchTerm in StlTable and pipe to columns/drawer**

In `src/app/(app)/stls/_components/stl-table.tsx`:

Add `searchTerm` to `StlTableProps` (line ~26-32):

```typescript
interface StlTableProps {
  data: PackageRow[];
  pageCount: number;
  totalCount: number;
  ingestionStatus: IngestionAccountStatus[];
  availableTags: string[];
  searchTerm: string;
}
```

Add `searchTerm` to the destructured props (line ~34-40):

```typescript
export function StlTable({
  data,
  pageCount,
  totalCount,
  ingestionStatus,
  availableTags,
  searchTerm,
}: StlTableProps) {
```

Pass `searchTerm` to `getPackageColumns` (line ~78):

```typescript
  const columns = getPackageColumns({
    onViewFiles: (pkg) => setViewPkg(pkg),
    // ... existing handlers unchanged ...
    searchTerm,
  });
```

**Note:** Do NOT pass `highlightTerm` to `PackageFilesDrawer` yet — that prop is added in Task 6. It will be wired in Task 6 Step 1 as part of updating the drawer.

- [ ] **Step 5: Verify app builds**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/app/(app)/stls/page.tsx src/app/(app)/stls/_components/stl-table.tsx src/app/(app)/stls/_components/package-columns.tsx
git commit -m "feat: show file match count badge in search results"
```

---

## Task 6: Search Match Indicators — File Drawer Highlighting

**Files:**
- Modify: `src/app/(app)/stls/_components/package-files-drawer.tsx:51-55, 118-128, 186-210, 226, 477-504`

- [ ] **Step 1: Add highlightTerm to PackageFilesDrawerProps**

In `src/app/(app)/stls/_components/package-files-drawer.tsx`, update the props interface (line ~51-55):

```typescript
interface PackageFilesDrawerProps {
  pkg: PackageRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightTerm?: string;
}
```

Update the component signature (line ~226):

```typescript
export function PackageFilesDrawer({ pkg, open, onOpenChange, highlightTerm }: PackageFilesDrawerProps) {
```

- [ ] **Step 2: Add a helper to check if a file matches the highlight term**

Add a helper function near the top of the file (after the `getExtBadgeClass` function):

```typescript
function fileMatchesHighlight(file: FileItem, term: string): boolean {
  if (!term) return false;
  const lower = term.toLowerCase();
  return (
    file.fileName.toLowerCase().includes(lower) ||
    file.path.toLowerCase().includes(lower)
  );
}
```

- [ ] **Step 3: Add highlight term to TreeNodeView props and highlight matching files**

Update the `TreeNodeView` props to accept `highlightTerm` (line ~118-128):

```typescript
function TreeNodeView({
  node,
  depth,
  search,
  defaultOpen,
  highlightTerm,
}: {
  node: TreeNode;
  depth: number;
  search: string;
  defaultOpen: boolean;
  highlightTerm?: string;
}) {
```

Add a helper inside `TreeNodeView` to check if a subtree contains highlighted files:

```typescript
  const hasHighlightedDescendant = useMemo(() => {
    if (!highlightTerm) return false;
    function check(n: TreeNode): boolean {
      if (n.file && fileMatchesHighlight(n.file, highlightTerm!)) return true;
      for (const child of n.children.values()) {
        if (check(child)) return true;
      }
      return false;
    }
    return check(node);
  }, [node, highlightTerm]);
```

Update the `useEffect` for auto-expanding to also expand when there are highlighted descendants (line ~141-143):

```typescript
  useEffect(() => {
    if (search || hasHighlightedDescendant) setOpen(true);
  }, [search, hasHighlightedDescendant]);
```

In the file node rendering (line ~186-210), add a highlight class when the file matches:

```typescript
  // File node
  if (node.file) {
    const isHighlighted = highlightTerm ? fileMatchesHighlight(node.file, highlightTerm) : false;
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-1 py-1 transition-colors",
          isHighlighted
            ? "bg-amber-500/15 hover:bg-amber-500/20"
            : "hover:bg-muted/50"
        )}
        style={{ paddingLeft: `${Math.max(0, depth) * 16 + 4}px` }}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm truncate flex-1 min-w-0" title={node.file.path}>
          {node.name}
        </span>
        {node.file.extension && (
          <Badge
            variant="outline"
            className={`text-[10px] shrink-0 ${getExtBadgeClass(node.file.extension)}`}
          >
            .{node.file.extension}
          </Badge>
        )}
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {formatBytes(node.file.uncompressedSize)}
        </span>
      </div>
    );
  }
```

Pass `highlightTerm` through recursive `TreeNodeView` calls (line ~173-181):

```typescript
        {open &&
          sortedChildren.map((child) => (
            <TreeNodeView
              key={child.name}
              node={child}
              depth={depth + 1}
              search={search}
              defaultOpen={depth < 1}
              highlightTerm={highlightTerm}
            />
          ))}
```

- [ ] **Step 4: Pass highlightTerm to TreeNodeView from the main render**

In the `PackageFilesDrawer` component, where `TreeNodeView` is rendered for root children (line ~468-475):

```typescript
                    <TreeNodeView
                      key={child.name}
                      node={child}
                      depth={0}
                      search={search}
                      defaultOpen={true}
                      highlightTerm={highlightTerm}
                    />
```

- [ ] **Step 5: Add highlighting to the flat list render path too**

In the flat list render path (line ~477-504), add the same highlight logic:

```typescript
              {filtered.map((file) => {
                const isHighlighted = highlightTerm ? fileMatchesHighlight(file, highlightTerm) : false;
                return (
                  <div
                    key={file.id}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors",
                      isHighlighted
                        ? "bg-amber-500/15 hover:bg-amber-500/20"
                        : "hover:bg-muted/50"
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate" title={file.path}>
                        {file.fileName}
                      </p>
                    </div>
                    {file.extension && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] shrink-0 ${getExtBadgeClass(file.extension)}`}
                      >
                        .{file.extension}
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                      {formatBytes(file.uncompressedSize)}
                    </span>
                  </div>
                );
              })}
```

- [ ] **Step 6: Wire highlightTerm prop in StlTable**

In `src/app/(app)/stls/_components/stl-table.tsx`, update the `PackageFilesDrawer` usage to pass the prop:

```typescript
      <PackageFilesDrawer
        pkg={viewPkg}
        open={!!viewPkg}
        onOpenChange={(open) => {
          if (!open) setViewPkg(null);
        }}
        highlightTerm={searchTerm}
      />
```

- [ ] **Step 7: Verify app builds and lint passes**

Run: `npm run build && npm run lint`
Expected: Both pass

- [ ] **Step 8: Commit**

```bash
git add src/app/(app)/stls/_components/package-files-drawer.tsx src/app/(app)/stls/_components/stl-table.tsx
git commit -m "feat: highlight matching files in package drawer when opened from search"
```

---

## Task 7: Skipped/Failed Packages — App Queries & Types

**Files:**
- Modify: `src/lib/telegram/types.ts`
- Modify: `src/lib/telegram/queries.ts`

- [ ] **Step 1: Add SkippedPackageItem type**

In `src/lib/telegram/types.ts`, add after the `PackageFileItem` interface:

```typescript
export interface SkippedPackageItem {
  id: string;
  fileName: string;
  fileSize: string;
  reason: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
  errorMessage: string | null;
  sourceChannel: {
    id: string;
    title: string;
  };
  sourceMessageId: string;
  isMultipart: boolean;
  partCount: number;
  createdAt: string;
}
```

- [ ] **Step 2: Add query functions for skipped packages**

In `src/lib/telegram/queries.ts`, add these functions:

```typescript
export async function listSkippedPackages(options: {
  page: number;
  limit: number;
  reason?: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
}) {
  const where: Record<string, unknown> = {};
  if (options.reason) where.reason = options.reason;

  const [items, total] = await Promise.all([
    prisma.skippedPackage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      include: {
        sourceChannel: { select: { id: true, title: true } },
      },
    }),
    prisma.skippedPackage.count({ where }),
  ]);

  const mapped: SkippedPackageItem[] = items.map((s) => ({
    id: s.id,
    fileName: s.fileName,
    fileSize: s.fileSize.toString(),
    reason: s.reason,
    errorMessage: s.errorMessage,
    sourceChannel: s.sourceChannel,
    sourceMessageId: s.sourceMessageId.toString(),
    isMultipart: s.isMultipart,
    partCount: s.partCount,
    createdAt: s.createdAt.toISOString(),
  }));

  return {
    items: mapped,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}

export async function countSkippedPackages(): Promise<number> {
  return prisma.skippedPackage.count();
}
```

Add `SkippedPackageItem` to the import in queries.ts:

```typescript
import type {
  PackageListItem,
  PackageDetail,
  PackageFileItem,
  IngestionAccountStatus,
  SkippedPackageItem,
} from "./types";
```

- [ ] **Step 3: Verify app builds**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/telegram/types.ts src/lib/telegram/queries.ts
git commit -m "feat: add query functions for listing skipped/failed packages"
```

---

## Task 8: Skipped/Failed Packages — Retry Server Actions

**Files:**
- Modify: `src/app/(app)/stls/actions.ts`

- [ ] **Step 1: Add retry server actions**

In `src/app/(app)/stls/actions.ts`, add:

```typescript
export async function retrySkippedPackageAction(
  id: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const skipped = await prisma.skippedPackage.findUnique({
      where: { id },
    });
    if (!skipped) return { success: false, error: "Skipped package not found" };

    // Find the AccountChannelMap and reset watermark if needed
    const mapping = await prisma.accountChannelMap.findUnique({
      where: {
        accountId_channelId: {
          accountId: skipped.accountId,
          channelId: skipped.sourceChannelId,
        },
      },
    });

    if (mapping) {
      const targetId = skipped.sourceMessageId - 1n;

      // Only reset if the watermark is past this message
      if (mapping.lastProcessedMessageId && mapping.lastProcessedMessageId >= skipped.sourceMessageId) {
        await prisma.accountChannelMap.update({
          where: { id: mapping.id },
          data: { lastProcessedMessageId: targetId },
        });
      }

      // Also reset TopicProgress if this was a forum topic message
      if (skipped.sourceTopicId) {
        const topicProgress = await prisma.topicProgress.findFirst({
          where: {
            accountChannelMapId: mapping.id,
            topicId: skipped.sourceTopicId,
          },
        });
        if (topicProgress && topicProgress.lastProcessedMessageId && topicProgress.lastProcessedMessageId >= skipped.sourceMessageId) {
          await prisma.topicProgress.update({
            where: { id: topicProgress.id },
            data: { lastProcessedMessageId: targetId },
          });
        }
      }
    }

    // Delete the skip record
    await prisma.skippedPackage.delete({ where: { id } });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to retry skipped package" };
  }
}

export async function retryAllSkippedPackagesAction(
  reason?: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED"
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const where: Record<string, unknown> = {};
    if (reason) where.reason = reason;

    const skippedItems = await prisma.skippedPackage.findMany({ where });

    if (skippedItems.length === 0) {
      return { success: true, data: undefined };
    }

    // Group by (accountId, channelId) to find minimum messageId per channel
    const channelResets = new Map<string, { mappingKey: { accountId: string; channelId: string }; minMessageId: bigint; topicResets: Map<bigint, bigint> }>();

    for (const item of skippedItems) {
      const key = `${item.accountId}:${item.sourceChannelId}`;
      const existing = channelResets.get(key);
      const targetId = item.sourceMessageId - 1n;

      if (!existing) {
        const topicResets = new Map<bigint, bigint>();
        if (item.sourceTopicId) {
          topicResets.set(item.sourceTopicId, targetId);
        }
        channelResets.set(key, {
          mappingKey: { accountId: item.accountId, channelId: item.sourceChannelId },
          minMessageId: targetId,
          topicResets,
        });
      } else {
        if (targetId < existing.minMessageId) {
          existing.minMessageId = targetId;
        }
        if (item.sourceTopicId) {
          const existingTopic = existing.topicResets.get(item.sourceTopicId);
          if (!existingTopic || targetId < existingTopic) {
            existing.topicResets.set(item.sourceTopicId, targetId);
          }
        }
      }
    }

    // Reset watermarks
    for (const reset of channelResets.values()) {
      const mapping = await prisma.accountChannelMap.findUnique({
        where: { accountId_channelId: reset.mappingKey },
      });
      if (!mapping) continue;

      if (mapping.lastProcessedMessageId && mapping.lastProcessedMessageId > reset.minMessageId) {
        await prisma.accountChannelMap.update({
          where: { id: mapping.id },
          data: { lastProcessedMessageId: reset.minMessageId },
        });
      }

      // Reset topic progress
      for (const [topicId, targetId] of reset.topicResets) {
        const topicProgress = await prisma.topicProgress.findFirst({
          where: { accountChannelMapId: mapping.id, topicId },
        });
        if (topicProgress && topicProgress.lastProcessedMessageId && topicProgress.lastProcessedMessageId > targetId) {
          await prisma.topicProgress.update({
            where: { id: topicProgress.id },
            data: { lastProcessedMessageId: targetId },
          });
        }
      }
    }

    // Delete all matching skip records
    await prisma.skippedPackage.deleteMany({ where });

    revalidatePath("/stls");
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to retry skipped packages" };
  }
}
```

- [ ] **Step 2: Verify app builds**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/(app)/stls/actions.ts
git commit -m "feat: add retry server actions for skipped/failed packages"
```

---

## Task 9: Skipped/Failed Packages — UI Components

**Files:**
- Create: `src/app/(app)/stls/_components/skipped-columns.tsx`
- Create: `src/app/(app)/stls/_components/skipped-packages-tab.tsx`

- [ ] **Step 1: Create skipped package column definitions**

Create `src/app/(app)/stls/_components/skipped-columns.tsx`:

```typescript
"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface SkippedRow {
  id: string;
  fileName: string;
  fileSize: string;
  reason: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
  errorMessage: string | null;
  sourceChannel: { id: string; title: string };
  isMultipart: boolean;
  partCount: number;
  createdAt: string;
}

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const REASON_LABELS: Record<SkippedRow["reason"], { label: string; variant: "default" | "destructive" | "outline" | "secondary" }> = {
  SIZE_LIMIT: { label: "Size Limit", variant: "secondary" },
  DOWNLOAD_FAILED: { label: "Download Failed", variant: "destructive" },
  EXTRACT_FAILED: { label: "Extract Failed", variant: "destructive" },
  UPLOAD_FAILED: { label: "Upload Failed", variant: "destructive" },
};

export function getSkippedColumns({
  onRetry,
}: {
  onRetry: (row: SkippedRow) => void;
}): ColumnDef<SkippedRow, unknown>[] {
  return [
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate max-w-[300px]">{row.original.fileName}</span>
          {row.original.isMultipart && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {row.original.partCount} parts
            </Badge>
          )}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "fileSize",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatBytes(row.original.fileSize)}
        </span>
      ),
    },
    {
      accessorKey: "reason",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
      cell: ({ row }) => {
        const { label, variant } = REASON_LABELS[row.original.reason];
        return <Badge variant={variant} className="text-[10px]">{label}</Badge>;
      },
    },
    {
      accessorKey: "errorMessage",
      header: "Error",
      cell: ({ row }) => {
        const msg = row.original.errorMessage;
        if (!msg) return <span className="text-sm text-muted-foreground">{"\u2014"}</span>;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm text-muted-foreground truncate max-w-[200px] block cursor-help">
                {msg}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <p className="text-xs break-all">{msg}</p>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "channel",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground truncate max-w-[160px] block">
          {row.original.sourceChannel.title}
        </span>
      ),
      accessorFn: (row) => row.sourceChannel.title,
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Skipped" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onRetry(row.original)}
          title="Retry this package"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      ),
      enableHiding: false,
    },
  ];
}
```

- [ ] **Step 2: Create skipped packages tab component**

Create `src/app/(app)/stls/_components/skipped-packages-tab.tsx`:

```typescript
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import { getSkippedColumns, type SkippedRow } from "./skipped-columns";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { Button } from "@/components/ui/button";
import { retrySkippedPackageAction, retryAllSkippedPackagesAction } from "../actions";

interface SkippedPackagesTabProps {
  data: SkippedRow[];
  pageCount: number;
  totalCount: number;
}

export function SkippedPackagesTab({
  data,
  pageCount,
  totalCount,
}: SkippedPackagesTabProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const columns = getSkippedColumns({
    onRetry: (row) => {
      startTransition(async () => {
        const result = await retrySkippedPackageAction(row.id);
        if (result.success) {
          toast.success(`"${row.fileName}" queued for retry`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
  });

  const { table } = useDataTable({ data, columns, pageCount });

  return (
    <div className="space-y-4">
      {totalCount > 0 && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await retryAllSkippedPackagesAction();
                if (result.success) {
                  toast.success(`All ${totalCount} skipped packages queued for retry`);
                  router.refresh();
                } else {
                  toast.error(result.error);
                }
              });
            }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry All ({totalCount})
          </Button>
        </div>
      )}
      <DataTable
        table={table}
        emptyMessage="No skipped or failed packages."
      />
      <DataTablePagination table={table} totalCount={totalCount} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(app)/stls/_components/skipped-columns.tsx src/app/(app)/stls/_components/skipped-packages-tab.tsx
git commit -m "feat: add skipped/failed packages table UI components"
```

---

## Task 10: Wire Up Tabs in STL Page

**Files:**
- Modify: `src/app/(app)/stls/page.tsx`
- Modify: `src/app/(app)/stls/_components/stl-table.tsx`

- [ ] **Step 1: Fetch skipped packages data in page.tsx**

In `src/app/(app)/stls/page.tsx`, update imports and data fetching:

```typescript
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listPackages, searchPackages, getIngestionStatus, getAllPackageTags, listSkippedPackages, countSkippedPackages } from "@/lib/telegram/queries";
import { StlTable } from "./_components/stl-table";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StlFilesPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;

  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const sort = (params.sort as string) ?? "indexedAt";
  const order = (params.order as "asc" | "desc") ?? "desc";
  const search = (params.search as string) ?? "";
  const creator = (params.creator as string) || undefined;
  const tag = (params.tag as string) || undefined;
  const tab = (params.tab as string) ?? "packages";

  // Fetch packages, ingestion status, tags, and skipped count in parallel
  const [result, ingestionStatus, availableTags, skippedCount] = await Promise.all([
    search
      ? searchPackages({
          query: search,
          page,
          limit: perPage,
          searchIn: "both",
        })
      : listPackages({
          page,
          limit: perPage,
          creator,
          tag,
          sortBy: sort as "indexedAt" | "fileName" | "fileSize",
          order,
        }),
    getIngestionStatus(),
    getAllPackageTags(),
    countSkippedPackages(),
  ]);

  // Fetch skipped packages only if on that tab
  const skippedResult = tab === "skipped"
    ? await listSkippedPackages({ page, limit: perPage })
    : null;

  return (
    <StlTable
      data={result.items}
      pageCount={result.pagination.totalPages}
      totalCount={result.pagination.total}
      ingestionStatus={ingestionStatus}
      availableTags={availableTags}
      searchTerm={search}
      skippedData={skippedResult?.items ?? []}
      skippedPageCount={skippedResult?.pagination.totalPages ?? 0}
      skippedTotalCount={skippedCount}
    />
  );
}
```

- [ ] **Step 2: Add tabs to StlTable**

In `src/app/(app)/stls/_components/stl-table.tsx`, add the tab UI. Update imports:

```typescript
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { SkippedPackagesTab } from "./skipped-packages-tab";
import type { SkippedRow } from "./skipped-columns";
```

Update props:

```typescript
interface StlTableProps {
  data: PackageRow[];
  pageCount: number;
  totalCount: number;
  ingestionStatus: IngestionAccountStatus[];
  availableTags: string[];
  searchTerm: string;
  skippedData: SkippedRow[];
  skippedPageCount: number;
  skippedTotalCount: number;
}
```

Update the component to use tabs. The return JSX should become:

```typescript
  const activeTab = searchParams.get("tab") ?? "packages";

  const updateTab = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "packages") {
        params.delete("tab");
      } else {
        params.set("tab", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="STL Files"
        description="Browse indexed archive packages from Telegram channels"
      >
        <IngestionStatus initialStatus={ingestionStatus} />
      </PageHeader>

      <Tabs value={activeTab} onValueChange={updateTab}>
        <TabsList>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="skipped" className="gap-1.5">
            Skipped / Failed
            {skippedTotalCount > 0 && (
              <Badge variant="secondary" className="text-[10px] ml-1">
                {skippedTotalCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="packages" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search packages or files..."
                value={searchValue}
                onChange={(e) => updateSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            {availableTags.length > 0 && (
              <Select value={activeTag || "all"} onValueChange={updateTagFilter}>
                <SelectTrigger className="w-[160px] h-9">
                  <SelectValue placeholder="All Tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tags</SelectItem>
                  {availableTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DataTableViewOptions table={table} />
          </div>

          <DataTable
            table={table}
            emptyMessage="No packages found. Archives will appear here after ingestion."
          />
          <DataTablePagination table={table} totalCount={totalCount} />
        </TabsContent>

        <TabsContent value="skipped">
          <SkippedPackagesTab
            data={skippedData}
            pageCount={skippedPageCount}
            totalCount={skippedTotalCount}
          />
        </TabsContent>
      </Tabs>

      <PackageFilesDrawer
        pkg={viewPkg}
        open={!!viewPkg}
        onOpenChange={(open) => {
          if (!open) setViewPkg(null);
        }}
        highlightTerm={searchTerm}
      />
    </div>
  );
```

Make sure to add the new props to the destructured params and add the `updateTab` callback. Remove the old JSX that is now inside `TabsContent`.

- [ ] **Step 3: Verify the Tabs component exists**

Check if `@/components/ui/tabs` exists. If not, install it:

Run: `npx shadcn@latest add tabs` (if missing)

- [ ] **Step 4: Verify app builds and lint passes**

Run: `npm run build && npm run lint`
Expected: Both pass

- [ ] **Step 5: Commit**

```bash
git add src/app/(app)/stls/page.tsx src/app/(app)/stls/_components/stl-table.tsx
git commit -m "feat: add skipped/failed packages tab to STL files page"
```

---

## Task 11: Final Build Verification

- [ ] **Step 1: Full build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 2: Lint check**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Worker build check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Prisma generate check**

Run: `npx prisma generate`
Expected: Success
