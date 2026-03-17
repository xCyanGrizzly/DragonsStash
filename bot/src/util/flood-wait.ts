import { childLogger } from "./logger.js";

const log = childLogger("flood-wait");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the mandatory wait duration (in seconds) from a Telegram
 * FLOOD_WAIT error. Returns null when the error is not rate-limit related.
 */
export function extractFloodWaitSeconds(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);

  // Pattern 1: FLOOD_WAIT_30
  const flood = message.match(/FLOOD_WAIT_(\d+)/i);
  if (flood) return parseInt(flood[1], 10);

  // Pattern 2: "retry after 30"
  const retry = message.match(/retry after (\d+)/i);
  if (retry) return parseInt(retry[1], 10);

  // Pattern 3: HTTP 429 without explicit seconds
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (String((err as any)?.code) === "429") return 30;

  return null;
}

/**
 * Wrap any async Telegram operation with automatic FLOOD_WAIT retry.
 * Adds random jitter (1-5s) to prevent thundering-herd retries.
 *
 * Non-rate-limit errors are re-thrown immediately (fail-fast).
 */
export async function withFloodWait<T>(
  fn: () => Promise<T>,
  context?: string,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = extractFloodWaitSeconds(err);
      if (wait === null || attempt >= maxRetries) throw err;

      const jitter = 1000 + Math.random() * 4000;
      log.warn(
        { context, wait, attempt: attempt + 1, maxRetries, jitter: Math.round(jitter) },
        "FLOOD_WAIT received — backing off"
      );
      await sleep(wait * 1000 + jitter);
    }
  }
  throw new Error("Unreachable");
}

export { sleep };
