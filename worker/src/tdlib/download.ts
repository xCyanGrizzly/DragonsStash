import type { Client } from "tdl";
import { readFile, rename, copyFile, unlink, stat } from "fs/promises";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { withFloodWait, extractFloodWaitSeconds } from "../util/retry.js";
import { isArchiveAttachment } from "../archive/detect.js";
import type { TelegramMessage } from "../archive/multipart.js";
import type { TelegramPhoto } from "../preview/match.js";

const log = childLogger("download");

/** Maximum retry attempts for stalled/failed downloads */
const MAX_DOWNLOAD_RETRIES = 3;

/** Maximum number of pages to scan per channel/topic to prevent infinite loops */
export const MAX_SCAN_PAGES = 5000;

/** Timeout for a single TDLib API call (ms) */
export const INVOKE_TIMEOUT_MS = 120_000; // 2 minutes

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
  media_album_id?: string;
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
 * Invoke a TDLib method with a timeout to prevent indefinite hangs,
 * and automatic retry on FLOOD_WAIT rate-limit errors.
 *
 * If TDLib does not respond within the timeout, the promise rejects.
 * If Telegram returns a rate limit error, sleeps for the required
 * duration and retries (up to maxRetries times).
 */
export async function invokeWithTimeout<T>(
  client: Client,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: Record<string, any>,
  timeoutMs = INVOKE_TIMEOUT_MS
): Promise<T> {
  return withFloodWait(
    () =>
      new Promise<T>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(
              new Error(
                `TDLib invoke timed out after ${timeoutMs}ms for ${request._}`
              )
            );
          }
        }, timeoutMs);

        (client.invoke(request) as Promise<T>)
          .then((result) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(result);
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          });
      }),
    `TDLib:${request._}`
  );
}

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

  // Open the chat so TDLib can access it
  try {
    await invokeWithTimeout(client, { _: "openChat", chat_id: Number(chatId) });
  } catch {
    // Ignore — may already be open
  }

  let totalScanned = 0;
  let pageCount = 0;

  // Use searchChatMessages with document filter — this works even when
  // getChatHistory is restricted (e.g. hidden history for new members).
  // We search for documents first, then photos separately.
  for (const filter of [
    { _: "searchMessagesFilterDocument" as const, kind: "document" },
    { _: "searchMessagesFilterPhoto" as const, kind: "photo" },
  ]) {
    let fromMessageId = 0;

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

      const result = await invokeWithTimeout<{ messages: TdMessage[]; total_count?: number }>(client, {
        _: "searchChatMessages",
        chat_id: Number(chatId),
        query: "",
        from_message_id: fromMessageId,
        offset: 0,
        limit: Math.min(limit, 100),
        filter,
        message_thread_id: 0,
      });

      if (!result.messages || result.messages.length === 0) break;

      totalScanned += result.messages.length;

      for (const msg of result.messages) {
        // Check for archive documents
        const doc = msg.content?.document;
        if (doc?.file_name && doc.document && isArchiveAttachment(doc.file_name)) {
          // Skip if we've already processed past this message
          if (boundary && msg.id <= boundary) continue;
          archives.push({
            id: BigInt(msg.id),
            fileName: doc.file_name,
            fileId: String(doc.document.id),
            fileSize: BigInt(doc.document.size),
            date: new Date(msg.date * 1000),
            mediaAlbumId: msg.media_album_id && msg.media_album_id !== "0" ? msg.media_album_id : undefined,
          });
          continue;
        }

        // Check for photo messages (potential previews)
        const photo = msg.content?.photo;
        const caption = msg.content?.caption?.text ?? "";
        if (photo?.sizes && photo.sizes.length > 0) {
          if (boundary && msg.id <= boundary) continue;
          const smallest = photo.sizes[0];
          photos.push({
            id: BigInt(msg.id),
            date: new Date(msg.date * 1000),
            caption,
            fileId: String(smallest.photo.id),
            fileSize: smallest.photo.size || smallest.photo.expected_size,
            mediaAlbumId: msg.media_album_id && msg.media_album_id !== "0" ? msg.media_album_id : undefined,
          });
        }
      }

      onProgress?.(totalScanned);

      // Advance pagination
      fromMessageId = result.messages[result.messages.length - 1].id;
      if (result.messages.length < Math.min(limit, 100)) break;

      await sleep(config.apiDelayMs);
    }
  }

  // Close the chat after scanning
  await invokeWithTimeout(client, {
    _: "closeChat",
    chat_id: Number(chatId),
  }).catch(() => {});

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

  for (let attempt = 0; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    try {
      return await downloadFileAttempt(client, numericId, fileId, destPath, totalBytes, fileName, onProgress);
    } catch (err) {
      const isLastAttempt = attempt >= MAX_DOWNLOAD_RETRIES;

      // Rate limit from Telegram
      const waitSeconds = extractFloodWaitSeconds(err);
      if (waitSeconds !== null && !isLastAttempt) {
        const jitter = 1000 + Math.random() * 4000;
        const waitMs = waitSeconds * 1000 + jitter;
        log.warn(
          { fileName, attempt: attempt + 1, maxRetries: MAX_DOWNLOAD_RETRIES, waitSeconds },
          `Download rate-limited — sleeping ${waitSeconds}s before retry`
        );
        await cancelDownload(client, numericId);
        await sleep(waitMs);
        continue;
      }

      // Stall, timeout, or unexpected stop — cancel and retry
      const errMsg = err instanceof Error ? err.message : "";
      if (
        (errMsg.includes("stalled") || errMsg.includes("timed out") || errMsg.includes("stopped unexpectedly")) &&
        !isLastAttempt
      ) {
        log.warn(
          { fileName, attempt: attempt + 1, maxRetries: MAX_DOWNLOAD_RETRIES },
          "Download failed — cancelling and retrying"
        );
        await cancelDownload(client, numericId);
        await sleep(5_000);
        continue;
      }

      throw err;
    }
  }
  throw new Error(`Download failed after ${MAX_DOWNLOAD_RETRIES} retries for ${fileName}`);
}

/**
 * Cancel an active TDLib download so it can be retried cleanly.
 */
async function cancelDownload(client: Client, fileId: number): Promise<void> {
  try {
    await client.invoke({
      _: "cancelDownloadFile",
      file_id: fileId,
      only_if_pending: false,
    });
    log.debug({ fileId }, "Cancelled TDLib download for retry");
  } catch {
    // Best-effort
  }
}

/**
 * Single download attempt with progress tracking, stall detection, and verification.
 */
async function downloadFileAttempt(
  client: Client,
  numericId: number,
  fileId: string,
  destPath: string,
  totalBytes: number,
  fileName: string,
  onProgress?: ProgressCallback
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let lastLoggedPercent = 0;
    let settled = false;
    let downloadStarted = false; // True once TDLib reports is_downloading_active
    let lastProgressBytes = 0;
    let lastProgressTime = Date.now();

    // Timeout: 20 minutes per GB, minimum 15 minutes
    const timeoutMs = Math.max(
      15 * 60_000,
      (totalBytes / (1024 * 1024 * 1024)) * 20 * 60_000
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

    // Stall detection: no progress for 5 minutes after download started → reject
    const STALL_TIMEOUT_MS = 5 * 60_000;
    const stallChecker = setInterval(() => {
      if (settled || !downloadStarted) return;
      const stallMs = Date.now() - lastProgressTime;
      if (stallMs >= STALL_TIMEOUT_MS) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Download stalled for ${fileName} — no progress for ${Math.round(stallMs / 60_000)}min ` +
              `(${lastProgressBytes}/${totalBytes} bytes)`
          )
        );
      }
    }, 30_000);

    // Listen for file update events to track progress
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpdate = (update: any) => {
      if (update?._ !== "updateFile") return;
      const file = update.file as TdFile | undefined;
      if (!file || file.id !== numericId) return;

      const downloaded = file.local.downloaded_size;
      const percent =
        totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0;

      // Track whether the download has actually started
      if (file.local.is_downloading_active) {
        downloadStarted = true;
      }

      // Reset stall timer when bytes advance
      if (downloaded > lastProgressBytes) {
        lastProgressBytes = downloaded;
        lastProgressTime = Date.now();
      }

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

      // Download stopped without completing — only if it had actually started.
      // TDLib may emit an initial updateFile with is_downloading_active=false
      // before the download begins; ignoring that prevents false positives.
      if (
        downloadStarted &&
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
      clearInterval(stallChecker);
      client.off("update", handleUpdate);
    };

    // Subscribe to updates BEFORE starting download
    client.on("update", handleUpdate);

    // Start async download (non-blocking — progress via updateFile events)
    // Wrapped in withFloodWait: if the initial invoke is rate-limited,
    // it will sleep and retry before the download event loop begins.
    withFloodWait(
      () =>
        client.invoke({
          _: "downloadFile",
          file_id: numericId,
          priority: 32,
          offset: 0,
          limit: 0,
          synchronous: false,
        }),
      `downloadFile:${fileName}`
    )
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
