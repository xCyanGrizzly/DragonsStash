# Send All From Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar button on the STL packages page that queues every sendable package from the currently-filtered creator for delivery to the user's Telegram.

**Architecture:** A new server action `sendAllFromCreatorAction(creatorName)` mirrors the existing `sendAllInGroupAction`: it fetches sendable packages for the creator, dedups against live `BotSendRequest`s, creates a `BotSendRequest` per package, and fires `pg_notify('bot_send', id)`. The bot's existing `send-listener` consumes these unchanged. The client table renders a "Send all from [Creator]" button in the packages-tab toolbar only when `?creator=<name>` is active, wired to the action with a confirm dialog and a count toast.

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma v7, server actions, `pg_notify`, sonner toasts, lucide-react icons.

**Testing note:** This repo has no test framework (`CLAUDE.md`: "Testing is manual"). Verification for each task is `npm run lint` + `npm run build`, plus manual UI checks at the end. Do not scaffold a test harness.

---

### Task 1: Add `sendAllFromCreatorAction` server action

**Files:**
- Modify: `src/app/(app)/stls/actions.ts` (append new action after `sendAllInGroupAction`, which ends at line 591)

Reference implementation to mirror: `sendAllInGroupAction` at `src/app/(app)/stls/actions.ts:515-591`.
Existing imports already present in the file (do not re-add): `auth` from `@/lib/auth`, `prisma` from `@/lib/prisma`, `ActionResult` from `@/types/api.types`, `revalidatePath` from `next/cache`.
`ActionResult` is generic: `ActionResult<T = void>` (`src/types/api.types.ts`).

- [ ] **Step 1: Append the new action**

Add this to the end of `src/app/(app)/stls/actions.ts`:

```ts
export async function sendAllFromCreatorAction(
  creatorName: string
): Promise<ActionResult<{ queued: number; skipped: number }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const creator = creatorName.trim();
  if (!creator) {
    return { success: false, error: "No creator specified" };
  }

  try {
    const telegramLink = await prisma.telegramLink.findUnique({
      where: { userId: session.user.id },
    });

    if (!telegramLink) {
      return { success: false, error: "No linked Telegram account. Link one in Settings." };
    }

    const sendablePackages = await prisma.package.findMany({
      where: {
        creator,
        destChannelId: { not: null },
        destMessageId: { not: null },
      },
      select: { id: true },
    });

    if (sendablePackages.length === 0) {
      return { success: false, error: "No uploaded packages found for this creator" };
    }

    let queued = 0;
    let skipped = 0;
    for (const pkg of sendablePackages) {
      // Only create if no existing PENDING/SENDING request for this package+link combo
      const existing = await prisma.botSendRequest.findFirst({
        where: {
          packageId: pkg.id,
          telegramLinkId: telegramLink.id,
          status: { in: ["PENDING", "SENDING"] },
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      const sendRequest = await prisma.botSendRequest.create({
        data: {
          packageId: pkg.id,
          telegramLinkId: telegramLink.id,
          requestedByUserId: session.user.id,
          status: "PENDING",
        },
      });

      // Notify the bot via pg_notify
      try {
        await prisma.$queryRawUnsafe(
          `SELECT pg_notify('bot_send', $1)`,
          sendRequest.id
        );
      } catch {
        // Best-effort — the bot also polls periodically
      }

      queued++;
    }

    revalidatePath("/stls");
    return { success: true, data: { queued, skipped } };
  } catch {
    return { success: false, error: "Failed to send creator packages" };
  }
}
```

- [ ] **Step 2: Verify lint + typecheck pass**

Run: `npm run lint`
Expected: no new errors in `src/app/(app)/stls/actions.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/stls/actions.ts
git commit -m "feat(stls): add sendAllFromCreatorAction server action"
```

---

### Task 2: Wire up the toolbar button in the STL table

**Files:**
- Modify: `src/app/(app)/stls/_components/stl-table.tsx`
  - lucide import (line 6)
  - actions import block (lines 44-54)
  - handler (after `handleSendAllInGroup`, which ends at line 278)
  - `activeCreator` derivation (near `activeTag` at line 445)
  - toolbar JSX (packages-tab toolbar row starting at line 478)

- [ ] **Step 1: Add the `Send` icon to the lucide import**

Change line 6 from:

```ts
import { Search, Layers, Upload } from "lucide-react";
```

to:

```ts
import { Search, Layers, Upload, Send } from "lucide-react";
```

- [ ] **Step 2: Import the new action**

In the actions import block (lines 44-54), add `sendAllFromCreatorAction` next to `sendAllInGroupAction`:

```ts
import {
  updatePackageCreator,
  updatePackageTags,
  renameGroupAction,
  dissolveGroupAction,
  createGroupAction,
  removeFromGroupAction,
  sendAllInGroupAction,
  sendAllFromCreatorAction,
  updateGroupPreviewAction,
  mergeGroupsAction,
} from "../actions";
```

- [ ] **Step 3: Derive the active creator from the URL**

Immediately after the `activeTag` line (`src/app/(app)/stls/_components/stl-table.tsx:445`):

```ts
  const activeTag = searchParams.get("tag") ?? "";
```

add:

```ts
  const activeCreator = searchParams.get("creator") ?? "";
```

- [ ] **Step 4: Add the click handler**

After `handleSendAllInGroup` (which ends at line 278), add:

```ts
  const handleSendAllFromCreator = useCallback(() => {
    if (!confirm(`Send all packages from "${activeCreator}" to your Telegram?`)) return;
    startTransition(async () => {
      const result = await sendAllFromCreatorAction(activeCreator);
      if (result.success) {
        const { queued, skipped } = result.data;
        toast.success(
          `Queued ${queued} package${queued === 1 ? "" : "s"} from ${activeCreator}` +
            (skipped ? ` (${skipped} already queued)` : "")
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }, [activeCreator, router]);
```

- [ ] **Step 5: Render the toolbar button**

In the packages-tab toolbar (`flex flex-wrap items-center gap-2` row at line 478), add the button right after the "Upload Files" button (which closes at line 507, before the `selectedPackages.size >= 2` block at line 508):

```tsx
            {activeCreator && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={handleSendAllFromCreator}
              >
                <Send className="h-3.5 w-3.5" />
                Send all from {activeCreator}
              </Button>
            )}
```

- [ ] **Step 6: Verify lint + build pass**

Run: `npm run lint && npm run build`
Expected: no new errors; build completes.

- [ ] **Step 7: Manual verification**

1. `npm run dev`, open `/stls`.
2. Click a creator name in the Creator column to apply `?creator=<name>` (or navigate to `/stls?creator=<known creator>`).
3. Confirm the "Send all from [Creator]" button appears in the toolbar.
4. Remove the creator filter → confirm the button disappears.
5. Click the button → confirm the dialog appears; on confirm, a toast reports the queued count.
6. (If a linked Telegram account + uploaded packages exist) confirm packages arrive via the bot.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(app\)/stls/_components/stl-table.tsx
git commit -m "feat(stls): add 'send all from creator' toolbar button"
```

---

### Task 3: Searchable creator filter combobox (makes the filter reachable)

**Why:** Discovered during execution — the `?creator=` filter that reveals the Task 2
button had no UI trigger. The creator table cell click only opens the edit prompt
(`package-columns.tsx:339` → `onSetCreator`). This task adds a searchable
"All Creators" combobox to the packages-tab toolbar (like the existing Tags select,
but type-to-filter since there can be many creators). The creator cell stays
edit-only.

**Files:**
- Modify: `src/lib/telegram/queries.ts` — add `getAllPackageCreators()`.
- Modify: `src/app/(app)/stls/page.tsx` — fetch + pass `availableCreators`.
- Create: `src/app/(app)/stls/_components/creator-filter.tsx` — the combobox.
- Modify: `src/app/(app)/stls/_components/stl-table.tsx` — new prop, handler, render.

- [ ] **Step 1: Add the distinct-creators query**

Append to `src/lib/telegram/queries.ts` (mirrors `getAllPackageTags` at line 530):

```ts
export async function getAllPackageCreators(): Promise<string[]> {
  const result = await prisma.$queryRaw<{ creator: string }[]>`
    SELECT DISTINCT creator FROM packages
    WHERE creator IS NOT NULL AND creator <> ''
    ORDER BY creator
  `;
  return result.map((r) => r.creator);
}
```

- [ ] **Step 2: Create the combobox component**

Create `src/app/(app)/stls/_components/creator-filter.tsx` (mirrors the
Popover+Command pattern in `src/components/shared/data-table-faceted-filter.tsx`):

```tsx
"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface CreatorFilterProps {
  creators: string[];
  value: string; // active creator, "" when none
  onChange: (creator: string) => void; // "" clears the filter
}

export function CreatorFilter({ creators, value, onChange }: CreatorFilterProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-[200px] justify-between"
        >
          <span className="truncate">{value || "All Creators"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search creators..." className="h-9" />
          <CommandList>
            <CommandEmpty>No creators found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value === "" ? "opacity-100" : "opacity-0")}
                />
                All Creators
              </CommandItem>
              {creators.map((creator) => (
                <CommandItem
                  key={creator}
                  value={creator}
                  onSelect={() => {
                    onChange(creator);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === creator ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{creator}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Wire the query through the page**

In `src/app/(app)/stls/page.tsx`:
- Add `getAllPackageCreators` to the import from `@/lib/telegram/queries` (line 3).
- Add `getAllPackageCreators()` to the `Promise.all` (line 27) and destructure
  `availableCreators`:
  ```ts
  const [result, ingestionStatus, availableTags, availableCreators, skippedCount, ungroupedCount] =
    await Promise.all([
      // ...existing entries unchanged...
      getIngestionStatus(),
      getAllPackageTags(),
      getAllPackageCreators(),
      countSkippedPackages(),
      countUngroupedPackages(),
    ]);
  ```
  (Insert `getAllPackageCreators()` immediately after `getAllPackageTags()`, and add
  `availableCreators` in the matching position of the destructure.)
- Pass the prop to `<StlTable>`: `availableCreators={availableCreators}` (next to
  `availableTags={availableTags}`).

- [ ] **Step 4: Add prop + handler + render in the table**

In `src/app/(app)/stls/_components/stl-table.tsx`:
- Import the component: `import { CreatorFilter } from "./creator-filter";`
- Add to `StlTableProps` (next to `availableTags: string[];`): `availableCreators: string[];`
- Add to the destructured params (next to `availableTags,`): `availableCreators,`
- Add the handler after `updateTagFilter` (ends ~line 210):
  ```ts
  const updateCreatorFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("creator", value);
        params.set("page", "1");
      } else {
        params.delete("creator");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );
  ```
- Render it in the toolbar right after the Tags `Select` block (the
  `{availableTags.length > 0 && (...)}` block, ~lines 507-522):
  ```tsx
  {availableCreators.length > 0 && (
    <CreatorFilter
      creators={availableCreators}
      value={activeCreator}
      onChange={updateCreatorFilter}
    />
  )}
  ```

- [ ] **Step 5: Verify + manual test**

Run: `npx tsc --noEmit` (filter for the touched files — expect none new). Note: full
`npm run build` fails on a pre-existing stale Prisma client issue in
`src/lib/telegram/*` unrelated to this change; do not attempt to fix it.
Manual: open `/stls`, use the "All Creators" combobox, type to filter, pick a
creator → list filters and the "Send all from [Creator]" button appears; pick
"All Creators" → filter clears and button disappears.

- [ ] **Step 6: Commit**

```bash
git add "src/lib/telegram/queries.ts" "src/app/(app)/stls/page.tsx" \
  "src/app/(app)/stls/_components/creator-filter.tsx" \
  "src/app/(app)/stls/_components/stl-table.tsx"
git commit -m "feat(stls): add searchable creator filter combobox to toolbar"
```

---

## Self-Review

**Spec coverage:**
- Req 1 (button when filtered by creator) → Task 2 Step 5 (`{activeCreator && ...}`).
- Req 2 (hidden when no filter) → Task 2 Step 5 conditional.
- Req 3 (confirm dialog) → Task 2 Step 4 `confirm(...)`.
- Req 4 (all pages, not current page) → Task 1 queries `prisma.package.findMany` by `creator`, unpaginated.
- Req 5 (skip not-uploaded + dedup live requests) → Task 1 `where` filter on `destChannelId`/`destMessageId` + `existing` check.
- Req 6 (report counts) → Task 1 returns `{ queued, skipped }`; Task 2 Step 4 toast.
- Req 7 (no polling) → Task 2 handler queues + `router.refresh()`, no poll loop.
- Blank-creator guard → Task 1 `creator.trim()` check.

**Placeholder scan:** No TBD/TODO/placeholder steps; all code shown in full.

**Type consistency:** Action returns `ActionResult<{ queued: number; skipped: number }>`; handler destructures `result.data.{queued,skipped}` inside the `result.success` branch (where `data` is typed). `sendAllFromCreatorAction` name matches between Task 1 definition, Task 2 import, and Task 2 call site. `activeCreator` defined once (Step 3) and used in Steps 4-5.
