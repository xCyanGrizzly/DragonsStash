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
  /** Maximum time between multipart archive parts (in hours) */
  multipartTimeoutHours: 24,
  /** Delay between Telegram API calls (in ms) to avoid rate limits */
  apiDelayMs: 1000,
  /** Max retries for rate-limited requests */
  maxRetries: 5,
} as const;
