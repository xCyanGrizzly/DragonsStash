import type { TelegramAccount } from "@prisma/client";
/**
 * Authenticate a PENDING account by creating a TDLib client.
 * TDLib will send an SMS code to the phone number, and the client.login()
 * callbacks set the authState to AWAITING_CODE. Once the admin enters the
 * code via the UI, pollForAuthCode picks it up and completes the login.
 *
 * After successful auth:
 * 1. Fetches channels from Telegram and writes as a ChannelFetchRequest
 *    (so the admin can select sources in the UI)
 * 2. Auto-joins the destination group if an invite link is configured
 */
export declare function authenticateAccount(account: TelegramAccount): Promise<void>;
/**
 * Process a ChannelFetchRequest: fetch channels from Telegram,
 * enrich with DB state, and write the result JSON.
 * Called by the fetch listener (pg_notify) and by authenticateAccount.
 */
export declare function processFetchRequest(requestId: string): Promise<void>;
/**
 * Run a full ingestion cycle for a single Telegram account.
 * Every step writes live activity to the DB so the admin UI can display it.
 */
export declare function runWorkerForAccount(account: TelegramAccount): Promise<void>;
/**
 * Clean up any leftover temp files/directories from previous runs.
 */
export declare function cleanupTempDir(): Promise<void>;
