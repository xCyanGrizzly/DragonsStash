# Diagnosis: FLOOD_WAIT_35 During Channel Scanning

## Root Cause

The `getChannelMessages` function in `worker/src/tdlib/download.ts` (line 146) paginates through channel history using `getChatHistory` with a fixed 1-second delay between pages (`config.apiDelayMs = 1000`). While each individual `getChatHistory` call is wrapped in `invokeWithTimeout` which delegates to `withFloodWait` for retry logic, the pagination loop itself has a fundamental problem for large channels:

**A 10,000-message channel at 100 messages/page = 100 consecutive API calls.** With only a 1-second delay between pages, this sustained burst of ~1 req/sec for 100+ seconds eventually triggers Telegram's dynamic rate limiter. Once `FLOOD_WAIT_35` fires, `withFloodWait` does correctly sleep for 35+ seconds and retry that single call -- but the loop immediately resumes its 1-second cadence, triggering another FLOOD_WAIT shortly after. After 5 retries (`config.maxRetries = 5`), the function throws and the worker crashes.

The same issue exists in `getTopicMessages` in `worker/src/tdlib/topics.ts` (line 170), which uses identical pagination logic.

## Why the Current Code Is Almost Right But Not Quite

The codebase already has the right building blocks:

1. `withFloodWait` in `worker/src/util/retry.ts` correctly extracts wait durations and adds jitter -- this matches the skill's recommended FLOOD_WAIT handler pattern exactly.
2. `invokeWithTimeout` in `worker/src/tdlib/download.ts` wraps every TDLib call through `withFloodWait`.
3. There is a 1-second inter-page delay (`config.apiDelayMs`).

**The gap:** After a FLOOD_WAIT recovery, the pagination loop does not back off its inter-page delay. It goes right back to 1-second spacing, which is what triggers repeated FLOOD_WAITs until max retries is exhausted.

## The Fix

Apply **adaptive backoff** to the pagination delay: when a FLOOD_WAIT is encountered during scanning, increase the inter-page delay for subsequent pages. This prevents the "recover then immediately re-trigger" cycle.

### Fix 1: Add adaptive delay to `getChannelMessages` (`worker/src/tdlib/download.ts`)

Replace lines 146-250 with:

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
 *  - Adaptive delay: backs off when FLOOD_WAIT is encountered
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
  let currentDelay = config.apiDelayMs; // starts at 1000ms, adapts on FLOOD_WAIT

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
    } catch (err) {
      // If invokeWithTimeout exhausted its retries on FLOOD_WAIT, check if
      // we can recover at the pagination level by increasing the delay further.
      const waitSec = extractFloodWaitSeconds(err);
      if (waitSec !== null) {
        // The retry wrapper already slept; bump the inter-page delay to
        // prevent the next page from immediately re-triggering.
        currentDelay = Math.min(currentDelay * 2, 30_000);
        log.warn(
          { chatId: chatId.toString(), newDelay: currentDelay, totalScanned },
          "FLOOD_WAIT persisted after retries — increasing inter-page delay and retrying"
        );
        // Sleep the full flood wait duration + jitter before continuing
        const jitter = 1000 + Math.random() * 4000;
        await sleep(waitSec * 1000 + jitter);
        continue; // retry this page with the new delay
      }
      throw err; // non-rate-limit error — propagate
    }

    // Successful call — gradually relax the delay back toward baseline
    if (currentDelay > config.apiDelayMs) {
      currentDelay = Math.max(config.apiDelayMs, Math.floor(currentDelay * 0.8));
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

    // Rate limit delay — adaptive based on FLOOD_WAIT history
    await sleep(currentDelay);
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

You will also need to add the import for `extractFloodWaitSeconds` at the top of `download.ts`:

```typescript
import { withFloodWait, extractFloodWaitSeconds } from "../util/retry.js";
```

### Fix 2: Apply the same pattern to `getTopicMessages` (`worker/src/tdlib/topics.ts`)

The same adaptive delay logic should be applied to the `getTopicMessages` function. Add the import:

```typescript
import { extractFloodWaitSeconds } from "../util/retry.js";
```

Then apply the same changes to the pagination loop (the structure is identical):

```typescript
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
  let currentDelay = config.apiDelayMs;

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
            document?: {
              id: number;
              size: number;
            };
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
    } catch (err) {
      const waitSec = extractFloodWaitSeconds(err);
      if (waitSec !== null) {
        currentDelay = Math.min(currentDelay * 2, 30_000);
        log.warn(
          { chatId: chatId.toString(), topicId: topicId.toString(), newDelay: currentDelay, totalScanned },
          "FLOOD_WAIT persisted after retries — increasing inter-page delay and retrying"
        );
        const jitter = 1000 + Math.random() * 4000;
        await sleep(waitSec * 1000 + jitter);
        continue;
      }
      throw err;
    }

    // Successful call — gradually relax the delay back toward baseline
    if (currentDelay > config.apiDelayMs) {
      currentDelay = Math.max(config.apiDelayMs, Math.floor(currentDelay * 0.8));
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

    await sleep(currentDelay);
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

## Skill Patterns Applied

### 1. FLOOD_WAIT Handling (Skill: "The Right Way to Handle It")

The existing `withFloodWait` and `extractFloodWaitSeconds` in `worker/src/util/retry.ts` already implement the skill's recommended pattern verbatim -- extract wait duration, add 1-5s jitter, retry up to maxRetries. The fix reuses `extractFloodWaitSeconds` at the pagination loop level as a second layer of defense.

### 2. Paginated Scanning with Delay (Skill: "Pattern: Paginated Scanning with Delay")

The skill states: *"When reading channel history or enumerating topics, always add a delay between pages"* and shows a 1-second delay example. The existing code has this (`config.apiDelayMs = 1000`). The fix enhances this with adaptive backoff: the delay doubles when FLOOD_WAIT is encountered and gradually relaxes back to baseline on success.

### 3. Non-rate-limit Errors Should Fail Fast (Skill: "Key Rules")

The skill states: *"Non-rate-limit errors should fail fast. Only retry on FLOOD_WAIT, not on other errors."* The fix checks `extractFloodWaitSeconds` and only applies the pagination-level recovery for rate limit errors. All other errors propagate immediately via `throw err`.

### 4. Always Respect the Wait Duration (Skill: "Key Rules")

The skill states: *"Always respect the wait duration. Never retry before retry_after expires."* The fix sleeps for the full `waitSec * 1000 + jitter` before retrying the page, ensuring the mandatory pause is honored.

### 5. Add Jitter (Skill: "Key Rules")

The skill states: *"Add jitter. Without it, multiple clients retry simultaneously and trigger another FLOOD_WAIT."* Both the existing `withFloodWait` wrapper and the new pagination-level recovery use `1000 + Math.random() * 4000` jitter, consistent with the skill's recommendation.

## Files Affected

- `worker/src/tdlib/download.ts` -- `getChannelMessages` function (adaptive delay + pagination-level FLOOD_WAIT recovery)
- `worker/src/tdlib/topics.ts` -- `getTopicMessages` function (same fix)

## Summary

The crash happens because the pagination loop fires 100+ consecutive `getChatHistory` calls at 1-second intervals. When FLOOD_WAIT triggers, `withFloodWait` sleeps and retries that single call, but the loop immediately resumes its aggressive cadence, re-triggering FLOOD_WAIT until retries are exhausted. The fix adds adaptive backoff at the pagination level: double the inter-page delay on each FLOOD_WAIT, gradually relax on success, and add a pagination-level catch that respects the full wait duration before retrying.
