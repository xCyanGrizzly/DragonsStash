import { mkdir } from "fs/promises";
import { config } from "./util/config.js";
import { logger } from "./util/logger.js";
import { markStaleRunsAsFailed } from "./db/queries.js";
import { cleanupTempDir } from "./worker.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { db, pool } from "./db/client.js";

const log = logger.child({ module: "main" });

async function main(): Promise<void> {
  log.info("DragonsStash Telegram Worker starting");
  log.info({ config: { ...config, databaseUrl: "***" } }, "Configuration loaded");

  // Ensure temp directory exists
  await mkdir(config.tempDir, { recursive: true });
  await mkdir(config.tdlibStateDir, { recursive: true });

  // Clean up stale state
  await cleanupTempDir();
  await markStaleRunsAsFailed();

  // Start the scheduler
  await startScheduler();
}

// Graceful shutdown
function shutdown(signal: string): void {
  log.info({ signal }, "Shutdown signal received");
  stopScheduler();

  // Close DB connections
  Promise.all([db.$disconnect(), pool.end()])
    .then(() => {
      log.info("Shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, "Error during shutdown");
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  log.fatal({ err }, "Worker failed to start");
  process.exit(1);
});
