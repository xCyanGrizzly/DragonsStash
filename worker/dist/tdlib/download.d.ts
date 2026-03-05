import type { Client } from "tdl";
import type { TelegramMessage } from "../archive/multipart.js";
import type { TelegramPhoto } from "../preview/match.js";
/** Maximum number of pages to scan per channel/topic to prevent infinite loops */
export declare const MAX_SCAN_PAGES = 5000;
/** Timeout for a single TDLib API call (ms) */
export declare const INVOKE_TIMEOUT_MS = 120000;
export interface ChannelScanResult {
    archives: TelegramMessage[];
    photos: TelegramPhoto[];
    totalScanned: number;
}
export type ScanProgressCallback = (messagesScanned: number) => void;
/**
 * Invoke a TDLib method with a timeout to prevent indefinite hangs.
 * If TDLib does not respond within the timeout, the promise rejects.
 */
export declare function invokeWithTimeout<T>(client: Client, request: Record<string, any>, timeoutMs?: number): Promise<T>;
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
export declare function getChannelMessages(client: Client, chatId: bigint, lastProcessedMessageId?: bigint | null, limit?: number, onProgress?: ScanProgressCallback): Promise<ChannelScanResult>;
/**
 * Download a photo thumbnail from Telegram and return its raw bytes.
 * Uses synchronous download (photos are small, typically < 100KB).
 * Returns null if download fails (non-critical).
 */
export declare function downloadPhotoThumbnail(client: Client, fileId: string): Promise<Buffer | null>;
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
export declare function downloadFile(client: Client, fileId: string, destPath: string, expectedSize: bigint, fileName: string, onProgress?: ProgressCallback): Promise<void>;
