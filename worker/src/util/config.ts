export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  workerIntervalMinutes: parseInt(process.env.WORKER_INTERVAL_MINUTES ?? "60", 10),
  tempDir: process.env.WORKER_TEMP_DIR ?? "/tmp/zips",
  tdlibStateDir: process.env.TDLIB_STATE_DIR ?? "/data/tdlib",
  maxZipSizeMB: parseInt(process.env.WORKER_MAX_ZIP_SIZE_MB ?? "204800", 10),
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  telegramApiId: parseInt(process.env.TELEGRAM_API_ID ?? "0", 10),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  /** Maximum file part size for Telegram upload (in MiB). Default 1950 (under 2GB non-Premium limit).
   *  Set to 3900 for Premium accounts (under 4GB limit). */
  maxPartSizeMB: parseInt(process.env.MAX_PART_SIZE_MB ?? "1950", 10),
  /** Time window for auto-grouping ungrouped packages from the same channel (minutes). 0 = disabled. */
  autoGroupTimeWindowMinutes: parseInt(process.env.AUTO_GROUP_TIME_WINDOW_MINUTES ?? "5", 10),
  /** Maximum jitter added to scheduler interval (in minutes) */
  jitterMinutes: 5,
  /** Maximum time span for multipart archive parts (in hours). 0 = no limit. */
  multipartTimeoutHours: parseInt(process.env.MULTIPART_TIMEOUT_HOURS ?? "0", 10),
  /** Delay between Telegram API calls (in ms) to avoid rate limits */
  apiDelayMs: 1000,
  /** Max retries for rate-limited requests */
  maxRetries: 5,
  /** After this many failed attempts on the same source message, the worker
   *  stops auto-retrying and lets the watermark advance past it. The user can
   *  manually retry via the UI to reset and try again. */
  maxSkipAttempts: parseInt(process.env.WORKER_MAX_SKIP_ATTEMPTS ?? "5", 10),
  /** Window in which a recent successful empty scan lets us skip the next
   *  scan entirely. Default 5 minutes. */
  skipRecentScanWindowMs: parseInt(
    process.env.WORKER_SKIP_RECENT_SCAN_WINDOW_MS ?? "300000",
    10
  ),
  /** After this many consecutive empty scans, a channel/topic enters
   *  backoff and is only scanned every Nth cycle. */
  emptyScanBackoffThreshold: parseInt(
    process.env.WORKER_EMPTY_SCAN_BACKOFF_THRESHOLD ?? "5",
    10
  ),
  /** While in backoff, scan only every Nth cycle. Default 5 = scan every
   *  fifth cycle = once every ~5 hours given the 60-min default interval. */
  emptyScanBackoffEveryNth: parseInt(
    process.env.WORKER_EMPTY_SCAN_BACKOFF_EVERY_NTH ?? "5",
    10
  ),
} as const;
