import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex, forceReleaseMutex } from "./util/mutex.js";
import { getActiveAccounts, getPendingAccounts } from "./db/queries.js";
import { runWorkerForAccount, authenticateAccount } from "./worker.js";
import { runIntegrityAudit } from "./audit.js";

const log = childLogger("scheduler");

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let cycleCount = 0;
let activeCyclePromise: Promise<void> | null = null;

/**
 * Maximum time for a single ingestion cycle (ms).
 * After this, new accounts won't be started (in-progress work finishes).
 * Default: 4 hours. Configurable via WORKER_CYCLE_TIMEOUT_MINUTES.
 */
const CYCLE_TIMEOUT_MS = (parseInt(process.env.WORKER_CYCLE_TIMEOUT_MINUTES ?? "240", 10)) * 60 * 1000;

/**
 * Run one ingestion cycle:
 * 1. Authenticate any PENDING accounts (triggers SMS code flow + auto-fetch channels)
 * 2. Process all active AUTHENTICATED accounts for ingestion
 *
 * Each account's TDLib operations are wrapped in a per-key mutex so different
 * accounts run concurrently while the same account is still serialized.
 *
 * The cycle has a configurable timeout (WORKER_CYCLE_TIMEOUT_MINUTES, default 4h).
 * Once the timeout elapses, no new accounts will be started but any in-progress
 * account processing is allowed to finish its current archive set.
 */
async function runCycle(): Promise<void> {
  if (running) {
    log.warn("Previous cycle still running, skipping");
    return;
  }

  running = true;
  cycleCount++;
  const cycleStart = Date.now();
  log.info({ cycle: cycleCount, timeoutMinutes: CYCLE_TIMEOUT_MS / 60_000 }, "Starting ingestion cycle");

  try {
    // ── Phase 1: Authenticate pending accounts ──
    const pendingAccounts = await getPendingAccounts();
    if (pendingAccounts.length > 0) {
      log.info(
        { count: pendingAccounts.length },
        "Found pending accounts, starting authentication"
      );
      for (const account of pendingAccounts) {
        if (Date.now() - cycleStart > CYCLE_TIMEOUT_MS) {
          log.warn("Cycle timeout reached during authentication phase, stopping");
          break;
        }
        await withTdlibMutex(account.phone, `auth:${account.phone}`, () =>
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

    const results = await Promise.allSettled(
      accounts.map((account) => {
        let timer: ReturnType<typeof setTimeout>;
        return Promise.race([
          withTdlibMutex(account.phone, `ingest:${account.phone}`, () =>
            runWorkerForAccount(account)
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Account ${account.phone} ingestion timed out after ${CYCLE_TIMEOUT_MS / 60_000}min`)),
              CYCLE_TIMEOUT_MS
            );
          }),
        ]).finally(() => clearTimeout(timer));
      })
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        const reason = (results[i] as PromiseRejectedResult).reason;
        log.error(
          { phone: accounts[i].phone, err: reason },
          "Account ingestion failed"
        );
        // If the cycle timed out, force-release the mutex so the next cycle
        // (or other operations like fetch-channels) can proceed immediately
        // instead of waiting 30 minutes for the mutex timeout.
        const errMsg = reason instanceof Error ? reason.message : String(reason);
        if (errMsg.includes("timed out") || errMsg.includes("mutex wait timeout")) {
          forceReleaseMutex(accounts[i].phone);
        }
      }
    }

    log.info(
      { elapsed: Math.round((Date.now() - cycleStart) / 1000) },
      "Ingestion cycle complete"
    );

    // Run integrity audit after all accounts are processed
    try {
      const auditResult = await runIntegrityAudit();
      if (auditResult.issues > 0) {
        log.info({ ...auditResult }, "Integrity audit found issues");
      }
    } catch (auditErr) {
      log.warn({ err: auditErr }, "Integrity audit failed");
    }
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
    activeCyclePromise = runCycle();
    await activeCyclePromise;
    activeCyclePromise = null;
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
  activeCyclePromise = runCycle();
  await activeCyclePromise;
  activeCyclePromise = null;

  // Then schedule recurring cycles
  scheduleNext();
}

/**
 * Trigger an immediate ingestion cycle (e.g. from the admin UI).
 * If a cycle is already running, this is a no-op.
 */
export async function triggerImmediateCycle(): Promise<void> {
  if (running) {
    log.info("Cycle already running, ignoring trigger");
    return;
  }
  log.info("Immediate cycle triggered via UI");
  await runCycle();
}

/**
 * Stop the scheduler gracefully.
 * Returns a promise that resolves when any active cycle finishes,
 * so callers can wait before closing DB connections.
 */
export function stopScheduler(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (activeCyclePromise) {
    log.info("Scheduler stopping — waiting for active cycle to finish");
    return activeCyclePromise.finally(() => {
      activeCyclePromise = null;
      log.info("Scheduler stopped");
    });
  }
  log.info("Scheduler stopped");
  return Promise.resolve();
}
