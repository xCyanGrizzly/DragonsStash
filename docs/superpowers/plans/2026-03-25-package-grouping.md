# Package Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group related packages that were posted together in Telegram so they appear as collapsible rows in the STL files table, with auto-detection via album IDs and manual grouping.

**Architecture:** New `PackageGroup` model links related `Package` records. The worker captures `media_album_id` during scanning and creates groups post-indexing. The app uses a two-step SQL query for paginated display items (groups + standalone packages). UI renders group rows with expand/collapse and supports manual group management.

**Tech Stack:** Prisma 7 (PostgreSQL), Next.js 16 (App Router, server components + server actions), TanStack Table, shadcn/ui, TDLib (tdl)

**Spec:** `docs/superpowers/specs/2026-03-25-package-grouping-design.md`

**Testing:** No test framework configured. Each task includes manual verification steps.

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `prisma/migrations/<timestamp>_add_package_groups/migration.sql` | Schema migration (auto-generated) |
| `src/app/api/groups/[id]/preview/route.ts` | Group preview image endpoint |
| `src/app/(app)/stls/_components/group-row.tsx` | Group row rendering (collapsed + expanded header) |
| `src/app/(app)/stls/_components/group-toolbar.tsx` | Toolbar for "Group Selected" action |
| `worker/src/grouping.ts` | Post-processing: album detection → PackageGroup creation |

### Modified Files
| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `PackageGroup` model, add `packageGroupId` to `Package`, add back-relation to `TelegramChannel` |
| `worker/src/archive/multipart.ts` | Add `mediaAlbumId?` to `TelegramMessage` interface |
| `worker/src/preview/match.ts` | Add `mediaAlbumId?` to `TelegramPhoto` interface |
| `worker/src/tdlib/download.ts` | Capture `media_album_id` from TDLib messages in scan loop |
| `worker/src/tdlib/topics.ts` | Capture `media_album_id` from TDLib messages in forum topic scan loop |
| `worker/src/worker.ts` | Call grouping post-processing after package indexing loop |
| `worker/src/db/queries.ts` | Add `createPackageGroup`, `linkPackagesToGroup` functions |
| `src/lib/telegram/types.ts` | Add `PackageGroupRow`, `DisplayItem` union type |
| `src/lib/telegram/queries.ts` | Add `listDisplayItems`, `getDisplayItemCount`, group CRUD queries |
| `src/app/(app)/stls/actions.ts` | Add server actions for group rename, dissolve, create, remove member, update preview, send all |
| `src/app/(app)/stls/_components/package-columns.tsx` | Add chevron column, checkbox column, group-aware rendering |
| `src/app/(app)/stls/_components/stl-table.tsx` | Add expand/collapse state, selection state, group toolbar, integrate new display item data shape |
| `src/app/(app)/stls/page.tsx` | Switch from `listPackages` to `listDisplayItems`, pass group data to table |

---

## Task 1: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add PackageGroup model to schema**

In `prisma/schema.prisma`, add the new model after the `Package` model (after line ~495):

```prisma
model PackageGroup {
  id              String           @id @default(cuid())
  name            String
  mediaAlbumId    String?
  sourceChannelId String
  previewData     Bytes?
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  packages        Package[]
  sourceChannel   TelegramChannel  @relation(fields: [sourceChannelId], references: [id], onDelete: Cascade)

  @@unique([mediaAlbumId, sourceChannelId])
  @@index([sourceChannelId])
  @@map("package_groups")
}
```

- [ ] **Step 2: Add packageGroupId to Package model**

In the `Package` model (around line 479, after `previewMsgId`), add:

```prisma
  packageGroupId  String?
  packageGroup    PackageGroup?    @relation(fields: [packageGroupId], references: [id], onDelete: SetNull)
```

And add this index alongside the existing indexes (after line ~493):

```prisma
  @@index([packageGroupId])
```

- [ ] **Step 3: Add back-relation to TelegramChannel**

In the `TelegramChannel` model (around line 435, after `skippedPackages`), add:

```prisma
  packageGroups   PackageGroup[]
```

- [ ] **Step 4: Generate and run the migration**

```bash
cd /e/Projects/DragonsStash && npx prisma migrate dev --name add_package_groups
```

Expected: Migration creates `package_groups` table, adds `packageGroupId` column and index to `packages`, creates unique index on `(mediaAlbumId, sourceChannelId)`.

- [ ] **Step 5: Verify Prisma client generation**

```bash
cd /e/Projects/DragonsStash && npm run db:generate
```

Expected: Prisma client generates without errors. `prisma.packageGroup` is available.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add PackageGroup schema for album-based file grouping"
```

---

## Task 2: Worker — Add mediaAlbumId to Interfaces

**Files:**
- Modify: `worker/src/archive/multipart.ts`
- Modify: `worker/src/preview/match.ts`

- [ ] **Step 1: Add mediaAlbumId to TelegramMessage**

In `worker/src/archive/multipart.ts`, update the `TelegramMessage` interface (line 7-13):

```typescript
export interface TelegramMessage {
  id: bigint;
  fileName: string;
  fileId: string;
  fileSize: bigint;
  date: Date;
  mediaAlbumId?: string;
}
```

- [ ] **Step 2: Add mediaAlbumId to TelegramPhoto**

In `worker/src/preview/match.ts`, update the `TelegramPhoto` interface (line 5-13):

```typescript
export interface TelegramPhoto {
  id: bigint;
  date: Date;
  /** Caption text on the photo message (if any). */
  caption: string;
  /** The smallest photo size available — used as thumbnail. */
  fileId: string;
  fileSize: number;
  mediaAlbumId?: string;
}
```

- [ ] **Step 3: Build worker to verify no type errors**

```bash
cd /e/Projects/DragonsStash/worker && npm run build
```

Expected: Clean build. The new optional field doesn't break any existing call sites.

- [ ] **Step 4: Commit**

```bash
cd /e/Projects/DragonsStash && git add worker/src/archive/multipart.ts worker/src/preview/match.ts
git commit -m "feat: add mediaAlbumId to TelegramMessage and TelegramPhoto interfaces"
```

---

## Task 3: Worker — Capture media_album_id During Scanning

**Files:**
- Modify: `worker/src/tdlib/download.ts`

- [ ] **Step 1: Add media_album_id to TdMessage interface**

In `worker/src/tdlib/download.ts`, update the `TdMessage` interface (lines 35-58) to add `media_album_id`:

```typescript
interface TdMessage {
  id: number;
  date: number;
  media_album_id?: string;
  content: {
    _: string;
    document?: {
      file_name?: string;
      document?: {
        id: number;
        size: number;
        local?: {
          path?: string;
          is_downloading_completed?: boolean;
        };
      };
    };
    photo?: {
      sizes?: TdPhotoSize[];
    };
    caption?: {
      text?: string;
    };
  };
}
```

- [ ] **Step 2: Pass media_album_id through to TelegramMessage**

In the `getChannelMessages` function, update the archive push block (around line 208-215). Change the `archives.push` call to include `mediaAlbumId`:

```typescript
    archives.push({
      id: BigInt(msg.id),
      fileName: doc.file_name,
      fileId: String(doc.document.id),
      fileSize: BigInt(doc.document.size),
      date: new Date(msg.date * 1000),
      mediaAlbumId: msg.media_album_id && msg.media_album_id !== "0" ? msg.media_album_id : undefined,
    });
```

- [ ] **Step 3: Pass media_album_id through to TelegramPhoto**

In the same function, update the photo push block (around line 224-231). Change the `photos.push` call to include `mediaAlbumId`:

```typescript
    photos.push({
      id: BigInt(msg.id),
      date: new Date(msg.date * 1000),
      caption,
      fileId: String(smallest.photo.id),
      fileSize: smallest.photo.size || smallest.photo.expected_size,
      mediaAlbumId: msg.media_album_id && msg.media_album_id !== "0" ? msg.media_album_id : undefined,
    });
```

- [ ] **Step 4: Add media_album_id to forum topic scanning**

`worker/src/tdlib/topics.ts` has a parallel `getTopicMessages` function with its own inline message struct. Apply the same changes:

1. Add `media_album_id?: string` to the inline TDLib message struct in `getTopicMessages`
2. Update the `archives.push` block to include `mediaAlbumId`
3. Update the `photos.push` block to include `mediaAlbumId`

Use the exact same pattern as steps 2-3 above.

- [ ] **Step 5: Build worker to verify**

```bash
cd /e/Projects/DragonsStash/worker && npm run build
```

Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
cd /e/Projects/DragonsStash && git add worker/src/tdlib/download.ts worker/src/tdlib/topics.ts
git commit -m "feat: capture media_album_id from TDLib messages during channel and topic scanning"
```

---

## Task 4: Worker — Group DB Queries

**Files:**
- Modify: `worker/src/db/queries.ts`

- [ ] **Step 1: Add createOrFindPackageGroup function**

At the end of `worker/src/db/queries.ts`, add:

```typescript
export async function createOrFindPackageGroup(input: {
  mediaAlbumId: string;
  sourceChannelId: string;
  name: string;
  previewData?: Buffer | null;
}): Promise<string> {
  // findFirst + conditional create (Prisma doesn't support upsert on nullable compound unique)
  const existing = await db.packageGroup.findFirst({
    where: {
      mediaAlbumId: input.mediaAlbumId,
      sourceChannelId: input.sourceChannelId,
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  const group = await db.packageGroup.create({
    data: {
      mediaAlbumId: input.mediaAlbumId,
      sourceChannelId: input.sourceChannelId,
      name: input.name,
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
    },
  });

  return group.id;
}

export async function linkPackagesToGroup(
  packageIds: string[],
  groupId: string
): Promise<void> {
  await db.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: groupId },
  });
}
```

- [ ] **Step 2: Build worker to verify**

```bash
cd /e/Projects/DragonsStash/worker && npm run build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
cd /e/Projects/DragonsStash && git add worker/src/db/queries.ts
git commit -m "feat: add createOrFindPackageGroup and linkPackagesToGroup worker queries"
```

---

## Task 5: Worker — Grouping Post-Processing

**Files:**
- Create: `worker/src/grouping.ts`
- Modify: `worker/src/worker.ts`

- [ ] **Step 1: Create grouping.ts module**

Create `worker/src/grouping.ts`:

```typescript
import type { Client } from "tdl";
import type { TelegramMessage } from "./archive/multipart.js";
import type { TelegramPhoto } from "./preview/match.js";
import { downloadPhotoThumbnail } from "./tdlib/download.js";
import { createOrFindPackageGroup, linkPackagesToGroup } from "./db/queries.js";
import { childLogger } from "./util/logger.js";
import { db } from "./db/client.js";

const log = childLogger("grouping");

interface IndexedPackageRef {
  packageId: string;
  sourceMessageId: bigint;
  mediaAlbumId?: string;
}

/**
 * After a scan cycle's packages are individually indexed, detect album groups
 * and create PackageGroup records linking the members.
 *
 * - Collects indexed packages that share a non-zero mediaAlbumId
 * - Creates (or finds existing) PackageGroup per album
 * - Links all member packages via packageGroupId
 * - Downloads album photo as group preview if available
 */
export async function processAlbumGroups(
  client: Client,
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[],
  photos: TelegramPhoto[]
): Promise<void> {
  // Group indexed packages by mediaAlbumId
  const albumMap = new Map<string, IndexedPackageRef[]>();
  for (const pkg of indexedPackages) {
    if (!pkg.mediaAlbumId || pkg.mediaAlbumId === "0") continue;
    const group = albumMap.get(pkg.mediaAlbumId) ?? [];
    group.push(pkg);
    albumMap.set(pkg.mediaAlbumId, group);
  }

  if (albumMap.size === 0) return;

  log.info({ albumCount: albumMap.size }, "Detected album groups to process");

  for (const [albumId, members] of albumMap) {
    if (members.length < 2) continue; // Single-file albums aren't groups

    try {
      // Find the first package's fileName for the group name fallback
      const firstPkg = await db.package.findFirst({
        where: { id: { in: members.map((m) => m.packageId) } },
        orderBy: { sourceMessageId: "asc" },
        select: { id: true, fileName: true },
      });

      // Try to find a caption from the album's photo message
      const albumPhoto = photos.find((p) => p.mediaAlbumId === albumId);
      const groupName = albumPhoto?.caption || firstPkg?.fileName || "Unnamed Group";

      // Download preview from album photo if available
      let previewData: Buffer | null = null;
      if (albumPhoto) {
        previewData = await downloadPhotoThumbnail(client, albumPhoto.fileId);
      }

      const groupId = await createOrFindPackageGroup({
        mediaAlbumId: albumId,
        sourceChannelId,
        name: groupName,
        previewData,
      });

      // Idempotent link — safe to re-run if some packages were indexed in prior scans
      const packageIds = members.map((m) => m.packageId);
      await linkPackagesToGroup(packageIds, groupId);

      log.info(
        { albumId, groupId, groupName, memberCount: packageIds.length },
        "Linked packages to album group"
      );
    } catch (err) {
      log.warn({ albumId, err }, "Failed to create album group — packages still indexed individually");
    }
  }
}
```

- [ ] **Step 2: Integrate grouping into worker pipeline**

In `worker/src/worker.ts`, find the `processArchiveSets` function. The function processes archive sets in a loop (around lines 726-772) and tracks `maxProcessedId`. After the processing loop ends, add the grouping step.

First, add the import at the top of `worker.ts`:

```typescript
import { processAlbumGroups } from "./grouping.js";
```

Then, in the `processArchiveSets` function, add tracking for indexed packages. Near line 726 (before the archive set loop), add:

```typescript
  const indexedPackageRefs: { packageId: string; sourceMessageId: bigint; mediaAlbumId?: string }[] = [];
```

Inside the per-set processing (in `processOneArchiveSet`), after the `createPackageWithFiles` call (around line 1149), the function needs to return the created package ID. Since `processOneArchiveSet` is a void function called from `processArchiveSets`, modify `processArchiveSets` to capture the result.

The cleanest integration point: in the `processArchiveSets` loop body (around line 740), after a successful `processOneArchiveSet` call, query for the created package by contentHash or source message and push to `indexedPackageRefs`. But simpler: have `processOneArchiveSet` return the package ID.

Find the `processOneArchiveSet` function signature. Change its return type from `Promise<void>` to `Promise<string | null>` (returning the created package ID, or null if it reused an existing upload).

After the `createPackageWithFiles` call (around line 1149), capture the return value:

```typescript
  const pkg = await createPackageWithFiles({ ... });
  // ... existing code after creation ...
  return pkg.id;
```

Add `return null;` to the early-return paths (size guard, dedup skip).

Back in `processArchiveSets`, in the success branch of the try/catch (around line 740), capture the return:

```typescript
  const packageId = await processOneArchiveSet(/* ... */);
  if (packageId) {
    const firstPart = archiveSet.parts[0];
    indexedPackageRefs.push({
      packageId,
      sourceMessageId: firstPart.id,
      mediaAlbumId: firstPart.mediaAlbumId,
    });
  }
```

After the loop (around line 773, before `return maxProcessedId`), add:

```typescript
  // Post-processing: group packages by Telegram album ID
  if (indexedPackageRefs.length > 0) {
    await processAlbumGroups(
      ctx.client,
      channel.id,
      indexedPackageRefs,
      scanResult.photos
    );
  }
```

- [ ] **Step 3: Build worker to verify**

```bash
cd /e/Projects/DragonsStash/worker && npm run build
```

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
cd /e/Projects/DragonsStash && git add worker/src/grouping.ts worker/src/worker.ts
git commit -m "feat: add album grouping post-processing to worker pipeline"
```

---

## Task 6: App — Types

**Files:**
- Modify: `src/lib/telegram/types.ts`

- [ ] **Step 1: Add PackageGroupRow and DisplayItem types**

At the end of `src/lib/telegram/types.ts`, add:

```typescript
export interface PackageGroupRow {
  id: string;
  name: string;
  hasPreview: boolean;
  totalFileSize: string;
  totalFileCount: number;
  packageCount: number;
  combinedTags: string[];
  archiveTypes: ("ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT")[];
  latestIndexedAt: string;
  sourceChannel: { id: string; title: string };
  packages: PackageListItem[];
}

export type DisplayItem =
  | { type: "package"; data: PackageListItem }
  | { type: "group"; data: PackageGroupRow };
```

- [ ] **Step 2: Verify app build**

```bash
cd /e/Projects/DragonsStash && npm run build
```

Expected: Clean build. Types are exported but not yet consumed.

- [ ] **Step 3: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/lib/telegram/types.ts
git commit -m "feat: add PackageGroupRow and DisplayItem types"
```

---

## Task 7: App — Queries

**Files:**
- Modify: `src/lib/telegram/queries.ts`

- [ ] **Step 1: Add listDisplayItems query**

Add the following function to `src/lib/telegram/queries.ts`:

```typescript
export async function listDisplayItems(options: {
  page: number;
  limit: number;
  channelId?: string;
  creator?: string;
  tag?: string;
  sortBy: "indexedAt" | "fileName" | "fileSize";
  order: "asc" | "desc";
}): Promise<{ items: DisplayItem[]; pagination: PaginatedResponse<never>["pagination"] }> {
  const { page, limit, channelId, creator, tag, sortBy, order } = options;

  // Build WHERE clause fragments for raw SQL
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (channelId) {
    conditions.push(`p."sourceChannelId" = $${paramIdx++}`);
    params.push(channelId);
  }
  if (creator) {
    conditions.push(`p."creator" = $${paramIdx++}`);
    params.push(creator);
  }
  if (tag) {
    conditions.push(`$${paramIdx++} = ANY(p."tags")`);
    params.push(tag);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Sort column mapping
  const sortCol = sortBy === "fileName" ? `"fileName"` : sortBy === "fileSize" ? `"fileSize"` : `"indexedAt"`;
  const sortDir = order === "asc" ? "ASC" : "DESC";

  // Step 1: Count display items
  const countSql = `
    SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT COALESCE(p."packageGroupId", p."id") AS display_id
      FROM packages p
      ${whereClause}
    ) AS display_items
  `;
  const countResult = await prisma.$queryRawUnsafe<[{ count: bigint }]>(countSql, ...params);
  const total = Number(countResult[0].count);

  // Step 2: Get display item IDs for this page
  const itemsSql = `
    SELECT
      COALESCE(p."packageGroupId", p."id") AS display_id,
      CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END AS display_type,
      MAX(p.${sortCol}) AS sort_value
    FROM packages p
    ${whereClause}
    GROUP BY COALESCE(p."packageGroupId", p."id"),
             CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END
    ORDER BY sort_value ${sortDir}
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  params.push(limit, (page - 1) * limit);

  const displayRows = await prisma.$queryRawUnsafe<
    { display_id: string; display_type: "group" | "package" }[]
  >(itemsSql, ...params);

  // Step 3: Fetch full data for each display item
  const groupIds = displayRows.filter((r) => r.display_type === "group").map((r) => r.display_id);
  const packageIds = displayRows.filter((r) => r.display_type === "package").map((r) => r.display_id);

  // Fetch standalone packages
  const standalonePackages = packageIds.length > 0
    ? await prisma.package.findMany({
        where: { id: { in: packageIds } },
        select: {
          id: true, fileName: true, fileSize: true, contentHash: true,
          archiveType: true, fileCount: true, isMultipart: true,
          indexedAt: true, creator: true, tags: true, previewData: true,
          sourceChannel: { select: { id: true, title: true } },
        },
      })
    : [];

  // Fetch groups with their member packages
  const groups = groupIds.length > 0
    ? await prisma.packageGroup.findMany({
        where: { id: { in: groupIds } },
        select: {
          id: true, name: true, previewData: true,
          sourceChannel: { select: { id: true, title: true } },
          packages: {
            select: {
              id: true, fileName: true, fileSize: true, contentHash: true,
              archiveType: true, fileCount: true, isMultipart: true,
              indexedAt: true, creator: true, tags: true, previewData: true,
              sourceChannel: { select: { id: true, title: true } },
            },
            orderBy: { indexedAt: "desc" },
          },
        },
      })
    : [];

  // Build DisplayItem array in the original sort order
  const packageMap = new Map(standalonePackages.map((p) => [p.id, p]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const items: DisplayItem[] = displayRows.map((row) => {
    if (row.display_type === "package") {
      const pkg = packageMap.get(row.display_id)!;
      return {
        type: "package" as const,
        data: {
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
          matchedFileCount: 0,
          matchedByContent: false,
        },
      };
    } else {
      const grp = groupMap.get(row.display_id)!;
      const allTags = [...new Set(grp.packages.flatMap((p) => p.tags))];
      const archiveTypes = [...new Set(grp.packages.map((p) => p.archiveType))];
      return {
        type: "group" as const,
        data: {
          id: grp.id,
          name: grp.name,
          hasPreview: grp.previewData !== null,
          totalFileSize: grp.packages.reduce((sum, p) => sum + p.fileSize, 0n).toString(),
          totalFileCount: grp.packages.reduce((sum, p) => sum + p.fileCount, 0),
          packageCount: grp.packages.length,
          combinedTags: allTags,
          archiveTypes,
          latestIndexedAt: grp.packages.length > 0
            ? grp.packages[0].indexedAt.toISOString()
            : new Date().toISOString(),
          sourceChannel: grp.sourceChannel,
          packages: grp.packages.map((pkg) => ({
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
            matchedFileCount: 0,
            matchedByContent: false,
          })),
        },
      };
    }
  });

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
```

- [ ] **Step 2: Add group CRUD queries**

Add these functions to `src/lib/telegram/queries.ts`:

```typescript
export async function getPackageGroup(groupId: string) {
  return prisma.packageGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true, name: true, previewData: true, mediaAlbumId: true,
      sourceChannelId: true, createdAt: true,
      sourceChannel: { select: { id: true, title: true } },
      packages: {
        select: {
          id: true, fileName: true, fileSize: true, archiveType: true,
          fileCount: true, creator: true, tags: true,
        },
        orderBy: { indexedAt: "desc" },
      },
    },
  });
}

export async function updatePackageGroupName(groupId: string, name: string) {
  return prisma.packageGroup.update({
    where: { id: groupId },
    data: { name: name.trim() },
  });
}

export async function updatePackageGroupPreview(groupId: string, previewData: Buffer) {
  return prisma.packageGroup.update({
    where: { id: groupId },
    data: { previewData: new Uint8Array(previewData) },
  });
}

export async function createManualGroup(name: string, packageIds: string[]) {
  // Verify all packages belong to the same channel (cross-channel groups are not supported)
  const pkgs = await prisma.package.findMany({
    where: { id: { in: packageIds } },
    select: { sourceChannelId: true },
  });
  const channelIds = new Set(pkgs.map((p) => p.sourceChannelId));
  if (channelIds.size > 1) {
    throw new Error("Cannot group packages from different channels");
  }

  const firstPkg = pkgs[0];

  const group = await prisma.packageGroup.create({
    data: {
      name: name.trim(),
      sourceChannelId: firstPkg.sourceChannelId,
    },
  });

  // Move packages to new group (removes from any existing group)
  await prisma.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: group.id },
  });

  // Clean up empty groups left behind
  await prisma.packageGroup.deleteMany({
    where: {
      packages: { none: {} },
      id: { not: group.id },
    },
  });

  return group;
}

export async function addPackagesToGroup(packageIds: string[], groupId: string) {
  await prisma.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: groupId },
  });

  // Clean up empty groups left behind
  await prisma.packageGroup.deleteMany({
    where: { packages: { none: {} } },
  });
}

export async function removePackageFromGroup(packageId: string) {
  const pkg = await prisma.package.findUniqueOrThrow({
    where: { id: packageId },
    select: { packageGroupId: true },
  });

  if (!pkg.packageGroupId) return;

  await prisma.package.update({
    where: { id: packageId },
    data: { packageGroupId: null },
  });

  // Clean up empty group
  await prisma.packageGroup.deleteMany({
    where: { id: pkg.packageGroupId, packages: { none: {} } },
  });
}

export async function dissolveGroup(groupId: string) {
  await prisma.package.updateMany({
    where: { packageGroupId: groupId },
    data: { packageGroupId: null },
  });
  await prisma.packageGroup.delete({ where: { id: groupId } });
}
```

- [ ] **Step 3: Add import for DisplayItem type**

At the top of `src/lib/telegram/queries.ts`, ensure `DisplayItem` and `PackageGroupRow` are imported from `./types`:

```typescript
import type { PackageListItem, PackageDetail, PaginatedResponse, DisplayItem, PackageGroupRow } from "./types";
```

- [ ] **Step 4: Update searchPackages to include group names**

In the `searchPackages` function, add a `LEFT JOIN` to `package_groups` when building the query. When `searchIn` is `"packages"` or `"both"`, add `PackageGroup.name` as an additional search target:

After the existing `where: { fileName: { contains: query, mode: "insensitive" } }` block for package name matching, also find packages whose group name matches:

```typescript
// Also match by group name
const groupNameMatches = await prisma.package.findMany({
  where: {
    packageGroup: { name: { contains: query, mode: "insensitive" } },
  },
  select: { id: true },
});
const groupMatchIds = groupNameMatches.map((p) => p.id);
```

Merge `groupMatchIds` into the existing `allIds` set before the final query.

- [ ] **Step 5: Verify app build**

```bash
cd /e/Projects/DragonsStash && npm run build
```

Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/lib/telegram/queries.ts src/lib/telegram/types.ts
git commit -m "feat: add listDisplayItems query, search by group name, and group CRUD operations"
```

---

## Task 8: App — Group Preview API Route

**Files:**
- Create: `src/app/api/groups/[id]/preview/route.ts`

- [ ] **Step 1: Create group preview endpoint**

Create `src/app/api/groups/[id]/preview/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";

/**
 * GET /api/groups/:id/preview
 * Returns the group's preview thumbnail image as JPEG binary.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;

  const group = await prisma.packageGroup.findUnique({
    where: { id },
    select: { previewData: true },
  });

  if (!group || !group.previewData) {
    return new NextResponse(null, { status: 404 });
  }

  const buffer =
    group.previewData instanceof Buffer
      ? group.previewData
      : Buffer.from(group.previewData);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
```

- [ ] **Step 2: Verify app build**

```bash
cd /e/Projects/DragonsStash && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/app/api/groups/
git commit -m "feat: add group preview image API endpoint"
```

---

## Task 9: App — Server Actions for Groups

**Files:**
- Modify: `src/app/(app)/stls/actions.ts`

- [ ] **Step 1: Add group server actions**

Import the new query functions at the top of `src/app/(app)/stls/actions.ts`:

```typescript
import {
  updatePackageGroupName,
  updatePackageGroupPreview,
  createManualGroup,
  removePackageFromGroup,
  dissolveGroup,
  addPackagesToGroup,
} from "@/lib/telegram/queries";
```

Then add these server actions after the existing ones:

```typescript
export async function renameGroupAction(
  groupId: string,
  name: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  if (!name.trim()) return { success: false, error: "Group name is required" };

  await updatePackageGroupName(groupId, name);
  revalidatePath("/stls");
  return { success: true };
}

export async function dissolveGroupAction(groupId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  await dissolveGroup(groupId);
  revalidatePath("/stls");
  return { success: true };
}

export async function createGroupAction(
  name: string,
  packageIds: string[]
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  if (!name.trim()) return { success: false, error: "Group name is required" };
  if (packageIds.length < 2) return { success: false, error: "Need at least 2 packages" };

  await createManualGroup(name, packageIds);
  revalidatePath("/stls");
  return { success: true };
}

export async function removeFromGroupAction(packageId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  await removePackageFromGroup(packageId);
  revalidatePath("/stls");
  return { success: true };
}

export async function updateGroupPreviewAction(
  groupId: string,
  formData: FormData
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const file = formData.get("preview") as File | null;
  if (!file) return { success: false, error: "No file provided" };

  const buffer = Buffer.from(await file.arrayBuffer());
  await updatePackageGroupPreview(groupId, buffer);
  revalidatePath("/stls");
  return { success: true };
}

export async function sendAllInGroupAction(groupId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  // Resolve the user's linked Telegram account (same pattern as /api/telegram/bot/send)
  const telegramLink = await prisma.telegramLink.findUnique({
    where: { userId: session.user.id },
  });
  if (!telegramLink) {
    return { success: false, error: "No linked Telegram account. Link one in Settings → Telegram." };
  }

  const group = await prisma.packageGroup.findUnique({
    where: { id: groupId },
    select: {
      packages: {
        where: { destChannelId: { not: null }, destMessageId: { not: null } },
        select: { id: true },
      },
    },
  });

  if (!group) return { success: false, error: "Group not found" };
  if (group.packages.length === 0) return { success: false, error: "No uploadable packages in group" };

  // Queue send requests for each package, skipping those with existing pending/sending requests
  for (const pkg of group.packages) {
    const existingPending = await prisma.botSendRequest.findFirst({
      where: {
        packageId: pkg.id,
        telegramLinkId: telegramLink.id,
        status: { in: ["PENDING", "SENDING"] },
      },
    });
    if (!existingPending) {
      await prisma.botSendRequest.create({
        data: {
          packageId: pkg.id,
          telegramLinkId: telegramLink.id,
          requestedByUserId: session.user.id,
          status: "PENDING",
        },
      });
    }
  }

  revalidatePath("/stls");
  return { success: true };
}
```

- [ ] **Step 2: Add prisma import if not present**

Make sure `prisma` is imported:

```typescript
import { prisma } from "@/lib/prisma";
```

- [ ] **Step 3: Verify app build**

```bash
cd /e/Projects/DragonsStash && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/app/(app)/stls/actions.ts
git commit -m "feat: add server actions for group rename, dissolve, create, remove, preview, and send all"
```

---

## Task 10: App — Update Page to Use Display Items

**Files:**
- Modify: `src/app/(app)/stls/page.tsx`

- [ ] **Step 1: Switch to listDisplayItems**

In `src/app/(app)/stls/page.tsx`, update the imports to include `listDisplayItems`:

```typescript
import { listDisplayItems, searchPackages, getIngestionStatus, getAllPackageTags, countSkippedPackages, listSkippedPackages } from "@/lib/telegram/queries";
```

Update the data fetch in the parallel `Promise.all`. Replace the `listPackages` call:

```typescript
  const [result, ingestionStatus, availableTags, skippedCount] = await Promise.all([
    search
      ? searchPackages({ query: search, page, limit: perPage, searchIn: "both" })
      : listDisplayItems({ page, limit: perPage, creator, tag, sortBy: sort as "indexedAt" | "fileName" | "fileSize", order }),
    getIngestionStatus(),
    getAllPackageTags(),
    countSkippedPackages(),
  ]);
```

Update the props passed to `StlTable` — `result.items` is now `DisplayItem[]` when not searching, and `PackageListItem[]` when searching. The `StlTable` component will need to handle both, so wrap search results as `DisplayItem[]`:

```typescript
  const displayItems = search
    ? result.items.map((item: PackageListItem) => ({ type: "package" as const, data: item }))
    : result.items;
```

Pass `displayItems` instead of `result.items` to `StlTable`.

- [ ] **Step 2: Update StlTable props type**

This will be done in Task 11 when we modify the table component. For now, just ensure the page passes the right data shape.

- [ ] **Step 3: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/app/(app)/stls/page.tsx
git commit -m "feat: switch STL page from listPackages to listDisplayItems"
```

---

## Task 11: App — UI Table with Group Support

**Files:**
- Modify: `src/app/(app)/stls/_components/stl-table.tsx`
- Modify: `src/app/(app)/stls/_components/package-columns.tsx`
- Create: `src/app/(app)/stls/_components/group-row.tsx`
- Create: `src/app/(app)/stls/_components/group-toolbar.tsx`

This is the largest task. It modifies the table to render both group rows and package rows, with expand/collapse and selection for manual grouping.

- [ ] **Step 1: Create group-row.tsx component**

Create `src/app/(app)/stls/_components/group-row.tsx`. This component renders a single group as a collapsible row. When collapsed it shows aggregates; when expanded it shows a header row + indented member packages.

Key elements:
- Chevron toggle button (ChevronRight rotated when expanded)
- Preview thumbnail (from `/api/groups/${groupId}/preview` or fallback icon)
- Editable group name (click to edit inline, calls `renameGroupAction`)
- "Mixed" type badge or most common type
- Combined size, file count, tag badges
- Actions: Send All, Dissolve Group (with confirmation dialog)
- Expanded state renders member `PackageRow` entries with indent and "Remove from group" action

Use the existing UI patterns from `package-columns.tsx` for consistency (same badge styles, size formatting, etc.).

- [ ] **Step 2: Create group-toolbar.tsx component**

Create `src/app/(app)/stls/_components/group-toolbar.tsx`. Shows when 2+ packages are selected:
- "Group N Selected" button
- Clicking it opens a dialog prompting for group name
- On submit, calls `createGroupAction(name, selectedPackageIds)`
- Clears selection after success

- [ ] **Step 3: Update package-columns.tsx**

In `src/app/(app)/stls/_components/package-columns.tsx`:

Add a checkbox column as the first column for row selection:

```typescript
{
  id: "select",
  header: ({ table }) => (
    <Checkbox
      checked={table.getIsAllPageRowsSelected()}
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      aria-label="Select all"
      className="h-4 w-4"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      aria-label="Select row"
      className="h-4 w-4"
    />
  ),
  enableSorting: false,
  enableHiding: false,
  size: 32,
}
```

Add a "Remove from group" option in the actions dropdown for packages that have a `packageGroupId`. This means `PackageRow` needs to carry `packageGroupId: string | null` so the cell can conditionally show the action.

- [ ] **Step 4: Update stl-table.tsx**

In `src/app/(app)/stls/_components/stl-table.tsx`:

Update `StlTableProps` to accept `DisplayItem[]`:

```typescript
interface StlTableProps {
  data: DisplayItem[];
  pageCount: number;
  totalCount: number;
  // ... rest stays the same
}
```

Add state for:
- `expandedGroups: Set<string>` — which group IDs are expanded
- Row selection via TanStack Table's built-in selection

Render logic:
- Iterate over `data` items
- If `item.type === "group"`:
  - Render `<GroupRow>` component
  - If expanded, render member packages as indented `<TableRow>` entries using the existing column definitions
- If `item.type === "package"`:
  - Render normal `<TableRow>` as today

Show `<GroupToolbar>` when selected count >= 2.

The `DataTable` component (`src/components/shared/data-table.tsx`) renders rows generically from TanStack Table. Since we need custom group rows interspersed, the cleanest approach is to **not use the generic `DataTable` for the packages tab** and instead render the table body directly in `stl-table.tsx`, similar to how `DataTable` does it but with group-awareness.

- [ ] **Step 5: Verify app build**

```bash
cd /e/Projects/DragonsStash && npm run build
```

- [ ] **Step 6: Manual testing**

1. Start the dev environment: `npm run dev`
2. Navigate to `/stls`
3. Verify standalone packages render as before
4. Create a manual group: select 2+ packages via checkboxes, click "Group Selected", enter a name
5. Verify the group appears as a collapsed row with aggregated data
6. Click the chevron to expand — member packages appear indented
7. Click group name to edit it inline
8. Test "Remove from group" on a member package
9. Test "Dissolve Group" on the group row
10. Test "Send All" on the group row

- [ ] **Step 7: Commit**

```bash
cd /e/Projects/DragonsStash && git add src/app/(app)/stls/_components/
git commit -m "feat: add group row rendering, expand/collapse, selection, and manual grouping UI"
```

---

## Task 12: App — Group Preview Upload in UI

**Files:**
- Modify: `src/app/(app)/stls/_components/group-row.tsx`

- [ ] **Step 1: Add preview upload to group row**

In the group row's preview cell, make the thumbnail clickable. On click, open a file input dialog. On file selection, call `updateGroupPreviewAction(groupId, formData)`.

Reuse the pattern from the existing package preview upload in `package-files-drawer.tsx` — it uses a hidden `<input type="file">` triggered by a button click, then submits via FormData.

- [ ] **Step 2: Verify and commit**

```bash
cd /e/Projects/DragonsStash && npm run build
git add src/app/(app)/stls/_components/group-row.tsx
git commit -m "feat: add preview image upload to group rows"
```

---

## Verification Checklist

After all tasks are complete, verify end-to-end:

- [ ] Worker builds cleanly: `cd worker && npm run build`
- [ ] App builds cleanly: `npm run build`
- [ ] Migration applied: `npm run db:migrate`
- [ ] Worker scans a channel with an album of files → PackageGroup created automatically
- [ ] STL table shows album groups as collapsed rows
- [ ] Expand/collapse works
- [ ] Manual grouping (select + group) works
- [ ] Group rename works
- [ ] Group dissolve works
- [ ] Remove from group works
- [ ] Send All works (queues requests for all members)
- [ ] Group preview upload works
- [ ] Search finds groups by name
- [ ] Filtering by tag/creator correctly shows groups when any member matches
- [ ] Pagination is correct (groups take one slot)
