/**
 * Ensures only one TDLib client runs at a time across the entire worker process.
 * Both the scheduler (auth, ingestion) and the fetch listener acquire this
 * before creating any TDLib client.
 *
 * Includes a wait timeout to prevent indefinite blocking if the current holder hangs.
 */
export declare function withTdlibMutex<T>(label: string, fn: () => Promise<T>): Promise<T>;
