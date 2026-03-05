import type { Client } from "tdl";
import { readFile, rename, copyFile, unlink, stat } from "fs/promises";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { isArchiveAttachment } from "../archive/detect.js";
import type { TelegramMessage } from "../archive/multipart.js";
import type { TelegramPhoto } from "../preview/match.js";

const log = childLogger("download");

interface TdPhotoSize {
  type: string;
  photo: {
    id: number;
    size: number;
    expected_size: number;
    local?: {
      path?: string;
      is_downloading_active?: boolean;
      is_downloading_completed?: boolean;
      downloaded_size?: number;
    };
  };
  width: number;
  height: number;
}

interface TdMessage {
  id: number;
  date: number;
  content: {
    _: string;
    document?: {
      file_name?: string;
      document?: {
        id: number;
        size: number;
        local?: {
          path?: string;
          is_downloading_completed?: boolean;
        };
      };
    };
    photo?: {
      sizes?: TdPhotoSize[];
    };
    caption?: {
      text?: string;
    };
  };
}

interface TdFile {
  id: number;
  size: number;
  expected_size: number;
  local: {
    path: string;
    is_downloading_active: boolean;
    is_downloading_completed: boolean;
    downloaded_size: number;
    download_offset: number;
  };
}

export interface ChannelScanResult {
  archives: TelegramMessage[];
  photos: TelegramPhoto[];
  totalScanned: number;
}

export type ScanProgressCallback = (messagesScanned: number) => void;

/**
 * Fetch messages from a channel, stopping once we've scanned past the
 * last-processed boundary (with one page of lookback for multipart safety).
 * Collects both archive attachments AND photo messages (for preview matching).
 * Returns messages in chronological order (oldest first).
 *
 * When `lastProcessedMessageId` is null (first run), scans everything.
 * The worker applies a post-grouping filter to skip fully-processed sets,
 * and keeps `packageExistsBySourceMessage` as a safety net.
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = (await client.invoke({
      _: "getChatHistory",
      chat_id: Number(chatId),
      from_message_id: currentFromId,
      offset: 0,
      limit: Math.min(limit, 100),
      only_local: false,
    })) as { messages: TdMessage[] };

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

    // Stop scanning once we've gone past the boundary (this page is the lookback)
    if (boundary && currentFromId < boundary) break;

    if (result.messages.length < 100) break;

    // Rate limit delay
    await sleep(config.apiDelayMs);
  }

  log.info(
    { chatId: chatId.toString(), archives: archives.length, photos: photos.length, totalScanned },
    "Channel scan complete"
  );

  // Reverse to chronological order (oldest first) so worker processes old→new
  return {
    archives: archives.reverse(),
    photos: photos.reverse(),
    totalScanned,
  };
}

/**
 * Download a photo thumbnail from Telegram and return its raw bytes.
 * Uses synchronous download (photos are small, typically < 100KB).
 * Returns null if download fails (non-critical).
 */
export async function downloadPhotoThumbnail(
  client: Client,
  fileId: string
): Promise<Buffer | null> {
  const numericId = parseInt(fileId, 10);

  try {
    const result = (await client.invoke({
      _: "downloadFile",
      file_id: numericId,
      priority: 1, // Low priority — thumbnails are nice-to-have
      offset: 0,
      limit: 0,
      synchronous: true, // Small file — wait for it
    })) as TdFile;

    if (result?.local?.is_downloading_completed && result.local.path) {
      const data = await readFile(result.local.path);
      log.debug(
        { fileId, bytes: data.length },
        "Downloaded photo thumbnail"
      );
      return data;
    }
  } catch (err) {
    log.warn({ fileId, err }, "Failed to download photo thumbnail");
  }

  return null;
}

export interface DownloadProgress {
  fileId: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  isComplete: boolean;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Download a file from Telegram to a local path with progress tracking
 * and integrity verification.
 *
 * Progress flow:
 *  1. Starts async download via TDLib
 *  2. Listens for `updateFile` events to track download progress
 *  3. Logs progress at every 10% increment
 *  4. Once complete, verifies the local file size matches the expected size
 *  5. Moves the file from TDLib's cache to the destination path
 *
 * Verification:
 *  - Compares actual file size on disk to the expected size from Telegram
 *  - Throws on mismatch (partial/corrupt download)
 *  - Throws on timeout (configurable, scales with file size)
 *  - Throws if download stops without completing (network error, etc.)
 */
export async function downloadFile(
  client: Client,
  fileId: string,
  destPath: string,
  expectedSize: bigint,
  fileName: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const numericId = parseInt(fileId, 10);
  const totalBytes = Number(expectedSize);

  log.info(
    { fileId, fileName, destPath, totalBytes },
    "Starting file download"
  );

  // Report initial progress
  onProgress?.({
    fileId,
    fileName,
    downloadedBytes: 0,
    totalBytes,
    percent: 0,
    isComplete: false,
  });

  return new Promise<void>((resolve, reject) => {
    let lastLoggedPercent = 0;
    let settled = false;

    // Timeout: 10 minutes per GB, minimum 5 minutes
    const timeoutMs = Math.max(
      5 * 60_000,
      (totalBytes / (1024 * 1024 * 1024)) * 10 * 60_000
    );
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Download timed out after ${Math.round(timeoutMs / 60_000)}min for ${fileName}`
          )
        );
      }
    }, timeoutMs);

    // Listen for file update events to track progress
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpdate = (update: any) => {
      if (update?._ !== "updateFile") return;
      const file = update.file as TdFile | undefined;
      if (!file || file.id !== numericId) return;

      const downloaded = file.local.downloaded_size;
      const percent =
        totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0;

      // Log at every 10% increment
      if (percent >= lastLoggedPercent + 10) {
        lastLoggedPercent = percent - (percent % 10);
        log.info(
          { fileId, fileName, downloaded, totalBytes, percent: `${percent}%` },
          "Download progress"
        );
      }

      // Report to callback
      onProgress?.({
        fileId,
        fileName,
        downloadedBytes: downloaded,
        totalBytes,
        percent,
        isComplete: file.local.is_downloading_completed,
      });

      // Download finished
      if (file.local.is_downloading_completed) {
        if (!settled) {
          settled = true;
          cleanup();
          verifyAndMove(file.local.path, destPath, totalBytes, fileName, fileId)
            .then(resolve)
            .catch(reject);
        }
      }

      // Download stopped without completing (network error, cancelled, etc.)
      if (
        !file.local.is_downloading_active &&
        !file.local.is_downloading_completed
      ) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            new Error(
              `Download stopped unexpectedly for ${fileName} ` +
                `(${downloaded}/${totalBytes} bytes, ${percent}%)`
            )
          );
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      client.off("update", handleUpdate);
    };

    // Subscribe to updates BEFORE starting download
    client.on("update", handleUpdate);

    // Start async download (non-blocking — progress via updateFile events)
    client
      .invoke({
        _: "downloadFile",
        file_id: numericId,
        priority: 32,
        offset: 0,
        limit: 0,
        synchronous: false,
      })
      .then((result: unknown) => {
        // If the file was already cached locally, invoke returns immediately
        const file = result as TdFile | undefined;
        if (file?.local?.is_downloading_completed && !settled) {
          settled = true;
          cleanup();
          verifyAndMove(file.local.path, destPath, totalBytes, fileName, fileId)
            .then(resolve)
            .catch(reject);
        }
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
  });
}

/**
 * Verify the downloaded file's size matches the expected size,
 * then move it to the destination path.
 */
async function verifyAndMove(
  localPath: string,
  destPath: string,
  expectedBytes: number,
  fileName: string,
  fileId: string
): Promise<void> {
  const stats = await stat(localPath);
  const actualBytes = stats.size;

  if (expectedBytes > 0 && actualBytes !== expectedBytes) {
    log.error(
      { fileId, fileName, expectedBytes, actualBytes },
      "Download size mismatch — file is incomplete or corrupted"
    );
    throw new Error(
      `Download verification failed for ${fileName}: ` +
        `expected ${expectedBytes} bytes, got ${actualBytes} bytes`
    );
  }

  log.info(
    { fileId, fileName, bytes: actualBytes, destPath },
    "File verified and complete"
  );

  // Move from TDLib's cache to our temp directory.
  // Use rename first (fast, same filesystem), fall back to copy+delete
  // when source and destination are on different filesystems (EXDEV).
  try {
    await rename(localPath, destPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      log.debug(
        { fileId, fileName },
        "Cross-device rename — falling back to copy + unlink"
      );
      await copyFile(localPath, destPath);
      await unlink(localPath);
    } else {
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
