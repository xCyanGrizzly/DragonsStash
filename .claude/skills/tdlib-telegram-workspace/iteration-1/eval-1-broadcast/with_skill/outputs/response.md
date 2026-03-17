# /broadcast Implementation Plan

## Approach

The broadcast feature has two parts:

1. **API endpoint** (`POST /api/telegram/bot/broadcast`) — called from the web app by an admin. It accepts a `message` string, looks up ALL `TelegramLink` records in the database, and triggers the bot to send the message to each linked user via `pg_notify`.
2. **Bot-side handler** — a new `bot_broadcast` pg_notify channel listener in `send-listener.ts` that receives the broadcast payload and sequentially sends the text message to every linked Telegram user.

The `/broadcast` bot command itself is not a user-facing Telegram command (regular users should not be able to trigger it). It is triggered exclusively through the admin API endpoint.

## Skill Patterns Applied

- **Sequential Send Queue** (from skill): Never fire concurrent sends to multiple users. The broadcast iterates users sequentially with `await sleep(50)` between sends (~20 msgs/sec, well under the 30 msgs/sec global bot limit).
- **FLOOD_WAIT handling** (from skill): Every `sendTextMessage` call is wrapped with `withFloodWait()` which extracts the wait duration from errors and retries with jitter.
- **Anti-pattern avoidance**: No `Promise.all(users.map(...))` — that would instantly hit the 30 msg/sec global limit.
- **Message text length limit**: The API endpoint validates that the broadcast message does not exceed 4,096 characters (Telegram's limit from the skill).

---

## File 1: `bot/src/util/flood-wait.ts` (NEW)

Extracted from the skill's recommended FLOOD_WAIT pattern so it can be reused by both existing send logic and the new broadcast logic.

```typescript
import { childLogger } from "./logger.js";

const log = childLogger("flood-wait");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the mandatory wait duration (in seconds) from a Telegram
 * FLOOD_WAIT error.  Returns null when the error is not rate-limit related.
 */
export function extractFloodWaitSeconds(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);

  // Pattern 1: FLOOD_WAIT_30
  const flood = message.match(/FLOOD_WAIT_(\d+)/i);
  if (flood) return parseInt(flood[1], 10);

  // Pattern 2: "retry after 30"
  const retry = message.match(/retry after (\d+)/i);
  if (retry) return parseInt(retry[1], 10);

  // Pattern 3: HTTP 429 without explicit seconds
  if (String((err as any)?.code) === "429") return 30;

  return null; // Not a rate limit error
}

/**
 * Wrap any async Telegram operation with automatic FLOOD_WAIT retry.
 * Adds random jitter (1-5 s) to prevent thundering-herd retries.
 */
export async function withFloodWait<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = extractFloodWaitSeconds(err);
      if (wait === null || attempt >= maxRetries) throw err;

      const jitter = 1000 + Math.random() * 4000;
      log.warn(
        { wait, attempt, jitter: Math.round(jitter) },
        "FLOOD_WAIT received — backing off"
      );
      await sleep(wait * 1000 + jitter);
    }
  }
  throw new Error("Unreachable");
}

export { sleep };
```

---

## File 2: `bot/src/db/queries.ts` (MODIFIED — add one function)

Add this function at the bottom of the existing file, after the `getGlobalDestinationChannel` function:

```typescript
// ── Broadcast ──

/**
 * Fetch ALL TelegramLink records (users who linked their Telegram account).
 * Used by the broadcast feature to send a message to every linked user.
 */
export async function getAllTelegramLinks() {
  return db.telegramLink.findMany({
    select: {
      telegramUserId: true,
      telegramName: true,
    },
  });
}
```

---

## File 3: `bot/src/send-listener.ts` (MODIFIED — add broadcast channel)

Add the `bot_broadcast` channel to the existing listener. The changes are:

### 3a. Add import for the new query and flood-wait utility

At the top of the file, update the imports:

```typescript
import {
  getPendingSendRequest,
  updateSendRequest,
  findMatchingSubscriptions,
  getGlobalDestinationChannel,
  getAllTelegramLinks,           // ← NEW
} from "./db/queries.js";
import { copyMessageToUser, sendTextMessage, sendPhotoMessage } from "./tdlib/client.js";
import { withFloodWait, sleep } from "./util/flood-wait.js"; // ← NEW
```

### 3b. Subscribe to the new pg_notify channel

Inside `connectListener()`, after the existing LISTEN statements, add:

```typescript
await pgClient.query("LISTEN bot_broadcast");
```

### 3c. Add the notification handler

Inside the `pgClient.on("notification", ...)` callback, add the new branch:

```typescript
pgClient.on("notification", (msg) => {
  if (msg.channel === "bot_send" && msg.payload) {
    handleBotSend(msg.payload);
  } else if (msg.channel === "new_package" && msg.payload) {
    handleNewPackage(msg.payload);
  } else if (msg.channel === "bot_broadcast" && msg.payload) {  // ← NEW
    handleBroadcast(msg.payload);
  }
});
```

Update the log message:

```typescript
log.info("Send listener started (bot_send, new_package, bot_broadcast)");
```

### 3d. Add the broadcast handler function

Add this at the bottom of the file (before the existing `escapeHtml` helper):

```typescript
// ── bot_broadcast handler ──

/**
 * Handle a broadcast request.  The payload is a JSON string:
 *   { message: string }
 *
 * Sends the message to every user who has a TelegramLink.
 * Uses a sequential loop with a 50 ms delay between sends (~20 msgs/sec)
 * to stay well under Telegram's 30 msgs/sec global bot limit.
 * Each send is wrapped with withFloodWait to automatically retry on
 * rate-limit errors.
 */
async function handleBroadcast(payload: string): Promise<void> {
  try {
    const data = JSON.parse(payload) as { message: string };
    if (!data.message) {
      log.warn("Broadcast payload missing message — ignoring");
      return;
    }

    const links = await getAllTelegramLinks();
    if (links.length === 0) {
      log.info("Broadcast requested but no linked users found");
      return;
    }

    log.info(
      { recipientCount: links.length },
      "Starting broadcast to all linked users"
    );

    let sent = 0;
    let failed = 0;

    for (const link of links) {
      try {
        await withFloodWait(() =>
          sendTextMessage(link.telegramUserId, data.message, "textParseModeHTML")
        );
        sent++;
      } catch (err) {
        failed++;
        log.warn(
          { err, telegramUserId: link.telegramUserId.toString() },
          "Broadcast send failed for user"
        );
      }
      // ~20 msgs/sec — well under the 30 msgs/sec global bot limit
      await sleep(50);
    }

    log.info({ sent, failed, total: links.length }, "Broadcast completed");
  } catch (err) {
    log.error({ err, payload }, "Failed to process broadcast");
  }
}
```

---

## File 4: `src/app/api/telegram/bot/broadcast/route.ts` (NEW)

This is the Next.js API endpoint that the admin triggers from the web app.

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/telegram/bot/broadcast
 * Send a text message to ALL users who have a linked Telegram account.
 *
 * Body: { message: string }
 *
 * Admin-only. The actual sending is done by the bot process — this endpoint
 * simply validates input and fires a pg_notify('bot_broadcast', ...) signal.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admins can broadcast
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only admins can send broadcast messages" },
      { status: 403 }
    );
  }

  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json(
      { error: "message is required and must be a string" },
      { status: 400 }
    );
  }

  const trimmed = body.message.trim();
  if (trimmed.length === 0) {
    return NextResponse.json(
      { error: "message must not be empty" },
      { status: 400 }
    );
  }

  // Telegram message text limit is 4096 characters
  if (trimmed.length > 4096) {
    return NextResponse.json(
      { error: "message exceeds Telegram's 4096-character limit" },
      { status: 400 }
    );
  }

  // Count how many users will receive the broadcast
  const recipientCount = await prisma.telegramLink.count();
  if (recipientCount === 0) {
    return NextResponse.json(
      { error: "No users have linked Telegram accounts" },
      { status: 400 }
    );
  }

  // Notify the bot via pg_notify
  const payload = JSON.stringify({ message: trimmed });
  try {
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('bot_broadcast', $1)`,
      payload
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to queue broadcast — bot notification channel unavailable" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "QUEUED",
    recipientCount,
    message: `Broadcast queued for ${recipientCount} user(s)`,
  });
}
```

---

## Summary of Changes

| File | Action | Description |
|------|--------|-------------|
| `bot/src/util/flood-wait.ts` | NEW | Reusable FLOOD_WAIT retry + sleep utilities (from skill) |
| `bot/src/db/queries.ts` | MODIFIED | Add `getAllTelegramLinks()` query |
| `bot/src/send-listener.ts` | MODIFIED | Subscribe to `bot_broadcast` channel; add `handleBroadcast()` with sequential send loop |
| `src/app/api/telegram/bot/broadcast/route.ts` | NEW | Admin-only API endpoint that validates input and fires `pg_notify` |

## Skill Patterns Used

1. **Sequential Send Queue**: The broadcast loop sends messages one at a time with `await sleep(50)` between each, keeping throughput at ~20 msgs/sec — safely under the 30 msgs/sec bot global limit documented in the skill.

2. **FLOOD_WAIT handling with `withFloodWait()`**: Every `sendTextMessage` call is wrapped so that if Telegram returns a `FLOOD_WAIT_X` error, the bot automatically waits the required duration plus random jitter (1-5s) before retrying. This prevents the entire broadcast from failing due to a temporary rate limit.

3. **Message text length validation**: The API endpoint rejects messages over 4,096 characters, which is the `message_text_length_max` limit documented in the skill.

4. **No concurrent sends (anti-pattern avoidance)**: The skill explicitly warns against `Promise.all(users.map(...))` for bulk sends. The implementation uses a sequential `for...of` loop instead.

5. **pg_notify pattern**: Follows the existing project convention (seen in `bot_send` and `new_package`) where the web app fires a `pg_notify` and the bot's `send-listener.ts` picks it up — keeping the two processes decoupled.
