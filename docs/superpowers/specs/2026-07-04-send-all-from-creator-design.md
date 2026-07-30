# Send All From Creator — Design

**Date:** 2026-07-04
**Status:** Approved for planning

## Summary

Add a "Send all from [Creator]" button to the STL packages page that queues every
sendable package from a given creator for delivery to the user's Telegram. The
button appears in the packages-tab toolbar only when the list is filtered by a
single creator (`?creator=<name>`).

This reuses the existing single-send infrastructure (`BotSendRequest` +
`pg_notify('bot_send', id)` + the bot's `send-listener`) and closely mirrors the
existing `sendAllInGroupAction`. No bot, DB schema, or send-listener changes are
required.

## Context

Relevant existing pieces:

- **Creator field:** `Package.creator` is a nullable, indexed `String` on the
  `Package` model (`prisma/schema.prisma:476-524`). Filtering by exact creator is
  cheap.
- **Creator filter:** The packages list already supports `?creator=<name>`
  (`src/app/(app)/stls/page.tsx:22,38`), rendered by the packages column as a
  clickable value (`package-columns.tsx`).
- **Single send:** `send-to-telegram-button.tsx` → `POST /api/telegram/bot/send`
  creates a `BotSendRequest` (status `PENDING`) and fires
  `pg_notify('bot_send', requestId)`; the button then polls the request to
  completion.
- **Existing bulk send (group):** `sendAllInGroupAction(groupId)` in
  `src/app/(app)/stls/actions.ts:515-591` fetches the group's packages, filters to
  those with `destChannelId` + `destMessageId`, skips any with an existing
  `PENDING`/`SENDING` request for the same package + telegram link, creates a
  `BotSendRequest` per remaining package, and fires `pg_notify` per package. It is
  wired into the table via `handleSendAllInGroup` (`stl-table.tsx:264-278`) with a
  `confirm()` dialog and a success toast — no polling.
- **Bot side:** `bot/src/send-listener.ts` processes every `BotSendRequest`
  uniformly; nothing there needs to change.

## Requirements

1. When the packages tab is filtered by a single creator (`?creator=<name>` is
   present), show a toolbar button labeled **"Send all from [Creator]"**.
2. When no creator filter is active, the button is not rendered.
3. Clicking the button shows a confirmation dialog before sending (consistent with
   the single-send and group-send flows, since this pushes files to Telegram).
4. On confirm, queue **all** sendable packages from that creator across all pages —
   not just the current page.
5. Skip packages that are not yet uploaded (missing `destChannelId` /
   `destMessageId`) and packages that already have a `PENDING`/`SENDING` request for
   the same package + telegram link (dedup).
6. Report real counts back to the user via toast, e.g.
   "Queued 12 packages from [Creator]" and, when applicable, a skipped count.
7. No polling — the bulk action queues and returns; sends process in the background
   via the bot listener (same behavior as group send).

## Design

### Server action — `sendAllFromCreatorAction(creatorName: string)`

New action in `src/app/(app)/stls/actions.ts`, mirroring `sendAllInGroupAction`:

1. Auth check (`auth()`), return `Unauthorized` if no session.
2. Load the user's `TelegramLink`; if none, return
   "No linked Telegram account. Link one in Settings."
3. Reject an empty/blank `creatorName` (guard against sending the entire "no
   creator" set — see Edge cases).
4. Fetch sendable packages directly with a `where` filter (no in-memory filtering):
   ```ts
   prisma.package.findMany({
     where: {
       creator: creatorName,
       destChannelId: { not: null },
       destMessageId: { not: null },
     },
     select: { id: true },
   })
   ```
5. If none, return "No uploaded packages found for this creator."
6. For each package, skip if an existing `PENDING`/`SENDING` `BotSendRequest`
   exists for that package + telegram link; otherwise create a `BotSendRequest`
   (status `PENDING`) and fire `pg_notify('bot_send', id)` (best-effort, wrapped in
   try/catch — the bot also polls).
7. `revalidatePath("/stls")`.
8. Return counts so the UI can show them. This is a small improvement over
   `sendAllInGroupAction`, which currently returns `{ success: true, data: undefined }`.
   Shape:
   ```ts
   { success: true, data: { queued: number, skipped: number } }
   ```
   where `skipped` counts packages that already had a live request. (Packages not
   yet uploaded are excluded by the query and not counted as skipped.)

### UI — toolbar button in `stl-table.tsx`

- Derive the active creator from the URL: `const activeCreator =
  searchParams.get("creator") ?? "";` (parallel to the existing
  `activeTag` at `stl-table.tsx:445`).
- In the packages-tab toolbar (`stl-table.tsx:478` `flex flex-wrap items-center
  gap-2` row), render the button only when `activeCreator` is non-empty:
  ```tsx
  {activeCreator && (
    <Button variant="outline" size="sm" className="h-9 gap-1.5"
            onClick={handleSendAllFromCreator}>
      <Send className="h-3.5 w-3.5" />
      Send all from {activeCreator}
    </Button>
  )}
  ```
  (Reuse the icon already used by the send action; place near the Upload / Group
  buttons.)
- Add `handleSendAllFromCreator`, modeled on `handleSendAllInGroup`
  (`stl-table.tsx:264-278`):
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
- Import `sendAllFromCreatorAction` alongside the existing `sendAllInGroupAction`
  import (`stl-table.tsx:51`).

### Data flow

```
User (filtered by creator) → clicks button → confirm dialog
  → sendAllFromCreatorAction(creatorName)
    → for each sendable, un-queued package: create BotSendRequest + pg_notify
  → returns { queued, skipped } → toast + router.refresh()

(background) bot send-listener consumes each BotSendRequest → delivers to user
```

## Edge cases

- **Blank creator:** The action rejects an empty/whitespace `creatorName` so a
  stray `?creator=` never queues every package. The UI already gates the button on
  a non-empty `activeCreator`, so this is defense-in-depth.
- **No linked Telegram account:** Returns an error toast, queues nothing.
- **No uploaded packages for creator:** Returns an error toast, queues nothing.
- **All packages already queued:** `queued: 0`, `skipped: N` → toast reflects it.
- **pg_notify failure:** Swallowed per-package (best-effort); the bot's periodic
  poll picks the request up. Matches existing behavior.

## Out of scope / non-goals

- No per-row "send all from this creator" action (toolbar-only, per decision).
- No progress polling / live completion tracking for the bulk send.
- No changes to the bot, `send-listener`, `BotSendRequest` schema, or API routes.
- No batching/throttling beyond what the bot listener already does.

## Files touched

- `src/app/(app)/stls/actions.ts` — add `sendAllFromCreatorAction`.
- `src/app/(app)/stls/_components/stl-table.tsx` — derive `activeCreator`, add
  `handleSendAllFromCreator`, render the toolbar button, import the new action.
