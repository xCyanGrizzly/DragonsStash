/**
 * Try to acquire a PostgreSQL advisory lock for an account.
 * Returns true if acquired, false if already held by another session.
 */
export declare function tryAcquireLock(accountId: string): Promise<boolean>;
/**
 * Release the advisory lock for an account.
 */
export declare function releaseLock(accountId: string): Promise<void>;
