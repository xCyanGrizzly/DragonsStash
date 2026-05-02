# Multi-Part Send Fix & Kickstarter Package Linking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix multi-part package forwarding so all archive parts reach the user, and add UI to link STL packages to kickstarters with "send all" capability.

**Architecture:** Two independent subsystems. (A) Store all destination message IDs when the worker uploads multi-part archives, then have the bot forward every part. (B) Add a package-linker dialog in the kickstarter UI using the existing `linkPackages` action, plus a "send all" action that queues every linked package.

**Tech Stack:** Prisma (schema + migration), TypeScript worker/bot services, Next.js App Router (server actions + React client components), shadcn/ui, TanStack Table.

---

## File Map

### Subsystem A — Multi-Part Send Fix

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `prisma/schema.prisma` | Add `destMessageIds BigInt[]` to Package |
| Create | `prisma/migrations/<ts>_add_dest_message_ids/migration.sql` | Migration SQL |
| Modify | `worker/src/upload/channel.ts` | Return all message IDs from `uploadToChannel` |
| Modify | `worker/src/db/queries.ts` | Add `destMessageIds` to `CreatePackageInput` and `createPackageWithFiles` |
| Modify | `worker/src/worker.ts` | Pass all message IDs when creating package |
| Modify | `bot/src/db/queries.ts` | Include `destMessageIds` in `getPendingSendRequest` |
| Modify | `bot/src/send-listener.ts` | Forward all parts, not just the first |

### Subsystem B — Kickstarter Package Linking UI

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/(app)/kickstarters/_components/package-linker-dialog.tsx` | Dialog with package search + selection for linking |
| Modify | `src/app/(app)/kickstarters/_components/kickstarter-columns.tsx` | Add "Link Packages" and "Send All" actions to row menu |
| Modify | `src/app/(app)/kickstarters/_components/kickstarter-table.tsx` | Wire up new dialogs + state |
| Modify | `src/app/(app)/kickstarters/actions.ts` | Add `sendAllKickstarterPackages` action |
| Modify | `src/data/kickstarter.queries.ts` | Add query to search packages for linking |

---

## Task 1: Add `destMessageIds` to Prisma Schema + Migration

**Files:**
- Modify: `prisma/schema.prisma:470-471`
- Create: migration SQL

- [ ] **Step 1: Add field to schema**

In `prisma/schema.prisma`, add `destMessageIds` after `destMessageId`:

```prisma
  destMessageId   BigInt?
  destMessageIds  BigInt[]    @default([])
```

- [ ] **Step 2: Create migration SQL manually**

Create the migration directory and SQL file. The migration adds the column with a default and backfills existing rows by copying `destMessageId` into the array where it's non-null:

```sql
-- AlterTable
ALTER TABLE "packages" ADD COLUMN "destMessageIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[];

-- Backfill: copy existing destMessageId into the array
UPDATE "packages"
SET "destMessageIds" = ARRAY["destMessageId"]
WHERE "destMessageId" IS NOT NULL;
```

- [ ] **Step 3: Apply migration to database**

```bash
docker exec dragonsstash-db psql -U dragons -d dragonsstash -f - < migration.sql
```

- [ ] **Step 4: Regenerate Prisma client**

Use the app container (which has node/prisma) to regenerate:

```bash
docker exec dragonsstash npx prisma generate
```

Or, if running locally with node: `npx prisma generate`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add destMessageIds field to Package for multi-part forwarding"
```

---

## Task 2: Worker — Return All Message IDs from Upload

**Files:**
- Modify: `worker/src/upload/channel.ts:10-12,25-74`

- [ ] **Step 1: Update UploadResult interface**

In `worker/src/upload/channel.ts`, change the interface to include all IDs:

```typescript
export interface UploadResult {
  messageId: bigint;
  messageIds: bigint[];
}
```

- [ ] **Step 2: Collect all message IDs in uploadToChannel**

Replace the upload loop to track all message IDs:

```typescript
export async function uploadToChannel(
  client: Client,
  chatId: bigint,
  filePaths: string[],
  caption?: string
): Promise<UploadResult> {
  const allMessageIds: bigint[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const fileCaption = i === 0 && caption ? caption : undefined;

    const fileName = path.basename(filePath);
    let fileSizeMB = 0;
    try {
      const s = await stat(filePath);
      fileSizeMB = Math.round(s.size / (1024 * 1024));
    } catch {
      // Non-critical
    }

    log.info(
      { chatId: Number(chatId), fileName, sizeMB: fileSizeMB, part: i + 1, total: filePaths.length },
      "Uploading file to channel"
    );

    const serverMsgId = await sendWithRetry(client, chatId, filePath, fileCaption, fileName, fileSizeMB);
    allMessageIds.push(serverMsgId);

    // Rate limit delay between uploads
    if (i < filePaths.length - 1) {
      await sleep(config.apiDelayMs);
    }
  }

  if (allMessageIds.length === 0) {
    throw new Error("Upload failed: no messages sent");
  }

  log.info(
    { chatId: Number(chatId), messageId: Number(allMessageIds[0]), files: filePaths.length },
    "All uploads confirmed by Telegram"
  );

  return { messageId: allMessageIds[0], messageIds: allMessageIds };
}
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/upload/channel.ts
git commit -m "feat: return all message IDs from uploadToChannel for multi-part"
```

---

## Task 3: Worker — Store All Message IDs in Database

**Files:**
- Modify: `worker/src/db/queries.ts:104-155`
- Modify: `worker/src/worker.ts:1056-1086`

- [ ] **Step 1: Add destMessageIds to CreatePackageInput**

In `worker/src/db/queries.ts`, add the field to the interface:

```typescript
export interface CreatePackageInput {
  // ... existing fields ...
  destMessageId?: bigint;
  destMessageIds?: bigint[];
  // ... rest ...
}
```

- [ ] **Step 2: Store destMessageIds in createPackageWithFiles**

In the `db.package.create` call inside `createPackageWithFiles`, add:

```typescript
destMessageIds: input.destMessageIds ?? (input.destMessageId ? [input.destMessageId] : []),
```

- [ ] **Step 3: Pass messageIds from worker pipeline**

In `worker/src/worker.ts`, the upload section (around line 1068-1085) currently does:

```typescript
destResult = await uploadToChannel(client, destChannelTelegramId, uploadPaths);
```

After this, when calling `createPackageWithFiles`, add `destMessageIds`:

```typescript
const pkg = await createPackageWithFiles({
  // ... existing fields ...
  destMessageId: destResult.messageId,
  destMessageIds: destResult.messageIds,
  // ... rest ...
});
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/db/queries.ts worker/src/worker.ts
git commit -m "feat: store all multi-part message IDs in package record"
```

---

## Task 4: Bot — Forward All Parts

**Files:**
- Modify: `bot/src/db/queries.ts:110-132`
- Modify: `bot/src/send-listener.ts:105-169`
- Modify: `bot/src/tdlib/client.ts:66-122`

- [ ] **Step 1: Include destMessageIds in bot query**

In `bot/src/db/queries.ts`, add `destMessageIds` to the `getPendingSendRequest` select:

```typescript
package: {
  select: {
    id: true,
    fileName: true,
    fileSize: true,
    fileCount: true,
    creator: true,
    tags: true,
    archiveType: true,
    destChannelId: true,
    destMessageId: true,
    destMessageIds: true,   // <-- ADD THIS
    isMultipart: true,      // <-- ADD THIS (for logging)
    partCount: true,        // <-- ADD THIS (for logging)
    previewData: true,
    sourceChannel: { select: { title: true, telegramId: true } },
  },
},
```

- [ ] **Step 2: Add copyMultipleMessagesToUser helper**

In `bot/src/tdlib/client.ts`, add a new export after `copyMessageToUser`:

```typescript
/**
 * Send multiple document messages from a channel to a user's DM.
 * Used for multi-part archives where each part is a separate Telegram message.
 * Sends parts sequentially with a small delay to avoid rate limits.
 */
export async function copyMultipleMessagesToUser(
  fromChatId: bigint,
  messageIds: bigint[],
  toUserId: bigint
): Promise<void> {
  for (let i = 0; i < messageIds.length; i++) {
    await copyMessageToUser(fromChatId, messageIds[i], toUserId);
    // Small delay between parts to avoid rate limits
    if (i < messageIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
```

- [ ] **Step 3: Update processSendRequest to forward all parts**

In `bot/src/send-listener.ts`, update the import to include the new function:

```typescript
import { copyMessageToUser, copyMultipleMessagesToUser, sendTextMessage, sendPhotoMessage } from "./tdlib/client.js";
```

Then replace the single `copyMessageToUser` call (around line 157) with logic that forwards all parts:

```typescript
    // Forward the actual archive file(s) from destination channel
    const messageIds = pkg.destMessageIds as bigint[] | undefined;
    if (messageIds && messageIds.length > 1) {
      log.info(
        { requestId, parts: messageIds.length },
        "Sending multi-part archive"
      );
      await copyMultipleMessagesToUser(
        destChannel.telegramId,
        messageIds,
        targetUserId
      );
    } else {
      // Single part or legacy (no destMessageIds populated)
      await copyMessageToUser(
        destChannel.telegramId,
        pkg.destMessageId,
        targetUserId
      );
    }
```

- [ ] **Step 4: Commit**

```bash
git add bot/src/db/queries.ts bot/src/send-listener.ts bot/src/tdlib/client.ts
git commit -m "feat: forward all parts of multi-part archives via bot"
```

---

## Task 5: Rebuild & Deploy Worker + Bot

- [ ] **Step 1: Rebuild worker image**

```bash
docker compose -f docker-compose.dev.yml build worker
docker tag dragonsstash-worker:latest git.samagsteribbe.nl/admin/dragonsstash-worker:latest
docker compose -p dragonsstash -f /opt/stacks/DragonsStash/docker-compose.yml up -d worker
```

- [ ] **Step 2: Rebuild bot image**

```bash
docker compose -f docker-compose.dev.yml build bot
docker tag dragonsstash-bot:latest git.samagsteribbe.nl/admin/dragonsstash-bot:latest
docker compose -p dragonsstash -f /opt/stacks/DragonsStash/docker-compose.yml up -d bot
```

- [ ] **Step 3: Verify bot startup**

```bash
docker logs dragonsstash-bot --tail=20
```

Expected: Bot starts cleanly, "Send listener started" message.

---

## Task 6: Kickstarter — Package Search Query

**Files:**
- Modify: `src/data/kickstarter.queries.ts`

- [ ] **Step 1: Add searchPackagesForLinking query**

Append to `src/data/kickstarter.queries.ts`:

```typescript
export async function searchPackagesForLinking(query: string, limit = 20) {
  if (!query || query.length < 2) return [];

  return prisma.package.findMany({
    where: {
      OR: [
        { fileName: { contains: query, mode: "insensitive" } },
        { creator: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: { indexedAt: "desc" },
    take: limit,
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      archiveType: true,
      creator: true,
      fileCount: true,
    },
  });
}

export async function getLinkedPackageIds(kickstarterId: string): Promise<string[]> {
  const links = await prisma.kickstarterPackage.findMany({
    where: { kickstarterId },
    select: { packageId: true },
  });
  return links.map((l) => l.packageId);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/data/kickstarter.queries.ts
git commit -m "feat: add package search query for kickstarter linking"
```

---

## Task 7: Kickstarter — Package Linker Dialog Component

**Files:**
- Create: `src/app/(app)/kickstarters/_components/package-linker-dialog.tsx`

- [ ] **Step 1: Create the package linker dialog**

This component provides a search input to find packages and checkboxes to select/deselect them. It calls the existing `linkPackages` action on save.

```tsx
"use client";

import { useState, useTransition, useCallback, useEffect } from "react";
import { Search, Package, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { linkPackages } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface PackageResult {
  id: string;
  fileName: string;
  fileSize: bigint;
  archiveType: string;
  creator: string | null;
  fileCount: number;
}

interface PackageLinkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kickstarterId: string;
  kickstarterName: string;
  initialPackageIds: string[];
}

function formatSize(bytes: bigint | number): string {
  const b = Number(bytes);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export function PackageLinkerDialog({
  open,
  onOpenChange,
  kickstarterId,
  kickstarterName,
  initialPackageIds,
}: PackageLinkerDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PackageResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(initialPackageIds));

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(initialPackageIds));
      setSearchQuery("");
      setSearchResults([]);
    }
  }, [open, initialPackageIds]);

  const doSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/packages/search?q=${encodeURIComponent(query)}&limit=20`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.packages ?? []);
      }
    } catch {
      // Ignore search errors
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => doSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, doSearch]);

  function togglePackage(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    startTransition(async () => {
      const result = await linkPackages(kickstarterId, Array.from(selectedIds));
      if (result.success) {
        toast.success(`Linked ${selectedIds.size} package(s) to "${kickstarterName}"`);
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Packages</DialogTitle>
          <DialogDescription>
            Search and select STL packages to link to &ldquo;{kickstarterName}&rdquo;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Selected count */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Package className="h-4 w-4" />
              {selectedIds.size} package(s) selected
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear all
              </Button>
            </div>
          )}

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search packages by name or creator..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Results */}
          <ScrollArea className="h-[300px] rounded-md border">
            <div className="p-2 space-y-1">
              {searchResults.length === 0 && searchQuery.length >= 2 && !isSearching && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No packages found
                </p>
              )}
              {searchQuery.length < 2 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Type at least 2 characters to search
                </p>
              )}
              {searchResults.map((pkg) => (
                <label
                  key={pkg.id}
                  className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedIds.has(pkg.id)}
                    onCheckedChange={() => togglePackage(pkg.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pkg.fileName}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {pkg.creator && <span>{pkg.creator}</span>}
                      <span>{formatSize(pkg.fileSize)}</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1">
                        {pkg.archiveType}
                      </Badge>
                      {pkg.fileCount > 0 && <span>{pkg.fileCount} files</span>}
                    </div>
                  </div>
                  {selectedIds.has(pkg.id) && (
                    <X className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </label>
              ))}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Save ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/(app)/kickstarters/_components/package-linker-dialog.tsx
git commit -m "feat: add package linker dialog for kickstarters"
```

---

## Task 8: Package Search API Route

**Files:**
- Create: `src/app/api/packages/search/route.ts`

- [ ] **Step 1: Create the API route**

The package linker dialog needs a client-side fetch for debounced search. Create a lightweight API route:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchPackagesForLinking } from "@/data/kickstarter.queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 50);

  const packages = await searchPackagesForLinking(query, limit);

  // Serialize BigInt for JSON
  const serialized = packages.map((p) => ({
    ...p,
    fileSize: p.fileSize.toString(),
  }));

  return NextResponse.json({ packages: serialized });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/packages/search/route.ts
git commit -m "feat: add package search API route for kickstarter linking"
```

---

## Task 9: Kickstarter — Send All Packages Action

**Files:**
- Modify: `src/app/(app)/kickstarters/actions.ts`

- [ ] **Step 1: Add sendAllKickstarterPackages action**

Append to `src/app/(app)/kickstarters/actions.ts`:

```typescript
export async function sendAllKickstarterPackages(
  kickstarterId: string
): Promise<ActionResult<{ queued: number }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  try {
    const telegramLink = await prisma.telegramLink.findUnique({
      where: { userId: session.user.id },
    });

    if (!telegramLink) {
      return { success: false, error: "No linked Telegram account. Link one in Settings." };
    }

    const kickstarter = await prisma.kickstarter.findFirst({
      where: { id: kickstarterId, userId: session.user.id },
      select: {
        packages: {
          select: {
            package: {
              select: { id: true, destChannelId: true, destMessageId: true, fileName: true },
            },
          },
        },
      },
    });

    if (!kickstarter) {
      return { success: false, error: "Kickstarter not found" };
    }

    const sendablePackages = kickstarter.packages
      .map((lnk) => lnk.package)
      .filter((p) => p.destChannelId && p.destMessageId);

    if (sendablePackages.length === 0) {
      return { success: false, error: "No linked packages are available for sending" };
    }

    let queued = 0;
    for (const pkg of sendablePackages) {
      const existing = await prisma.botSendRequest.findFirst({
        where: {
          packageId: pkg.id,
          telegramLinkId: telegramLink.id,
          status: { in: ["PENDING", "SENDING"] },
        },
      });

      if (!existing) {
        const sendRequest = await prisma.botSendRequest.create({
          data: {
            packageId: pkg.id,
            telegramLinkId: telegramLink.id,
            requestedByUserId: session.user.id,
            status: "PENDING",
          },
        });

        try {
          await prisma.$queryRawUnsafe(
            `SELECT pg_notify('bot_send', $1)`,
            sendRequest.id
          );
        } catch {
          // Best-effort
        }

        queued++;
      }
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { queued } };
  } catch {
    return { success: false, error: "Failed to send packages" };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/(app)/kickstarters/actions.ts
git commit -m "feat: add sendAllKickstarterPackages action"
```

---

## Task 10: Kickstarter Table — Wire Up Link & Send Actions

**Files:**
- Modify: `src/app/(app)/kickstarters/_components/kickstarter-columns.tsx`
- Modify: `src/app/(app)/kickstarters/_components/kickstarter-table.tsx`

- [ ] **Step 1: Add actions to column menu**

In `kickstarter-columns.tsx`, add `Link2` and `Send` imports from lucide-react, add `onLinkPackages` and `onSendAll` to props, and add menu items:

```typescript
import { MoreHorizontal, Pencil, Trash2, ExternalLink, Link2, Send } from "lucide-react";

// Update interface:
interface KickstarterColumnsProps {
  onEdit: (kickstarter: KickstarterRow) => void;
  onDelete: (id: string) => void;
  onLinkPackages: (kickstarter: KickstarterRow) => void;
  onSendAll: (kickstarter: KickstarterRow) => void;
}
```

In the actions column dropdown, add between Edit and the separator:

```tsx
<DropdownMenuItem onClick={() => onLinkPackages(row.original)}>
  <Link2 className="mr-2 h-3.5 w-3.5" />
  Link Packages
</DropdownMenuItem>
{row.original._count.packages > 0 && (
  <DropdownMenuItem onClick={() => onSendAll(row.original)}>
    <Send className="mr-2 h-3.5 w-3.5" />
    Send All ({row.original._count.packages})
  </DropdownMenuItem>
)}
```

Update the function signature to destructure the new props:

```typescript
export function getKickstarterColumns({
  onEdit,
  onDelete,
  onLinkPackages,
  onSendAll,
}: KickstarterColumnsProps): ColumnDef<KickstarterRow, unknown>[] {
```

- [ ] **Step 2: Wire up state in kickstarter-table.tsx**

Add imports and state for the new dialogs:

```typescript
import { PackageLinkerDialog } from "./package-linker-dialog";
import { sendAllKickstarterPackages } from "../actions";

// Inside KickstarterTable:
const [linkTarget, setLinkTarget] = useState<KickstarterRow | null>(null);
const [sendAllTarget, setSendAllTarget] = useState<KickstarterRow | null>(null);
```

Update the columns call:

```typescript
const columns = getKickstarterColumns({
  onEdit: (kickstarter) => {
    setEditKickstarter(kickstarter);
    setModalOpen(true);
  },
  onDelete: (id) => setDeleteId(id),
  onLinkPackages: (kickstarter) => setLinkTarget(kickstarter),
  onSendAll: (kickstarter) => {
    startTransition(async () => {
      const result = await sendAllKickstarterPackages(kickstarter.id);
      if (result.success) {
        toast.success(`Queued ${result.data!.queued} package(s) for delivery`);
      } else {
        toast.error(result.error);
      }
    });
  },
});
```

Add the `PackageLinkerDialog` before the closing `</div>` of the component's return:

```tsx
{linkTarget && (
  <PackageLinkerDialog
    open={!!linkTarget}
    onOpenChange={(open) => !open && setLinkTarget(null)}
    kickstarterId={linkTarget.id}
    kickstarterName={linkTarget.name}
    initialPackageIds={[]}
  />
)}
```

Note: `initialPackageIds` is `[]` because the table doesn't fetch linked packages. The dialog will start empty but preserve selections during the session. For a better UX, we fetch the linked IDs when the dialog opens — see step 3.

- [ ] **Step 3: Fetch initial linked packages when dialog opens**

To populate the dialog with already-linked packages, add an API route or use a server action. The simplest approach: modify the `PackageLinkerDialog` to fetch linked IDs on mount.

In `package-linker-dialog.tsx`, add to the `useEffect` that runs when `open` changes:

```typescript
useEffect(() => {
  if (open) {
    setSearchQuery("");
    setSearchResults([]);
    // Fetch currently linked packages
    fetch(`/api/packages/linked?kickstarterId=${kickstarterId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.packageIds) {
          setSelectedIds(new Set(data.packageIds));
        }
      })
      .catch(() => {});
  }
}, [open, kickstarterId]);
```

Create the API route at `src/app/api/packages/linked/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getLinkedPackageIds } from "@/data/kickstarter.queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const kickstarterId = searchParams.get("kickstarterId");
  if (!kickstarterId) {
    return NextResponse.json({ error: "kickstarterId required" }, { status: 400 });
  }

  const packageIds = await getLinkedPackageIds(kickstarterId);
  return NextResponse.json({ packageIds });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/(app)/kickstarters/_components/ src/app/api/packages/
git commit -m "feat: wire up package linking and send-all in kickstarter table"
```

---

## Task 11: Rebuild & Deploy App

- [ ] **Step 1: Rebuild app image**

```bash
docker compose build app  # or equivalent for the production compose
docker tag dragonsstash:latest git.samagsteribbe.nl/admin/dragonsstash:latest
docker compose -p dragonsstash -f /opt/stacks/DragonsStash/docker-compose.yml up -d app
```

- [ ] **Step 2: Verify app startup**

```bash
docker logs dragonsstash --tail=20
```

Expected: App starts cleanly, health check passes.

- [ ] **Step 3: Manual test**

1. Go to Kickstarters tab
2. Open a kickstarter's row menu → "Link Packages"
3. Search for a package, select it, save
4. Verify the package count column updates
5. Use "Send All" to queue all linked packages for Telegram delivery
