import { pool } from "./client.js";
import { childLogger } from "../util/logger.js";

const log = childLogger("locks");

/**
 * Derive a stable 32-bit integer lock ID from an account ID string.
 * PostgreSQL advisory locks use bigint, but we use 32-bit for safety.
 */
function hashToLockId(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    const char = accountId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Try to acquire a PostgreSQL advisory lock for an account.
 * Returns true if acquired, false if already held by another session.
 */
export async function tryAcquireLock(accountId: string): Promise<boolean> {
  const lockId = hashToLockId(accountId);
  const client = await pool.connect();
  try {
    const result = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1)",
      [lockId]
    );
    const acquired = result.rows[0]?.pg_try_advisory_lock ?? false;
    if (acquired) {
      log.debug({ accountId, lockId }, "Advisory lock acquired");
    } else {
      log.debug({ accountId, lockId }, "Advisory lock already held");
    }
    return acquired;
  } finally {
    client.release();
  }
}

/**
 * Release the advisory lock for an account.
 */
export async function releaseLock(accountId: string): Promise<void> {
  const lockId = hashToLockId(accountId);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    log.debug({ accountId, lockId }, "Advisory lock released");
  } finally {
    client.release();
  }
}
