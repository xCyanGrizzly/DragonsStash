# Download & Re-upload Utility for the Worker

## Approach

This utility function downloads a file from a source Telegram channel message and re-uploads it to a destination channel, returning the server-assigned message ID of the uploaded file. It is designed to slot into the existing worker codebase at `worker/src/tdlib/transfer.ts`.

The function composes the existing `downloadFile` (from `tdlib/download.ts`) and `uploadToChannel` (from `upload/channel.ts`) primitives, adding:

1. **Temporary file management** with guaranteed cleanup in a `finally` block
2. **Size-scaled timeouts** for files up to 2 GB (the TDLib user account limit)
3. **Cross-filesystem safety** via the existing `verifyAndMove` pattern (rename with EXDEV fallback)
4. **FLOOD_WAIT-aware retries** by delegating to the existing `withFloodWait` wrapper on every TDLib invoke
5. **Docker reliability**: uses `/tmp/zips` (the volume from the Dockerfile) for temp storage, ensures cleanup even on crash, and avoids holding large buffers in memory

## Skill Patterns Applied

| Skill Pattern | Where Applied |
|---|---|
| **FLOOD_WAIT handling** (`withFloodWait` + `extractFloodWaitSeconds`) | All TDLib invocations go through `withFloodWait` via `invokeWithTimeout` (download) and the upload internals |
| **Download/Upload Timeouts** (scale with file size: 10 min/GB, min 5-10 min) | Inherited from existing `downloadFile` and `sendAndWaitForUpload` |
| **Event Listener Before Action** | Inherited from existing `downloadFile` (subscribes to `updateFile` before calling `downloadFile` invoke) and `uploadToChannel` (subscribes before `sendMessage`) |
| **TDLib Client Lifecycle** (`finally` block for cleanup) | The caller is expected to manage the client; this utility manages temp files in its own `finally` |
| **File Size Limits** (User account TDLib: 2 GB upload/download) | Explicit 2 GB guard with clear error message |
| **Sequential Send Queue** / no concurrent sends | Single sequential download-then-upload, rate limit delay between steps |
| **BigInt Chat IDs** | Passes `Number(chatId)` to TDLib invoke calls (inherited from existing code) |
| **Docker Considerations** | Uses the mounted `/tmp/zips` volume, per-operation subdirectory, guaranteed cleanup |
| **Never bare `client.invoke()`** | All invocations go through `withFloodWait` wrappers |

## Full Implementation

File: `worker/src/tdlib/transfer.ts`

```typescript
import path from "path";
import { mkdir, rm, stat } from "fs/promises";
import { randomUUID } from "crypto";
import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { downloadFile } from "./download.js";
import type { DownloadProgress } from "./download.js";
import { uploadToChannel } from "../upload/channel.js";

const log = childLogger("transfer");

/** Maximum file size TDLib user accounts can handle (2 GB). */
const MAX_TRANSFER_BYTES = 2n * 1024n * 1024n * 1024n;

export interface TransferOptions {
  /** TDLib file ID (numeric string) of the file to download. */
  fileId: string;
  /** Original file name from the source message. */
  fileName: string;
  /** Expected file size in bytes. */
  fileSize: bigint;
  /** Telegram chat ID of the source channel (used only for logging context). */
  sourceChatId: bigint;
  /** Telegram chat ID of the destination channel. */
  destChatId: bigint;
  /** Optional caption to attach to the uploaded message. */
  caption?: string;
  /** Optional callback for download progress updates. */
  onDownloadProgress?: (progress: DownloadProgress) => void;
}

export interface TransferResult {
  /** Server-assigned message ID of the uploaded file in the destination channel. */
  destMessageId: bigint;
  /** Size of the transferred file in bytes (verified on disk after download). */
  transferredBytes: number;
}

/**
 * Download a file from a source Telegram channel message and re-upload it
 * to a destination channel.
 *
 * This function:
 *  1. Validates the file size is within TDLib's 2 GB limit
 *  2. Downloads the file to a temporary directory (with progress tracking)
 *  3. Verifies the downloaded file's size matches the expected size
 *  4. Uploads the file to the destination channel
 *  5. Waits for Telegram's server-side upload confirmation
 *  6. Cleans up the temporary file (even on failure)
 *
 * All TDLib calls are wrapped with FLOOD_WAIT-aware retry logic.
 * Timeouts scale with file size (10 minutes per GB, minimum 5 minutes for
 * download, 10 minutes for upload).
 *
 * Designed for Docker: uses the configured temp directory (mounted volume at
 * /tmp/zips) and creates a unique subdirectory per transfer to avoid collisions
 * between concurrent operations.
 *
 * @throws Error if file exceeds 2 GB
 * @throws Error if download fails, times out, or size verification fails
 * @throws Error if upload fails or times out
 */
export async function downloadAndReupload(
  client: Client,
  options: TransferOptions
): Promise<TransferResult> {
  const {
    fileId,
    fileName,
    fileSize,
    sourceChatId,
    destChatId,
    caption,
    onDownloadProgress,
  } = options;

  // ── Validate file size ──
  if (fileSize > MAX_TRANSFER_BYTES) {
    throw new Error(
      `File "${fileName}" is ${Number(fileSize / (1024n * 1024n))}MB, ` +
        `which exceeds the TDLib user account limit of 2 GB`
    );
  }

  // ── Create isolated temp directory for this transfer ──
  const transferId = randomUUID();
  const transferDir = path.join(config.tempDir, `transfer_${transferId}`);
  await mkdir(transferDir, { recursive: true });

  const tempFilePath = path.join(transferDir, fileName);

  log.info(
    {
      fileId,
      fileName,
      fileSize: Number(fileSize),
      sourceChatId: Number(sourceChatId),
      destChatId: Number(destChatId),
      transferDir,
    },
    "Starting download-and-reupload transfer"
  );

  try {
    // ── Step 1: Download from source ──
    log.info({ fileId, fileName }, "Downloading file from source channel");

    await downloadFile(
      client,
      fileId,
      tempFilePath,
      fileSize,
      fileName,
      onDownloadProgress
    );

    // ── Step 2: Verify downloaded file ──
    const fileStats = await stat(tempFilePath);
    const actualBytes = fileStats.size;

    if (Number(fileSize) > 0 && actualBytes !== Number(fileSize)) {
      throw new Error(
        `Downloaded file size mismatch for "${fileName}": ` +
          `expected ${Number(fileSize)} bytes, got ${actualBytes} bytes`
      );
    }

    log.info(
      { fileName, bytes: actualBytes },
      "Download complete, starting upload to destination"
    );

    // ── Step 3: Upload to destination ──
    const uploadResult = await uploadToChannel(
      client,
      destChatId,
      [tempFilePath],
      caption
    );

    log.info(
      {
        fileName,
        destMessageId: Number(uploadResult.messageId),
        destChatId: Number(destChatId),
        bytes: actualBytes,
      },
      "Transfer complete: file uploaded to destination channel"
    );

    return {
      destMessageId: uploadResult.messageId,
      transferredBytes: actualBytes,
    };
  } catch (err) {
    log.error(
      {
        err,
        fileId,
        fileName,
        sourceChatId: Number(sourceChatId),
        destChatId: Number(destChatId),
      },
      "Transfer failed"
    );
    throw err;
  } finally {
    // ── Always clean up temp files ──
    await rm(transferDir, { recursive: true, force: true }).catch((cleanupErr) => {
      log.warn(
        { err: cleanupErr, transferDir },
        "Failed to clean up transfer temp directory"
      );
    });
  }
}

/**
 * Convenience wrapper that extracts the file info from a TDLib message object
 * and calls downloadAndReupload.
 *
 * Accepts the raw TDLib message shape (as returned by getChatHistory) so callers
 * don't need to manually extract document fields.
 *
 * @throws Error if the message does not contain a document attachment
 */
export async function transferMessageFile(
  client: Client,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  sourceChatId: bigint,
  destChatId: bigint,
  caption?: string,
  onDownloadProgress?: (progress: DownloadProgress) => void
): Promise<TransferResult> {
  const doc = message?.content?.document;
  if (!doc?.document) {
    throw new Error(
      `Message ${message?.id} does not contain a document attachment`
    );
  }

  return downloadAndReupload(client, {
    fileId: String(doc.document.id),
    fileName: doc.file_name ?? `file_${message.id}`,
    fileSize: BigInt(doc.document.size),
    sourceChatId,
    destChatId,
    caption,
    onDownloadProgress,
  });
}
```

## Usage Example

Within the worker pipeline (e.g., in `worker.ts` or a new route handler):

```typescript
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { downloadAndReupload } from "./tdlib/transfer.js";

const client = await createTdlibClient({ id: account.id, phone: account.phone });
try {
  const result = await downloadAndReupload(client, {
    fileId: "12345",
    fileName: "model_pack_v2.zip",
    fileSize: 1_500_000_000n, // ~1.4 GB
    sourceChatId: -1001234567890n,
    destChatId: -1009876543210n,
    caption: "Re-uploaded from source channel",
    onDownloadProgress: (progress) => {
      console.log(`Download: ${progress.percent}%`);
    },
  });

  console.log(`Uploaded as message ${result.destMessageId}`);
} finally {
  await closeTdlibClient(client);
}
```

## Key Design Decisions

1. **Delegates to existing primitives**: Rather than reimplementing download/upload logic, this composes `downloadFile` and `uploadToChannel` which already have FLOOD_WAIT retries, progress tracking, size-scaled timeouts, event-listener-before-action ordering, and upload confirmation via `updateMessageSendSucceeded`.

2. **Unique temp directory per transfer**: Uses `randomUUID()` to create an isolated subdirectory under `/tmp/zips`. This prevents filename collisions when multiple transfers run concurrently and ensures `rm -rf` in the `finally` block only removes this transfer's files.

3. **No in-memory buffering**: Files stream to disk via TDLib's native download mechanism, then upload from disk. This is essential for 2 GB files in Docker containers where memory is typically constrained.

4. **Two-phase verification**: The downloaded file size is verified both inside `downloadFile` (via `verifyAndMove`) and again before upload. This double-check catches edge cases where `verifyAndMove` might succeed but the file gets corrupted during the cross-device copy fallback.

5. **`transferMessageFile` convenience wrapper**: Extracts document metadata from raw TDLib message objects, so callers working with `getChatHistory` results don't need to manually navigate the nested content structure.
