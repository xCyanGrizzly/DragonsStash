import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { getActiveAccounts } from "./db/queries.js";
import { runWorkerForAccount } from "./worker.js";

const log = childLogger("scheduler");

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run one ingestion cycle: process all active, authenticated accounts sequentially.
 */
async function runCycle(): Promise<void> {
  if (running) {
    log.warn("Previous cycle still running, skipping");
    return;
  }

  running = true;
  log.info("Starting ingestion cycle");

  try {
    const accounts = await getActiveAccounts();

    if (accounts.length === 0) {
      log.info("No active authenticated accounts, nothing to do");
      return;
    }

    log.info({ accountCount: accounts.length }, "Processing accounts");

    for (const account of accounts) {
      await runWorkerForAccount(account);
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
