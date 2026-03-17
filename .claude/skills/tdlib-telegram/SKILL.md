---
name: tdlib-telegram
description: >
  Reference guide for building Telegram integrations with TDLib (tdl/node).
  Covers rate limits, FLOOD_WAIT handling, file size constraints, bot vs user account
  differences, and safe code patterns. Use this skill whenever writing or modifying code
  that calls Telegram APIs via TDLib, the Bot API, or any Telegram client library — including
  sending messages, downloading/uploading files, scanning channels, forwarding messages,
  managing subscriptions, or handling notifications. Also use when debugging 429 errors,
  FLOOD_WAIT, or silent message drops.
---

# TDLib / Telegram Development Guide

This skill provides the rate limits, constraints, and patterns you need to write correct
Telegram integrations. The limits below come from official Telegram documentation and
well-established community findings (Telegram does not publish exact numbers for all limits).

## Telegram Rate Limits

These are approximate safe boundaries. Telegram's actual limits are dynamic and depend on
account age, history, and request type. The correct strategy is to respect these as guidelines
and always handle FLOOD_WAIT errors gracefully.

### Bot Accounts

| Operation | Limit | Notes |
|-----------|-------|-------|
| Messages to same chat | ~1 msg/sec | Bursts OK, sustained exceeds limit |
| Messages in a group | 20 msgs/min | Hard limit per group chat |
| Bulk notifications (different users) | ~30 msgs/sec | Global across all chats |
| Message edits in a group | ~20 edits/min | Community-observed |
| API requests (global) | ~30 req/sec | All request types combined |
| Paid broadcasts | up to 1000 msgs/sec | Requires Telegram Stars balance |

### User Accounts (TDLib)

| Operation | Limit | Notes |
|-----------|-------|-------|
| API requests (global) | ~30 req/sec | All request types combined |
| Messages in a group | ~20 msgs/min | Same as bot |
| Channel history reads | No published limit | But pagination + delay is essential |
| Joining groups | Very strict | FLOOD_WAIT often 30-300+ seconds |

### File Size Limits

| Context | Upload | Download |
|---------|--------|----------|
| Bot API (standard) | 50 MB | 20 MB |
| Bot API (local server) | 2,000 MB | 2,000 MB |
| User account (TDLib) | 2 GB | 2 GB |
| Premium user (TDLib) | 4 GB | 4 GB |

### Message & Content Limits

| Item | Limit |
|------|-------|
| Message text length | 4,096 chars |
| Media caption | 1,024 chars (4,096 premium) |
| Album / media group | 10 items max |
| Forwarded messages per request | `forwarded_message_count_max` (TDLib option) |
| Inline keyboard buttons | 100 entities |
| Formatting entities per message | 100 |
| Scheduled messages per chat | 100 |
| Bot commands | 100 max |

### Forum & Group Limits

| Item | Limit |
|------|-------|
| Topics per group | 1,000,000 |
| Topic title | 128 chars |
| Group members | 200,000 |
| Admins per group | 50 |
| Bots per group | 20 |
| Pinned topics | 5 |

## FLOOD_WAIT — How It Works

When you exceed rate limits, Telegram returns a `FLOOD_WAIT_X` error (or HTTP 429 with
`retry_after`). This is a **mandatory pause** — the value `X` is the number of seconds you
must wait before ANY request will succeed. It blocks the entire client, not just the
operation that triggered it.

### The Right Way to Handle It

```typescript
// Extract the wait duration from the error
function extractFloodWaitSeconds(err: unknown): number | null {
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

// Wrap any TDLib call with automatic retry
async function withFloodWait<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = extractFloodWaitSeconds(err);
      if (wait === null || attempt >= maxRetries) throw err;

      // Add 1-5s jitter to prevent thundering herd
      const jitter = 1000 + Math.random() * 4000;
      await sleep(wait * 1000 + jitter);
    }
  }
  throw new Error("Unreachable");
}
```

### Key Rules

- **Always respect the wait duration.** Never retry before `retry_after` expires.
- **Add jitter.** Without it, multiple clients retry simultaneously and trigger another FLOOD_WAIT.
- **Non-rate-limit errors should fail fast.** Only retry on FLOOD_WAIT, not on other errors.
- **Don't artificially throttle below ~1 req/sec.** Telegram's own guidance (via grammY docs)
  is to send requests as fast as you need and handle 429 errors. Fixed low-frequency throttling
  wastes throughput without preventing floods.

## Code Patterns

### Pattern: Sequential Send Queue

When sending notifications to multiple users, use a sequential queue with a per-message delay.
Never fire concurrent sends — you will hit the 30 msg/sec global limit instantly.

```typescript
let sendQueue: Promise<void> = Promise.resolve();

function queueSend(chatId: bigint, text: string): void {
  sendQueue = sendQueue
    .then(() => withFloodWait(() => sendTextMessage(chatId, text)))
    .then(() => sleep(50)) // ~20 msgs/sec, well under 30 limit
    .catch((err) => log.error({ err, chatId }, "Send failed"));
}
```

### Pattern: Paginated Scanning with Delay

When reading channel history or enumerating topics, always add a delay between pages:

```typescript
while (hasMorePages) {
  const result = await invokeWithTimeout(client, { _: "getChatHistory", ... });
  processMessages(result.messages);

  if (result.messages.length < limit) break;

  await sleep(1000); // 1 second between pages — prevents FLOOD_WAIT on large channels
}
```

### Pattern: Event Listener Before Action

When waiting for TDLib async events (upload confirmation, download completion), always
attach the event listener BEFORE starting the operation. If you attach after, fast
operations can complete before the listener exists, causing the promise to hang forever.

```typescript
// CORRECT: listener first, then action
client.on("update", handleUpdate);
const tempMsg = await client.invoke({ _: "sendMessage", ... });
tempMsgId = tempMsg.id; // handler now knows which message to match

// WRONG: action first, then listener — race condition!
const tempMsg = await client.invoke({ _: "sendMessage", ... });
client.on("update", handleUpdate); // may miss updateMessageSendSucceeded
```

### Pattern: Download/Upload Timeouts

Scale timeouts with file size. TDLib downloads/uploads are asynchronous — without a timeout,
a stalled transfer hangs the entire pipeline.

```typescript
const timeoutMs = Math.max(
  10 * 60_000,                    // minimum 10 minutes
  (fileSizeMB / 1024) * 10 * 60_000  // 10 minutes per GB
);
```

### Pattern: TDLib Client Lifecycle

Always close TDLib clients in a `finally` block. Unclosed clients leak memory and file
descriptors, and can leave TDLib's internal database locked.

```typescript
const client = await createTdlibClient(account);
try {
  // ... use client ...
} finally {
  await closeTdlibClient(client);
}
```

## Anti-Patterns

### Never: Concurrent TDLib Sends Without Queue

```typescript
// BAD: fires all sends concurrently — will trigger FLOOD_WAIT immediately
await Promise.all(users.map((u) => sendTextMessage(u.chatId, msg)));

// GOOD: sequential with delay
for (const user of users) {
  await withFloodWait(() => sendTextMessage(user.chatId, msg));
  await sleep(50);
}
```

### Never: Bare client.invoke() Without Retry

Every `client.invoke()` call can return FLOOD_WAIT at any time. Bare calls will crash
on rate limits instead of retrying.

```typescript
// BAD: crashes on FLOOD_WAIT
await client.invoke({ _: "sendMessage", ... });

// GOOD: retries automatically
await withFloodWait(() => client.invoke({ _: "sendMessage", ... }));
```

### Never: Retry Without Respecting retry_after

```typescript
// BAD: fixed 1-second retry ignores Telegram's wait requirement
catch (err) { await sleep(1000); retry(); }

// GOOD: extract and respect the actual wait time
catch (err) {
  const wait = extractFloodWaitSeconds(err);
  if (wait !== null) await sleep(wait * 1000 + jitter);
  else throw err;
}
```

### Never: Ignore FLOOD_WAIT in Bots

Bot accounts get the same FLOOD_WAIT as user accounts. The bot API's 429 response
blocks ALL operations for the specified duration — not just the chat that triggered it.
A single unhandled flood in a notification loop can make the entire bot unresponsive.

## Bot vs User Account Differences

| Capability | Bot | User (TDLib) |
|-----------|-----|-------------|
| Read channel history | No (unless admin) | Yes |
| Send to users who haven't started bot | No | N/A |
| Join groups via invite link | No (must be added) | Yes |
| Forward messages (send_copy) | Yes | Yes |
| File upload limit | 50 MB (standard API) | 2 GB |
| File download limit | 20 MB (standard API) | 2 GB |
| Auth method | Bot token | Phone + SMS code |
| Rate limit profile | Same FLOOD_WAIT | Same FLOOD_WAIT |

## TDLib-Specific Notes

### BigInt Chat IDs

TDLib uses numeric chat IDs. Supergroups and channels use negative IDs (e.g., `-1001234567890`).
When passing to `client.invoke()`, convert with `Number(chatId)` — TDLib's JSON interface
doesn't handle BigInt. Be aware that very large IDs may lose precision with `Number()`,
though current Telegram IDs are within safe integer range.

### TDLib Options (Runtime Queryable)

These are read-only values you can query at runtime via `getOption`:
- `message_text_length_max` — max message text length
- `message_caption_length_max` — max caption length
- `forwarded_message_count_max` — max forwards per request

### Session State

TDLib persists session state to disk. Each account needs its own state directory.
Running two clients on the same state directory simultaneously will corrupt the database.
Use separate directories per account, and separate volumes in Docker for worker vs bot.

## Docker Considerations

- **prebuilt-tdlib**: The `prebuilt-tdlib` npm package provides platform-specific TDLib
  binaries. Container base image must match (e.g., `node:20-bookworm-slim` for Debian x64).
- **Volumes**: Mount persistent volumes for TDLib state directories — losing state forces
  full re-authentication.
- **Graceful shutdown**: Wait for active operations to finish before closing DB connections.
  TDLib operations in flight will fail if the database pool is closed underneath them.
- **Health checks**: TDLib services don't expose HTTP — use database connectivity as the
  health signal instead.
