import { mkdir } from "fs/promises";
import { config } from "./util/config.js";
import { logger } from "./util/logger.js";
import { markStaleRunsAsFailed } from "./db/queries.js";
import { cleanupTempDir } from "./worker.js";
import { recoverIncompleteUploads } from "./recovery.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startFetchListener, stopFetchListener } from "./fetch-listener.js";
import { db, pool } from "./db/client.js";

const log = logger.child({ module: "main" });

async function main(): Promise<void> {
  log.info("DragonsStash Telegram Worker starting");
  log.info({ config: { ...config, databaseUrl: "***" } }, "Configuration loaded");

  if (!config.telegramApiId || !config.telegramApiHash) {
    log.fatal("TELEGRAM_API_ID and TELEGRAM_API_HASH are both required");
    process.exit(1);
  }

  // Ensure temp directory exists
  await mkdir(config.tempDir, { recursive: true });
  await mkdir(config.tdlibStateDir, { recursive: true });

  // Clean up stale state
  await cleanupTempDir();
  await markStaleRunsAsFailed();

  // Release any advisory locks orphaned by a previous worker instance.
  // When Docker kills a container, PostgreSQL may keep the session alive
  // (zombie connections), holding advisory locks that block the new worker.
  try {
    const result = await pool.query(`
      SELECT pid, state, left(query, 80) as query, age(clock_timestamp(), state_change) as idle_time
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid != pg_backend_pid()
        AND state = 'idle'
        AND query LIKE '%pg_try_advisory_lock%'
        AND state_change < clock_timestamp() - interval '5 minutes'
    `);
    for (const row of result.rows) {
      log.warn(
        { pid: row.pid, idleTime: row.idle_time, query: row.query },
        "Terminating stale advisory lock session from previous worker"
      );
      await pool.query("SELECT pg_terminate_backend($1)", [row.pid]);
    }
    if (result.rows.length > 0) {
      log.info({ terminated: result.rows.length }, "Cleaned up stale advisory lock sessions");
    }
  } catch (err) {
    log.warn({ err }, "Failed to clean up stale advisory locks (non-fatal)");
  }

  // Verify destination messages exist for all "uploaded" packages.
  // Resets any packages whose dest message is missing so they get re-processed.
  await recoverIncompleteUploads();

  // Start the fetch listener (pg_notify for on-demand channel fetching)
  await startFetchListener();

  // Start the scheduler
  await startScheduler();
}

// Graceful shutdown
function shutdown(signal: string): void {
  log.info({ signal }, "Shutdown signal received");

  // Stop accepting new work
  stopFetchListener();

  // Wait for any active cycle to finish before closing DB
  stopScheduler()
    .then(() => Promise.all([db.$disconnect(), pool.end()]))
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
