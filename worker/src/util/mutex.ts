import { childLogger } from "./logger.js";

const log = childLogger("mutex");

let locked = false;
let holder = "";
const queue: Array<{ resolve: () => void; reject: (err: Error) => void; label: string }> = [];

/**
 * Maximum time to wait for the TDLib mutex (ms).
 * If the mutex is not available within this time, the operation is rejected.
 * Default: 30 minutes (long enough for large downloads, short enough to detect hangs).
 */
const MUTEX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Ensures only one TDLib client runs at a time across the entire worker process.
 * Both the scheduler (auth, ingestion) and the fetch listener acquire this
 * before creating any TDLib client.
 *
 * Includes a wait timeout to prevent indefinite blocking if the current holder hangs.
 */
export async function withTdlibMutex<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (locked) {
    log.info({ waiting: label, holder }, "Waiting for TDLib mutex");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
          reject(new Error(
            `TDLib mutex wait timeout after ${MUTEX_WAIT_TIMEOUT_MS / 60_000}min ` +
            `(waiting: ${label}, holder: ${holder})`
          ));
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
      queue.push(entry);
    });
  }

  locked = true;
  holder = label;
  log.debug({ label }, "TDLib mutex acquired");

  try {
    return await fn();
  } finally {
    locked = false;
    holder = "";
    const next = queue.shift();
    if (next) {
      log.debug({ next: next.label }, "TDLib mutex releasing to next waiter");
      next.resolve();
    } else {
      log.debug({ label }, "TDLib mutex released");
    }
  }
}
