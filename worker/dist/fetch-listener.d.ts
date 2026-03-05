/**
 * Start listening for pg_notify signals from the web app.
 *
 * Channels:
 *   - `channel_fetch` — payload = requestId → fetch channels for an account
 *   - `generate_invite` — payload = channelId → generate invite link for destination
 *   - `create_destination` — payload = JSON { requestId, title } → create supergroup via TDLib
 *   - `ingestion_trigger` — trigger an immediate ingestion cycle
 */
export declare function startFetchListener(): Promise<void>;
export declare function stopFetchListener(): void;
