/**
 * Start the scheduler. Runs an immediate first cycle, then schedules subsequent ones.
 */
export declare function startScheduler(): Promise<void>;
/**
 * Trigger an immediate ingestion cycle (e.g. from the admin UI).
 * If a cycle is already running, this is a no-op.
 */
export declare function triggerImmediateCycle(): Promise<void>;
/**
 * Stop the scheduler gracefully.
 */
export declare function stopScheduler(): void;
