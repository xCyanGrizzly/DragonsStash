# Download and Re-upload Utility for the DragonsStash Worker

## Approach

The utility function `downloadAndReupload` bridges a source Telegram channel message to a destination channel by:

1. **Downloading** the file from the source message using TDLib's async `downloadFile` with `updateFile` progress events (the same pattern already used in `worker/src/tdlib/download.ts`).
2. **Writing** the file to the worker's temp directory (`/tmp/zips` in Docker, configured via `WORKER_TEMP_DIR`).
3. **Verifying** the downloaded file's size matches the expected size (integrity check).
4. **Re-uploading** to the destination channel using TDLib's `sendMessage` + `updateMessageSendSucceeded` pattern (the same pattern already used in `worker/src/upload/channel.ts`).
5. **Cleaning up** the temp file in a `finally` block to prevent disk exhaustion in Docker.

### Docker Considerations

- Uses the existing `/tmp/zips` volume mount (declared in the worker Dockerfile) so large files don't fill the container's overlay filesystem.
- Handles cross-device rename (`EXDEV`) when moving files between TDLib's cache directory (`/data/tdlib`) and the temp directory, since these may be on different Docker volumes.
- Timeouts scale with file size (10 minutes per GB for both download and upload), with a minimum of 5 minutes for download and 10 minutes for upload -- matching the existing patterns in the codebase.
- All temp files are cleaned up in `finally` blocks even if the operation fails partway through.

### 2GB File Support

- TDLib's `downloadFile` with `synchronous: false` handles files up to 2GB natively. The existing codebase already has this pattern working.
- Telegram's upload limit is 2GB per message. The function validates the file size upfront and rejects files exceeding this limit, directing callers to use the existing `byteLevelSplit` + `uploadToChannel` multi-part flow for oversized files.
- Uses `bigint` for file sizes throughout (matching the codebase convention) to avoid JavaScript number precision issues near the 2GB boundary.

## File Location

This utility would be placed at `worker/src/tdlib/reupload.ts`, alongside the existing `download.ts` module.

## Full Code

```typescript
// worker/src/tdlib/reupload.ts

import path from "path";
import { mkdir, unlink, stat } from "fs/promises";
import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { downloadFile } from "./download.ts";
import type { DownloadProgress } from "./download.ts";
import { uploadToChannel } from "../upload/channel.js";
import type { UploadResult } from "../upload/channel.js";

const log = childLogger("reupload");

/** Maximum file size Telegram allows for a single upload (2 GB). */
const MAX_UPLOAD_BYTES = 2n * 1024n * 1024n * 1024n;

export interface ReuploadOptions {
  /** TDLib client instance (must be authenticated). */
  client: Client;
  /** Telegram file ID (numeric string) from the source message. */
  fileId: string;
  /** Original file name. */
  fileName: string;
  /** Expected file size in bytes. */
  fileSize: bigint;
  /** Telegram chat ID of the destination channel. */
  destChatId: bigint;
  /** Optional caption for the re-uploaded message. */
  caption?: string;
  /** Optional callback for download progress. */
  onDownloadProgress?: (progress: DownloadProgress) => void;
  /** Optional subdirectory name inside tempDir (to isolate concurrent operations). */
  tempSubdir?: string;
}

export interface ReuploadResult {
  /** Server-assigned message ID in the destination channel. */
  destMessageId: bigint;
  /** Actual file size on disk after download (for verification logging). */
  actualBytes: number;
}

/**
 * Download a file from a source Telegram channel message and re-upload it
 * to a destination channel.
 *
 * Flow:
 *  1. Validates file size is within Telegram's 2GB upload limit
 *  2. Downloads via TDLib async download with progress tracking
 *  3. Verifies file integrity (size match)
 *  4. Uploads to destination channel, waiting for server confirmation
 *  5. Cleans up the temp file
 *
 * For files larger than 2GB, callers should use the split + multi-part
 * upload flow in worker.ts instead.
 *
 * Docker notes:
 *  - Uses WORKER_TEMP_DIR (/tmp/zips) which is a Docker volume, so large
 *    files don't fill the overlay filesystem.
 *  - Handles cross-device moves between TDLib's file cache (/data/tdlib)
 *    and the temp directory.
 *  - Temp files are always cleaned up, even on failure.
 *
 * @throws Error if fileSize exceeds 2GB (callers should split first)
 * @throws Error if download fails, times out, or produces a size mismatch
 * @throws Error if upload fails or times out
 */
export async function downloadAndReupload(
  opts: ReuploadOptions
): Promise<ReuploadResult> {
  const {
    client,
    fileId,
    fileName,
    fileSize,
    destChatId,
    caption,
    onDownloadProgress,
    tempSubdir,
  } = opts;

  // ── Validate: reject files that exceed Telegram's upload limit ──
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File "${fileName}" is ${Number(fileSize / (1024n * 1024n))}MB, ` +
        `which exceeds Telegram's 2GB upload limit. ` +
        `Use byteLevelSplit + uploadToChannel for oversized files.`
    );
  }

  // ── Prepare temp directory ──
  const workDir = tempSubdir
    ? path.join(config.tempDir, tempSubdir)
    : config.tempDir;
  await mkdir(workDir, { recursive: true });

  const tempPath = path.join(workDir, fileName);

  log.info(
    {
      fileId,
      fileName,
      fileSize: Number(fileSize),
      destChatId: Number(destChatId),
      tempPath,
    },
    "Starting download-and-reupload"
  );

  try {
    // ── Step 1: Download from source ──
    //
    // Uses the existing downloadFile which:
    //  - Starts an async TDLib download (priority 32)
    //  - Listens for updateFile events with progress tracking
    //  - Verifies file size after completion
    //  - Moves from TDLib cache to destPath (handles EXDEV cross-device)
    //  - Times out at max(5min, 10min/GB)
    log.info({ fileId, fileName }, "Downloading from source channel");

    await downloadFile(
      client,
      fileId,
      tempPath,
      fileSize,
      fileName,
      onDownloadProgress
    );

    // Extra safety: verify file exists and has the right size
    const fileStats = await stat(tempPath);
    const actualBytes = fileStats.size;
    const expectedBytes = Number(fileSize);

    if (expectedBytes > 0 && actualBytes !== expectedBytes) {
      throw new Error(
        `Downloaded file size mismatch for "${fileName}": ` +
          `expected ${expectedBytes} bytes, got ${actualBytes} bytes`
      );
    }

    log.info(
      { fileId, fileName, actualBytes },
      "Download complete, starting upload to destination"
    );

    // ── Step 2: Upload to destination channel ──
    //
    // Uses the existing uploadToChannel which:
    //  - Sends via sendMessage with inputFileLocal
    //  - Listens for updateMessageSendSucceeded for the real server message ID
    //  - Handles FLOOD_WAIT rate limits automatically
    //  - Times out at max(10min, 10min/GB)
    const uploadResult: UploadResult = await uploadToChannel(
      client,
      destChatId,
      [tempPath],
      caption
    );

    log.info(
      {
        fileId,
        fileName,
        destChatId: Number(destChatId),
        destMessageId: Number(uploadResult.messageId),
        actualBytes,
      },
      "Download-and-reupload completed successfully"
    );

    return {
      destMessageId: uploadResult.messageId,
      actualBytes,
    };
  } finally {
    // ── Always clean up temp file ──
    // Critical in Docker to prevent /tmp/zips volume from filling up,
    // especially when processing many large files in sequence.
    try {
      await unlink(tempPath);
      log.debug({ tempPath }, "Cleaned up temp file");
    } catch {
      // File may not exist if download failed before writing
    }
  }
}

/**
 * Convenience wrapper that downloads and re-uploads multiple files
 * (e.g., multipart archive parts) from a source channel to a destination.
 *
 * Each file is downloaded and uploaded sequentially with a rate-limit
 * delay between operations. Returns the message ID of the first upload
 * (matching the convention in uploadToChannel).
 *
 * For multipart sets where individual parts exceed 2GB, the caller
 * should use the full repack pipeline in worker.ts (concatenate +
 * byteLevelSplit) instead of this function.
 */
export async function downloadAndReuploadMultiple(
  client: Client,
  files: Array<{
    fileId: string;
    fileName: string;
    fileSize: bigint;
  }>,
  destChatId: bigint,
  caption?: string,
  onDownloadProgress?: (fileIndex: number, progress: DownloadProgress) => void,
  tempSubdir?: string
): Promise<ReuploadResult> {
  if (files.length === 0) {
    throw new Error("No files provided for download-and-reupload");
  }

  let firstResult: ReuploadResult | null = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Only set caption on the first file (matching uploadToChannel convention)
    const fileCaption = i === 0 ? caption : undefined;

    const result = await downloadAndReupload({
      client,
      fileId: file.fileId,
      fileName: file.fileName,
      fileSize: file.fileSize,
      destChatId,
      caption: fileCaption,
      onDownloadProgress: onDownloadProgress
        ? (progress) => onDownloadProgress(i, progress)
        : undefined,
      tempSubdir,
    });

    if (i === 0) {
      firstResult = result;
    }

    // Rate limit delay between operations
    if (i < files.length - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.apiDelayMs)
      );
    }
  }

  return firstResult!;
}
```

## How It Fits Into the Existing Codebase

The function composes the two existing building blocks:

- **`downloadFile`** from `worker/src/tdlib/download.ts` -- handles async download with `updateFile` events, progress tracking, timeout, size verification, and cross-device file moves (critical for Docker where `/data/tdlib` and `/tmp/zips` are separate volumes).
- **`uploadToChannel`** from `worker/src/upload/channel.ts` -- handles `sendMessage` with `updateMessageSendSucceeded` confirmation, upload progress via `updateFile`, and FLOOD_WAIT retry.

Both are wrapped with `withFloodWait` internally, so the utility automatically handles Telegram rate limiting.

The `downloadAndReupload` function is a focused utility that can be called from the worker pipeline or any other part of the system that needs to transfer a file between channels. The existing `processOneArchiveSet` in `worker.ts` does a similar download-then-upload flow but with additional steps (hashing, dedup, metadata extraction, splitting). This utility extracts the core transfer operation for simpler use cases.

## Usage Example

```typescript
import { downloadAndReupload } from "./tdlib/reupload.js";

// Transfer a single file from source to destination
const result = await downloadAndReupload({
  client,
  fileId: "12345",
  fileName: "archive.zip",
  fileSize: 1_500_000_000n, // ~1.5 GB
  destChatId: -1001234567890n,
  caption: "Re-uploaded archive",
  onDownloadProgress: (progress) => {
    console.log(`Download: ${progress.percent}%`);
  },
  tempSubdir: `reupload_${Date.now()}`,
});

console.log(`Uploaded as message ${result.destMessageId}`);
```
