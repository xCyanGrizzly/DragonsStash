import type pg from "pg";
import { pool } from "./client.js";
import { childLogger } from "../util/logger.js";

const log = childLogger("locks");

/**
 * Holds the pooled connection for each active advisory lock.
 * Session-level advisory locks are tied to the specific PostgreSQL connection,
 * so we MUST keep the same connection checked out for the entire lock duration.
 */
const heldConnections = new Map<string, pg.PoolClient>();

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
 *
 * IMPORTANT: The pooled connection is kept checked out for the duration
 * of the lock. You MUST call releaseLock() when done to return it to the pool.
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
      // Keep the connection checked out — lock is tied to this connection
      heldConnections.set(accountId, client);
      log.debug({ accountId, lockId }, "Advisory lock acquired");
      return true;
    } else {
      // Lock not acquired — release the connection back to the pool
      client.release();
      log.debug({ accountId, lockId }, "Advisory lock already held");
      return false;
    }
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Release the advisory lock for an account.
 * Uses the SAME connection that acquired the lock, then returns it to the pool.
 */
export async function releaseLock(accountId: string): Promise<void> {
  const lockId = hashToLockId(accountId);
  const client = heldConnections.get(accountId);

  if (!client) {
    log.warn({ accountId, lockId }, "No held connection for lock release — lock may have already been released");
    return;
  }

  try {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    log.debug({ accountId, lockId }, "Advisory lock released");
  } finally {
    heldConnections.delete(accountId);
    client.release();
  }
}
