# Package Grouping Design

## Overview

Add the ability to group related packages that were posted together in a Telegram channel (e.g., "DUNGEON BLOCKS - Colossal Dungeon" with 6 separate archive files). Groups appear as collapsible rows in the STL files table, with support for both automatic detection via Telegram album IDs and manual grouping through the UI.

## Goals

- Automatically detect and group files posted together in Telegram (same `media_album_id`)
- Display groups as collapsed rows in the STL table with aggregated metadata
- Allow manual grouping/ungrouping of packages via the UI
- Support editable group names and preview images
- Enable "Send All" to deliver every package in a group via the bot

## Non-Goals

- Merging grouped packages into a single Package record (each stays independent)
- Time-proximity heuristics for grouping (too error-prone)
- Grouping across different source channels

---

## Data Model

### New `PackageGroup` Table

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

### Package Model Changes

Add optional group membership:

```prisma
model Package {
  // ... existing fields ...
  packageGroupId  String?
  packageGroup    PackageGroup?    @relation(fields: [packageGroupId], references: [id], onDelete: SetNull)

  @@index([packageGroupId])
}
```

### TelegramChannel Model Changes

Add back-relation for the new `PackageGroup` model:

```prisma
model TelegramChannel {
  // ... existing fields and relations ...
  packageGroups   PackageGroup[]
}
```

### Key Decisions

- `mediaAlbumId` is `String?` (TDLib int64 stringified) — only used for dedup lookups, avoids BigInt complexity
- `@@unique([mediaAlbumId, sourceChannelId])` prevents duplicate album-derived groups when re-scanning. PostgreSQL treats NULLs as distinct in unique constraints, so manually-created groups (with `mediaAlbumId = null`) are not constrained by this — which is correct behavior
- Idempotency for album groups uses `findFirst({ where: { mediaAlbumId, sourceChannelId } })` + conditional `create`, not `upsert`, because Prisma does not support `upsert` on compound unique keys with nullable fields
- `onDelete: SetNull` on `Package.packageGroup` means dissolving a group automatically unlinks all members
- `onDelete: Cascade` on `PackageGroup.sourceChannel` means deleting a channel cleans up its groups
- `sourceTopicId` is omitted from `PackageGroup` — it can be inferred from member packages, and manual groups may span topics
- `@@map("package_groups")` follows the project's snake_case table naming convention
- `previewData` stores JPEG thumbnail bytes directly on the group (same pattern as Package)

---

## Worker Changes

### TelegramMessage Interface

Add optional `mediaAlbumId` field:

```typescript
export interface TelegramMessage {
  id: bigint;
  fileName: string;
  fileId: string;
  fileSize: bigint;
  date: Date;
  mediaAlbumId?: string;  // Absent or "0" when not part of an album
}
```

The field is optional to minimize call-site changes. The grouping step treats `undefined` and `"0"` equivalently as "not part of an album."

### TelegramPhoto Interface

Add optional `mediaAlbumId` field:

```typescript
export interface TelegramPhoto {
  id: bigint;
  date: Date;
  caption: string;
  fileId: string;
  fileSize: number;
  mediaAlbumId?: string;  // For album-to-preview correlation
}
```

### Channel Scanning

In `getChannelMessages()`, read `media_album_id` from the TDLib message object (already present in TDLib responses, just not captured today). Add `media_album_id?: string` to the `TdMessage` interface and pass through to both `TelegramMessage` and `TelegramPhoto`.

The document pass and photo pass already run as separate loops over `searchChatMessages`. Both loops capture `media_album_id` independently. Correlation happens at grouping time: album photos are matched to album documents by comparing their `mediaAlbumId` values, not at scan time.

### Group Creation (Post-Processing)

After each scan cycle's packages are individually processed (downloaded, hashed, uploaded, indexed), a post-processing step handles grouping:

1. Collect all packages from the current scan batch that share the same non-zero `mediaAlbumId`
2. For each distinct `mediaAlbumId`, check if a `PackageGroup` already exists via `findFirst({ where: { mediaAlbumId, sourceChannelId } })`
3. If no group exists, create one:
   - **Name:** caption of the first message in the album (falls back to first file's base name)
   - **Preview:** find a `TelegramPhoto` from the scan's `photos[]` array with the same `mediaAlbumId`. If found, download via `downloadPhotoThumbnail`. If not, the group starts with no preview (can be added in UI later)
4. Link all member packages via an idempotent `updateMany` — sets `packageGroupId` on all packages whose `sourceMessageId` is in the album's message set. This handles both newly-indexed packages and previously-indexed ones that were created in an earlier partial scan (e.g., if one package failed and was retried later)

The per-package pipeline is unchanged — each file is still downloaded, hashed, deduped, split, uploaded, and indexed independently. Grouping is a layer on top.

---

## Query Layer

### Paginated Listing with Groups

The STL table shows "display items" — either a group (collapsed) or a standalone package. Pagination operates on display items so that a group occupies exactly one slot regardless of member count.

**Two-step query approach** (handles filters correctly):

**Step 1 — Find matching display item IDs:**

```sql
-- Find all group IDs and standalone package IDs where at least one member matches filters
SELECT DISTINCT COALESCE(p."packageGroupId", p.id) AS display_id,
       CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END AS display_type,
       MAX(p."indexedAt") AS sort_date
FROM packages p
LEFT JOIN package_groups pg ON pg.id = p."packageGroupId"
WHERE 1=1
  -- Optional filters applied here (creator, tags, search text, channelId)
GROUP BY COALESCE(p."packageGroupId", p.id),
         CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END
ORDER BY sort_date DESC
LIMIT $1 OFFSET $2
```

**Step 2 — Fetch full data:**

For groups on the current page, fetch all member packages (including those that didn't match filters — the group appears because at least one member matched, but the expanded view shows all members). For standalone packages, fetch the full package data.

**Count query** (for pagination total):

```sql
SELECT COUNT(*) FROM (
  SELECT DISTINCT COALESCE(p."packageGroupId", p.id)
  FROM packages p
  WHERE 1=1
  -- Same filters as step 1
) AS display_items
```

### Group Row Aggregates

Computed in the step 2 fetch: total file size (sum), total file count (sum), combined tags (array union), member package count per group. These populate the collapsed group row.

### Search

`searchPackages` adds `PackageGroup.name` to search targets via a `LEFT JOIN` to `package_groups`. If any package in a group matches by name/file content, or the group name matches, the whole group appears.

### Filtering

Creator/tag filters apply to member packages. A group appears if any member matches the filter. The group row shows aggregates of all members (not just matching ones).

### New Query Functions

| Function | Purpose |
|----------|---------|
| `listDisplayItems(page, limit, filters)` | Two-step paginated query returning groups + standalone packages |
| `getDisplayItemCount(filters)` | Count of display items for pagination total |
| `getPackageGroup(groupId)` | Group metadata + all member packages |
| `updatePackageGroupName(groupId, name)` | Rename group |
| `updatePackageGroupPreview(groupId, previewData)` | Replace group preview |
| `addPackagesToGroup(packageIds, groupId)` | Manual grouping — add to existing group |
| `removePackageFromGroup(packageId)` | Ungroup single package |
| `createManualGroup(name, packageIds)` | Create new group from UI |
| `dissolveGroup(groupId)` | Ungroup all members, delete group record |

For manual grouping of packages that already belong to different groups: the UI first dissolves empty source groups (groups where all members were moved), then links the selected packages to the target group. Non-selected members of source groups remain in their original group.

---

## UI Changes

### STL Table — Group Rows

- **Collapsed (default):** Single row showing preview thumbnail, group name (editable inline), archive type badge ("Mixed" if heterogeneous), combined size, combined file count, combined tags (editable), source channel, latest `indexedAt`, actions
- **Expanded:** Chevron toggle reveals member packages as indented sub-rows with their existing columns and per-package actions
- Chevron icon on the left of the row toggles expand/collapse

**Loading strategy:** Member packages for all groups on the current page are prefetched in a single batched query during the step 2 fetch. This means expand/collapse is instant (no on-demand loading) and avoids per-row loading states.

### Group Row Actions

- **Send All** — Queues bot send requests for every package in the group. Checks for existing PENDING/SENDING requests per package to avoid duplicates.
- **View Files** — Opens file drawer showing all member packages' files, separated by package name headers
- **Dissolve Group** — Ungroups all members (confirmation required)

### Individual Package Actions (Within a Group)

- Existing: Send, View Files
- New: "Remove from group" in dropdown menu

### Manual Grouping

- Checkbox selection column on package rows
- When 2+ packages selected, a "Group Selected" button appears in the table toolbar
- Prompts for a group name, creates the group
- If selected packages belong to existing groups, those packages are moved to the new group. Source groups that become empty are automatically dissolved.

### Preview Editing

- Click the group's preview thumbnail to upload a replacement image
- Same upload flow as individual packages (existing component reuse)

### No Changes To

- Skipped/failed packages tab
- Package detail drawer internals
- Search UI (just broader matching behind the scenes)
