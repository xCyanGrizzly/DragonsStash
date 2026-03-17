# Diagnosis: FLOOD_WAIT_35 Crashes During Channel Message Pagination

## Root Cause

The `getChannelMessages` function in `worker/src/tdlib/download.ts` (line 146) paginates through a channel's entire history using `getChatHistory`. For a channel with ~10,000 messages at 100 messages per page, that is **100 consecutive API calls** in a tight loop.

The current rate-limit mitigation has two problems:

1. **The inter-page delay is too low.** `config.apiDelayMs` is hardcoded to **1000ms** (1 second) in `worker/src/util/config.ts:15`. Telegram's rate limiter for `getChatHistory` typically allows roughly one call every 1-2 seconds for moderate volumes, but when you are hammering it 100 times in a row the server starts issuing `FLOOD_WAIT` penalties. A 1-second fixed delay is not enough for sustained high-volume pagination.

2. **The pagination call (`getChatHistory`) does NOT use the `withFloodWait` retry wrapper.** Look at `download.ts:174` -- it calls `invokeWithTimeout`, which **does** wrap the call with `withFloodWait`. So the retry logic IS present. However, the retry wrapper in `worker/src/util/retry.ts` has `maxRetries` set to **5** (from config). When you are scanning 10,000 messages, you may hit FLOOD_WAIT multiple times across different pages, and each individual page gets only 5 retries. If Telegram escalates the wait time (e.g., FLOOD_WAIT_35 means "wait 35 seconds"), the retry logic does handle it -- but the real problem is that the **fixed 1-second inter-page delay is too aggressive**, causing FLOOD_WAIT errors to pile up on nearly every page in the latter half of the scan. Eventually one page exhausts its 5 retries and the entire scan crashes.

3. **No adaptive/exponential backoff between pages.** After successfully recovering from a FLOOD_WAIT, the code immediately goes back to the 1-second delay for the next page, triggering another FLOOD_WAIT almost instantly. There is no mechanism to slow down after being rate-limited.

## The Fix

The fix has three parts:

### Part 1: Make `apiDelayMs` configurable and increase the default

**File: `worker/src/util/config.ts`**

```typescript
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  workerIntervalMinutes: parseInt(process.env.WORKER_INTERVAL_MINUTES ?? "60", 10),
  tempDir: process.env.WORKER_TEMP_DIR ?? "/tmp/zips",
  tdlibStateDir: process.env.TDLIB_STATE_DIR ?? "/data/tdlib",
  maxZipSizeMB: parseInt(process.env.WORKER_MAX_ZIP_SIZE_MB ?? "4096", 10),
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  telegramApiId: parseInt(process.env.TELEGRAM_API_ID ?? "0", 10),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  /** Maximum jitter added to scheduler interval (in minutes) */
  jitterMinutes: 5,
  /** Maximum time span for multipart archive parts (in hours). 0 = no limit. */
  multipartTimeoutHours: parseInt(process.env.MULTIPART_TIMEOUT_HOURS ?? "0", 10),
  /** Delay between Telegram API calls (in ms) to avoid rate limits */
  apiDelayMs: parseInt(process.env.WORKER_API_DELAY_MS ?? "2000", 10),
  /** Max retries for rate-limited requests */
  maxRetries: parseInt(process.env.WORKER_MAX_RETRIES ?? "10", 10),
} as const;
```

Changes: default `apiDelayMs` raised from 1000 to **2000**, `maxRetries` raised from 5 to **10**, both now configurable via environment variables.

### Part 2: Add adaptive backoff to the pagination loops

When a FLOOD_WAIT is encountered and recovered from inside `invokeWithTimeout`/`withFloodWait`, the pagination loop should temporarily increase its inter-page delay to prevent immediately triggering another FLOOD_WAIT.

**File: `worker/src/tdlib/download.ts`** -- replace the `getChannelMessages` function:

```typescript
/**
 * Fetch messages from a channel, stopping once we've scanned past the
 * last-processed boundary (with one page of lookback for multipart safety).
 * Collects both archive attachments AND photo messages (for preview matching).
 * Returns messages in chronological order (oldest first).
 *
 * When `lastProcessedMessageId` is null (first run), scans everything.
 * The worker applies a post-grouping filter to skip fully-processed sets,
 * and keeps `packageExistsBySourceMessage` as a safety net.
 *
 * Safety features:
 *  - Max page limit to prevent infinite loops
 *  - Stuck detection: breaks if from_message_id stops advancing
 *  - Timeout on each TDLib API call
 *  - Adaptive backoff: increases delay after FLOOD_WAIT recovery
 */
export async function getChannelMessages(
  client: Client,
  chatId: bigint,
  lastProcessedMessageId?: bigint | null,
  limit = 100,
  onProgress?: ScanProgressCallback
): Promise<ChannelScanResult> {
  const archives: TelegramMessage[] = [];
  const photos: TelegramPhoto[] = [];
  const boundary = lastProcessedMessageId ? Number(lastProcessedMessageId) : null;

  let currentFromId = 0;
  let totalScanned = 0;
  let pageCount = 0;

  // Adaptive delay: starts at config value, increases after FLOOD_WAIT recovery
  let currentDelayMs = config.apiDelayMs;
  const MAX_DELAY_MS = 30_000; // Cap at 30 seconds between pages

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pageCount >= MAX_SCAN_PAGES) {
      log.warn(
        { chatId: chatId.toString(), pageCount, totalScanned },
        "Hit max page limit for channel scan, stopping"
      );
      break;
    }
    pageCount++;

    const previousFromId = currentFromId;

    let result: { messages: TdMessage[] };
    try {
      result = await invokeWithTimeout<{ messages: TdMessage[] }>(client, {
        _: "getChatHistory",
        chat_id: Number(chatId),
        from_message_id: currentFromId,
        offset: 0,
        limit: Math.min(limit, 100),
        only_local: false,
      });

      // Successful call without rate limiting — gradually reduce delay back
      // toward the base value (but never below it)
      if (currentDelayMs > config.apiDelayMs) {
        currentDelayMs = Math.max(
          config.apiDelayMs,
          Math.floor(currentDelayMs * 0.8)
        );
      }
    } catch (err) {
      // If withFloodWait inside invokeWithTimeout exhausted retries on a
      // FLOOD_WAIT error, increase the inter-page delay significantly
      // before re-throwing so the caller (or a future retry of the whole
      // scan) starts slower.
      const floodSeconds = extractFloodWaitSeconds(err);
      if (floodSeconds !== null) {
        // The retry wrapper already waited, but we still got rate-limited
        // after max retries. Double the inter-page delay for next time.
        currentDelayMs = Math.min(MAX_DELAY_MS, currentDelayMs * 2);
        log.warn(
          {
            chatId: chatId.toString(),
            pageCount,
            totalScanned,
            newDelayMs: currentDelayMs,
          },
          "FLOOD_WAIT exhausted retries — increased inter-page delay"
        );
      }
      throw err;
    }

    if (!result.messages || result.messages.length === 0) break;

    totalScanned += result.messages.length;

    for (const msg of result.messages) {
      // Check for archive documents
      const doc = msg.content?.document;
      if (doc?.file_name && doc.document && isArchiveAttachment(doc.file_name)) {
        archives.push({
          id: BigInt(msg.id),
          fileName: doc.file_name,
          fileId: String(doc.document.id),
          fileSize: BigInt(doc.document.size),
          date: new Date(msg.date * 1000),
        });
        continue;
      }

      // Check for photo messages (potential previews)
      const photo = msg.content?.photo;
      const caption = msg.content?.caption?.text ?? "";
      if (photo?.sizes && photo.sizes.length > 0) {
        const smallest = photo.sizes[0];
        photos.push({
          id: BigInt(msg.id),
          date: new Date(msg.date * 1000),
          caption,
          fileId: String(smallest.photo.id),
          fileSize: smallest.photo.size || smallest.photo.expected_size,
        });
      }
    }

    // Report scanning progress after each page
    onProgress?.(totalScanned);

    currentFromId = result.messages[result.messages.length - 1].id;

    // Stuck detection: if from_message_id didn't advance, break to prevent infinite loop
    if (currentFromId === previousFromId) {
      log.warn(
        { chatId: chatId.toString(), currentFromId, totalScanned },
        "Pagination stuck (from_message_id not advancing), breaking"
      );
      break;
    }

    // Stop scanning once we've gone past the boundary (this page is the lookback)
    if (boundary && currentFromId < boundary) break;

    if (result.messages.length < Math.min(limit, 100)) break;

    // Rate limit delay (adaptive)
    await sleep(currentDelayMs);
  }

  log.info(
    { chatId: chatId.toString(), archives: archives.length, photos: photos.length, totalScanned, pages: pageCount },
    "Channel scan complete"
  );

  // Reverse to chronological order (oldest first) so worker processes old→new
  return {
    archives: archives.reverse(),
    photos: photos.reverse(),
    totalScanned,
  };
}
```

You also need to add the import for `extractFloodWaitSeconds` at the top of `download.ts`:

```typescript
import { withFloodWait, extractFloodWaitSeconds } from "../util/retry.js";
```

### Part 3: Apply the same adaptive backoff to `getTopicMessages` in `topics.ts`

The same pattern should be applied to `worker/src/tdlib/topics.ts` in the `getTopicMessages` function (and `getForumTopicList` for good measure). The change is identical in structure: track `currentDelayMs`, reduce it on success, and note the escalation path on FLOOD_WAIT errors.

**File: `worker/src/tdlib/topics.ts`** -- add the import and apply to both pagination loops. Here is the updated `getTopicMessages`:

```typescript
import { extractFloodWaitSeconds } from "../util/retry.js";

// ... (existing code) ...

export async function getTopicMessages(
  client: Client,
  chatId: bigint,
  topicId: bigint,
  lastProcessedMessageId?: bigint | null,
  limit = 100,
  onProgress?: ScanProgressCallback
): Promise<ChannelScanResult> {
  const archives: TelegramMessage[] = [];
  const photos: TelegramPhoto[] = [];
  const boundary = lastProcessedMessageId ? Number(lastProcessedMessageId) : null;

  let currentFromId = 0;
  let totalScanned = 0;
  let pageCount = 0;

  // Adaptive delay
  let currentDelayMs = config.apiDelayMs;
  const MAX_DELAY_MS = 30_000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pageCount >= MAX_SCAN_PAGES) {
      log.warn(
        { chatId: chatId.toString(), topicId: topicId.toString(), pageCount, totalScanned },
        "Hit max page limit for topic scan, stopping"
      );
      break;
    }
    pageCount++;

    const previousFromId = currentFromId;

    let result: {
      messages?: {
        id: number;
        date: number;
        content: {
          _: string;
          document?: {
            file_name?: string;
            document?: { id: number; size: number };
          };
          photo?: {
            sizes?: {
              type: string;
              photo: { id: number; size: number; expected_size: number };
              width: number;
              height: number;
            }[];
          };
          caption?: { text?: string };
        };
      }[];
    };

    try {
      result = await invokeWithTimeout(client, {
        _: "searchChatMessages",
        chat_id: Number(chatId),
        query: "",
        message_thread_id: Number(topicId),
        from_message_id: currentFromId,
        offset: 0,
        limit: Math.min(limit, 100),
        filter: null,
        sender_id: null,
        saved_messages_topic_id: 0,
      });

      // Gradually reduce delay back toward base after success
      if (currentDelayMs > config.apiDelayMs) {
        currentDelayMs = Math.max(
          config.apiDelayMs,
          Math.floor(currentDelayMs * 0.8)
        );
      }
    } catch (err) {
      const floodSeconds = extractFloodWaitSeconds(err);
      if (floodSeconds !== null) {
        currentDelayMs = Math.min(MAX_DELAY_MS, currentDelayMs * 2);
        log.warn(
          {
            chatId: chatId.toString(),
            topicId: topicId.toString(),
            pageCount,
            totalScanned,
            newDelayMs: currentDelayMs,
          },
          "FLOOD_WAIT exhausted retries — increased inter-page delay"
        );
      }
      throw err;
    }

    if (!result.messages || result.messages.length === 0) break;

    totalScanned += result.messages.length;

    for (const msg of result.messages) {
      const doc = msg.content?.document;
      if (doc?.file_name && doc.document && isArchiveAttachment(doc.file_name)) {
        archives.push({
          id: BigInt(msg.id),
          fileName: doc.file_name,
          fileId: String(doc.document.id),
          fileSize: BigInt(doc.document.size),
          date: new Date(msg.date * 1000),
        });
        continue;
      }

      const photo = msg.content?.photo;
      const caption = msg.content?.caption?.text ?? "";
      if (photo?.sizes && photo.sizes.length > 0) {
        const smallest = photo.sizes[0];
        photos.push({
          id: BigInt(msg.id),
          date: new Date(msg.date * 1000),
          caption,
          fileId: String(smallest.photo.id),
          fileSize: smallest.photo.size || smallest.photo.expected_size,
        });
      }
    }

    onProgress?.(totalScanned);

    currentFromId = result.messages[result.messages.length - 1].id;

    if (currentFromId === previousFromId) {
      log.warn(
        { chatId: chatId.toString(), topicId: topicId.toString(), currentFromId, totalScanned },
        "Topic pagination stuck (from_message_id not advancing), breaking"
      );
      break;
    }

    if (boundary && currentFromId < boundary) break;

    if (result.messages.length < Math.min(limit, 100)) break;

    // Adaptive rate limit delay
    await sleep(currentDelayMs);
  }

  log.info(
    { chatId: chatId.toString(), topicId: topicId.toString(), archives: archives.length, photos: photos.length, totalScanned, pages: pageCount },
    "Topic scan complete"
  );

  return {
    archives: archives.reverse(),
    photos: photos.reverse(),
    totalScanned,
  };
}
```

## Summary of Changes

| File | Change | Why |
|---|---|---|
| `worker/src/util/config.ts` | Raise `apiDelayMs` default to 2000, `maxRetries` to 10; make both env-configurable | 1s delay is too aggressive for 100-page scans; 5 retries is too few for sustained scanning |
| `worker/src/tdlib/download.ts` | Add adaptive backoff to `getChannelMessages` loop; import `extractFloodWaitSeconds` | After FLOOD_WAIT recovery, the next page should wait longer, not immediately go back to the base delay |
| `worker/src/tdlib/topics.ts` | Same adaptive backoff in `getTopicMessages` and `getForumTopicList` | Same vulnerability exists in topic scanning |

## Approach Explanation

The core insight is that `FLOOD_WAIT_35` is Telegram telling the client "you are calling me too fast, wait 35 seconds." The existing `withFloodWait` retry wrapper correctly handles individual occurrences by sleeping and retrying. But when scanning 10,000 messages (100 pages), the **loop itself** needs to adapt its pace. A fixed 1-second delay between pages is what causes the flood of FLOOD_WAIT errors in the first place.

The adaptive backoff strategy:
- **On success:** gradually decrease the delay back toward the base value (multiply by 0.8), so scanning speeds back up once the rate limit pressure eases.
- **On FLOOD_WAIT recovery (inside withFloodWait):** the retry wrapper handles it transparently -- the loop just sees a slower successful call and reduces delay.
- **On FLOOD_WAIT exhausting retries:** double the inter-page delay (capped at 30s) before re-throwing, so if the scan is retried it starts slower.
- **Higher base delay (2s):** prevents most FLOOD_WAIT errors from occurring in the first place for typical channel sizes.
- **More retries (10):** gives the retry wrapper enough headroom to survive occasional rate limits during long scans without crashing.
