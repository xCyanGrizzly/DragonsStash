export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  botToken: process.env.BOT_TOKEN ?? "",
  telegramApiId: parseInt(process.env.TELEGRAM_API_ID ?? "0", 10),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  tdlibStateDir: process.env.TDLIB_STATE_DIR ?? "/data/tdlib",
} as const;
