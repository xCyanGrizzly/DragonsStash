import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { getActiveAccounts, getPendingAccounts } from "./db/queries.js";
import { runWorkerForAccount, authenticateAccount } from "./worker.js";

const log = childLogger("scheduler");

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let cycleCount = 0;

/**
 * Run one ingestion cycle:
 * 1. Authenticate any PENDING accounts (triggers SMS code flow + auto-fetch channels)
 * 2. Process all active AUTHENTICATED accounts for ingestion
 *
 * All TDLib operations are wrapped in the mutex to ensure only one client
 * runs at a time (also shared with the fetch listener for on-demand requests).
 */
async function runCycle(): Promise<void> {
  if (running) {
    log.warn("Previous cycle still running, skipping");
    return;
  }

  running = true;
  cycleCount++;
  log.info({ cycle: cycleCount }, "Starting ingestion cycle");

  try {
    // ── Phase 1: Authenticate pending accounts ──
    const pendingAccounts = await getPendingAccounts();
    if (pendingAccounts.length > 0) {
      log.info(
        { count: pendingAccounts.length },
        "Found pending accounts, starting authentication"
      );
      for (const account of pendingAccounts) {
        await withTdlibMutex(`auth:${account.phone}`, () =>
          authenticateAccount(account)
        );
      }
    }

    // ── Phase 2: Ingest for authenticated accounts ──
    const accounts = await getActiveAccounts();

    if (accounts.length === 0) {
      log.info("No active authenticated accounts, nothing to ingest");
      return;
    }

    log.info({ accountCount: accounts.length }, "Processing accounts");

    for (const account of accounts) {
      await withTdlibMutex(`ingest:${account.phone}`, () =>
        runWorkerForAccount(account)
      );
    }

    log.info("Ingestion cycle complete");
  } catch (err) {
    log.error({ err }, "Ingestion cycle failed");
  } finally {
    running = false;
  }
}

/**
 * Schedule the next cycle with jitter.
 */
function scheduleNext(): void {
  const intervalMs = config.workerIntervalMinutes * 60 * 1000;
  const jitterMs = Math.random() * config.jitterMinutes * 60 * 1000;
  const delay = intervalMs + jitterMs;

  log.info(
    { nextRunInMinutes: Math.round(delay / 60000) },
    "Next cycle scheduled"
  );

  timer = setTimeout(async () => {
    await runCycle();
    scheduleNext();
  }, delay);
}

/**
 * Start the scheduler. Runs an immediate first cycle, then schedules subsequent ones.
 */
export async function startScheduler(): Promise<void> {
  log.info(
    {
      intervalMinutes: config.workerIntervalMinutes,
      jitterMinutes: config.jitterMinutes,
    },
    "Scheduler starting"
  );

  // Run immediately on start
  await runCycle();

  // Then schedule recurring cycles
  scheduleNext();
}

/**
 * Stop the scheduler gracefully.
 */
export function stopScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log.info("Scheduler stopped");
}
