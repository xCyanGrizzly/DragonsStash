import { childLogger } from "./logger.js";

const log = childLogger("mutex");

let locked = false;
let holder = "";
const queue: Array<{ resolve: () => void; label: string }> = [];

/**
 * Ensures only one TDLib client runs at a time across the entire worker process.
 * Both the scheduler (auth, ingestion) and the fetch listener acquire this
 * before creating any TDLib client.
 */
export async function withTdlibMutex<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (locked) {
    log.info({ waiting: label, holder }, "Waiting for TDLib mutex");
    await new Promise<void>((resolve) => queue.push({ resolve, label }));
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
