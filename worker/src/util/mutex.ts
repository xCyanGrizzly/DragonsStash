import { childLogger } from "./logger.js";

const log = childLogger("mutex");

const MUTEX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const locks = new Map<string, boolean>();
const holders = new Map<string, string>();
const queues = new Map<
  string,
  Array<{ resolve: () => void; reject: (err: Error) => void; label: string }>
>();

/**
 * Force-release a stuck mutex.
 * This should only be called when the holder is known to be stuck (e.g. after
 * a cycle timeout). It releases the lock and lets the next queued waiter proceed.
 */
export function forceReleaseMutex(key: string): void {
  if (!locks.has(key)) return;

  const holder = holders.get(key);
  log.warn({ key, holder }, "Force-releasing stuck TDLib mutex");

  locks.delete(key);
  holders.delete(key);
  const next = queues.get(key)?.shift();
  if (next) {
    log.info({ key, next: next.label }, "TDLib mutex force-released to next waiter");
    next.resolve();
  } else {
    queues.delete(key);
    log.info({ key }, "TDLib mutex force-released (no waiters)");
  }
}

/**
 * Ensures only one TDLib operation runs at a time FOR THE SAME KEY.
 * Different keys run concurrently — this allows two accounts to ingest in parallel
 * while still preventing concurrent use of the same account's TDLib state dir.
 *
 * key:   the account phone number for account-specific ops (auth, ingest),
 *        or 'global' for ops that don't belong to a specific account.
 * label: human-readable name for logging.
 */
export async function withTdlibMutex<T>(
  key: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (locks.get(key)) {
    log.info({ waiting: label, key, holder: holders.get(key) }, "Waiting for TDLib mutex");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const q = queues.get(key) ?? [];
        const idx = q.indexOf(entry);
        if (idx !== -1) {
          q.splice(idx, 1);
          reject(
            new Error(
              `TDLib mutex wait timeout after ${MUTEX_WAIT_TIMEOUT_MS / 60_000}min ` +
                `(waiting: ${label}, key: ${key}, holder: ${holders.get(key)})`
            )
          );
        }
      }, MUTEX_WAIT_TIMEOUT_MS);

      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
        label,
      };

      if (!queues.has(key)) queues.set(key, []);
      queues.get(key)!.push(entry);
    });
  }

  locks.set(key, true);
  holders.set(key, label);
  log.debug({ key, label }, "TDLib mutex acquired");

  try {
    return await fn();
  } finally {
    locks.delete(key);
    holders.delete(key);
    const next = queues.get(key)?.shift();
    if (next) {
      log.debug({ key, next: next.label }, "TDLib mutex releasing to next waiter");
      next.resolve();
    } else {
      queues.delete(key);
      log.debug({ key, label }, "TDLib mutex released");
    }
  }
}
