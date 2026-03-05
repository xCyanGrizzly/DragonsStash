import { pool } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { processFetchRequest } from "./worker.js";
import { generateInviteLink, createSupergroup } from "./tdlib/chats.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { triggerImmediateCycle } from "./scheduler.js";
import { getGlobalDestinationChannel, setGlobalSetting, getActiveAccounts, upsertChannel, ensureAccountChannelLink, } from "./db/queries.js";
const log = childLogger("fetch-listener");
let pgClient = null;
/**
 * Start listening for pg_notify signals from the web app.
 *
 * Channels:
 *   - `channel_fetch` — payload = requestId → fetch channels for an account
 *   - `generate_invite` — payload = channelId → generate invite link for destination
 *   - `create_destination` — payload = JSON { requestId, title } → create supergroup via TDLib
 *   - `ingestion_trigger` — trigger an immediate ingestion cycle
 */
export async function startFetchListener() {
    pgClient = await pool.connect();
    await pgClient.query("LISTEN channel_fetch");
    await pgClient.query("LISTEN generate_invite");
    await pgClient.query("LISTEN create_destination");
    await pgClient.query("LISTEN ingestion_trigger");
    pgClient.on("notification", (msg) => {
        if (msg.channel === "channel_fetch" && msg.payload) {
            handleChannelFetch(msg.payload);
        }
        else if (msg.channel === "generate_invite" && msg.payload) {
            handleGenerateInvite(msg.payload);
        }
        else if (msg.channel === "create_destination" && msg.payload) {
            handleCreateDestination(msg.payload);
        }
        else if (msg.channel === "ingestion_trigger") {
            handleIngestionTrigger();
        }
    });
    log.info("Fetch listener started (channel_fetch, generate_invite, create_destination, ingestion_trigger)");
}
export function stopFetchListener() {
    if (pgClient) {
        pgClient.release();
        pgClient = null;
    }
    log.info("Fetch listener stopped");
}
// ── Channel fetch handler ──
// Chain promises to ensure sequential execution
let fetchQueue = Promise.resolve();
function handleChannelFetch(requestId) {
    fetchQueue = fetchQueue.then(async () => {
        try {
            await withTdlibMutex("fetch-channels", () => processFetchRequest(requestId));
        }
        catch (err) {
            log.error({ err, requestId }, "Failed to process fetch request");
        }
    });
}
// ── Invite link generation handler ──
function handleGenerateInvite(channelId) {
    fetchQueue = fetchQueue.then(async () => {
        try {
            await withTdlibMutex("generate-invite", async () => {
                const destChannel = await getGlobalDestinationChannel();
                if (!destChannel || destChannel.id !== channelId) {
                    log.warn({ channelId }, "Destination channel mismatch, skipping invite generation");
                    return;
                }
                // Use the first available authenticated account to generate the link
                const accounts = await getActiveAccounts();
                if (accounts.length === 0) {
                    log.warn("No authenticated accounts to generate invite link");
                    return;
                }
                const account = accounts[0];
                const client = await createTdlibClient({ id: account.id, phone: account.phone });
                try {
                    const link = await generateInviteLink(client, destChannel.telegramId);
                    await setGlobalSetting("destination_invite_link", link);
                    log.info({ link }, "Invite link generated and saved");
                }
                finally {
                    await closeTdlibClient(client);
                }
            });
        }
        catch (err) {
            log.error({ err, channelId }, "Failed to generate invite link");
        }
    });
}
// ── Create destination supergroup handler ──
function handleCreateDestination(payload) {
    fetchQueue = fetchQueue.then(async () => {
        let requestId;
        try {
            const parsed = JSON.parse(payload);
            requestId = parsed.requestId;
            await withTdlibMutex("create-destination", async () => {
                const { db } = await import("./db/client.js");
                // Mark the request as in-progress
                await db.channelFetchRequest.update({
                    where: { id: parsed.requestId },
                    data: { status: "IN_PROGRESS" },
                });
                // Use the first available authenticated account
                const accounts = await getActiveAccounts();
                if (accounts.length === 0) {
                    throw new Error("No authenticated accounts available to create the group");
                }
                const account = accounts[0];
                const client = await createTdlibClient({ id: account.id, phone: account.phone });
                try {
                    // Create the supergroup via TDLib
                    const result = await createSupergroup(client, parsed.title);
                    log.info({ chatId: result.chatId.toString(), title: result.title }, "Supergroup created");
                    // Upsert it as a DESTINATION channel in the DB (active by default)
                    const channel = await upsertChannel({
                        telegramId: result.chatId,
                        title: result.title,
                        type: "DESTINATION",
                        isForum: false,
                        isActive: true,
                    });
                    // Set as global destination
                    await setGlobalSetting("destination_channel_id", channel.id);
                    // Generate an invite link
                    const link = await generateInviteLink(client, result.chatId);
                    await setGlobalSetting("destination_invite_link", link);
                    log.info({ link }, "Invite link generated for new destination");
                    // Link all authenticated accounts as WRITER
                    for (const acc of accounts) {
                        try {
                            await ensureAccountChannelLink(acc.id, channel.id, "WRITER");
                        }
                        catch {
                            // Already linked
                        }
                    }
                    // Mark fetch request as completed with the channel info
                    await db.channelFetchRequest.update({
                        where: { id: parsed.requestId },
                        data: {
                            status: "COMPLETED",
                            resultJson: JSON.stringify({
                                channelId: channel.id,
                                telegramId: result.chatId.toString(),
                                title: result.title,
                                inviteLink: link,
                            }),
                        },
                    });
                    log.info({ channelId: channel.id, telegramId: result.chatId.toString() }, "Destination channel created and configured");
                }
                finally {
                    await closeTdlibClient(client);
                }
            });
        }
        catch (err) {
            log.error({ err, payload }, "Failed to create destination channel");
            if (requestId) {
                try {
                    const { db } = await import("./db/client.js");
                    await db.channelFetchRequest.update({
                        where: { id: requestId },
                        data: {
                            status: "FAILED",
                            error: err instanceof Error ? err.message : String(err),
                        },
                    });
                }
                catch {
                    // Best-effort
                }
            }
        }
    });
}
// ── Ingestion trigger handler ──
function handleIngestionTrigger() {
    fetchQueue = fetchQueue.then(async () => {
        try {
            log.info("Ingestion trigger received from UI");
            await triggerImmediateCycle();
        }
        catch (err) {
            log.error({ err }, "Failed to trigger immediate ingestion cycle");
        }
    });
}
//# sourceMappingURL=fetch-listener.js.map