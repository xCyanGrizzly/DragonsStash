import { childLogger } from "./logger.js";
import { config } from "./config.js";

const log = childLogger("retry");

/**
 * Extract the FLOOD_WAIT duration (in seconds) from a TDLib error.
 *
 * TDLib errors for rate limiting look like:
 *   - Error message: "Too Many Requests: retry after 30"
 *   - Error message: "FLOOD_WAIT_30"
 *   - Error code: 429
 */
export function extractFloodWaitSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;

  const message = (err as { message?: string }).message ?? "";
  const code = (err as { code?: number }).code;

  // Match "FLOOD_WAIT_<seconds>" pattern
  const floodMatch = message.match(/FLOOD_WAIT_(\d+)/i);
  if (floodMatch) {
    return parseInt(floodMatch[1], 10);
  }

  // Match "retry after <seconds>" pattern (from Telegram HTTP API style errors)
  const retryMatch = message.match(/retry after (\d+)/i);
  if (retryMatch) {
    return parseInt(retryMatch[1], 10);
  }

  // If error code is 429 but no explicit wait time, default to 30 seconds
  if (code === 429) {
    return 30;
  }

  return null;
}

/**
 * Sleep for a given number of milliseconds, with a descriptive log message.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a TDLib invoke operation with FLOOD_WAIT-aware retry logic.
 *
 * When Telegram returns a rate limit error (FLOOD_WAIT / 429), this:
 *   1. Extracts the required wait time from the error
 *   2. Logs a warning with the wait duration
 *   3. Sleeps for the required duration + small jitter
 *   4. Retries the operation (up to maxRetries times)
 *
 * Non-rate-limit errors are re-thrown immediately.
 *
 * Usage:
 *   const result = await withFloodWait(() => client.invoke({ ... }));
 */
export async function withFloodWait<T>(
  fn: () => Promise<T>,
  context?: string,
  maxRetries?: number
): Promise<T> {
  const limit = maxRetries ?? config.maxRetries;
  let lastError: unknown;

  for (let attempt = 0; attempt <= limit; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const waitSeconds = extractFloodWaitSeconds(err);

      if (waitSeconds === null) {
        // Not a rate limit error — re-throw immediately
        throw err;
      }

      if (attempt >= limit) {
        log.error(
          { context, attempt, waitSeconds },
          "Rate limit exceeded max retries — giving up"
        );
        throw err;
      }

      // Add small jitter (1–5 seconds) to avoid multiple clients retrying simultaneously
      const jitter = 1000 + Math.random() * 4000;
      const totalWaitMs = waitSeconds * 1000 + jitter;

      log.warn(
        {
          context,
          attempt: attempt + 1,
          maxRetries: limit,
          waitSeconds,
          totalWaitMs: Math.round(totalWaitMs),
        },
        `Rate-limited by Telegram — sleeping ${waitSeconds}s before retry`
      );

      await sleepMs(totalWaitMs);
    }
  }

  throw lastError;
}
