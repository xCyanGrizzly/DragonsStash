import type pg from "pg";
import { pool } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { processFetchRequest } from "./worker.js";
import { processExtractRequest } from "./extract-listener.js";
import { rebuildPackageDatabase } from "./rebuild.js";
import { generateInviteLink, createSupergroup, searchPublicChat } from "./tdlib/chats.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { triggerImmediateCycle } from "./scheduler.js";
import {
  getGlobalDestinationChannel,
  getGlobalSetting,
  setGlobalSetting,
  getActiveAccounts,
  upsertChannel,
  ensureAccountChannelLink,
  updateFetchRequestStatus,
} from "./db/queries.js";

const log = childLogger("fetch-listener");

let pgClient: pg.PoolClient | null = null;
let stopped = false;

/** Delay (ms) before attempting to reconnect after a connection loss. */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Start listening for pg_notify signals from the web app.
 *
 * Channels:
 *   - `channel_fetch` — payload = requestId → fetch channels for an account
 *   - `generate_invite` — payload = channelId → generate invite link for destination
 *   - `create_destination` — payload = JSON { requestId, title } → create supergroup via TDLib
 *   - `ingestion_trigger` — trigger an immediate ingestion cycle
 *   - `join_channel` — payload = JSON { requestId, input, accountId } → join/lookup channel by link/username
 *   - `rebuild_packages` — payload = requestId → rebuild package DB from destination channel
 *
 * If the underlying connection is lost, the listener automatically reconnects
 * so that pg_notify signals are never silently dropped.
 */
export async function startFetchListener(): Promise<void> {
  stopped = false;
  await connectListener();
}

async function connectListener(): Promise<void> {
  try {
    pgClient = await pool.connect();
    await pgClient.query("LISTEN channel_fetch");
    await pgClient.query("LISTEN generate_invite");
    await pgClient.query("LISTEN create_destination");
    await pgClient.query("LISTEN ingestion_trigger");
    await pgClient.query("LISTEN join_channel");
    await pgClient.query("LISTEN archive_extract");
    await pgClient.query("LISTEN rebuild_packages");

    pgClient.on("notification", (msg) => {
      if (msg.channel === "channel_fetch" && msg.payload) {
        handleChannelFetch(msg.payload);
      } else if (msg.channel === "generate_invite" && msg.payload) {
        handleGenerateInvite(msg.payload);
      } else if (msg.channel === "create_destination" && msg.payload) {
        handleCreateDestination(msg.payload);
      } else if (msg.channel === "ingestion_trigger") {
        handleIngestionTrigger();
      } else if (msg.channel === "join_channel" && msg.payload) {
        handleJoinChannel(msg.payload);
      } else if (msg.channel === "archive_extract" && msg.payload) {
        handleArchiveExtract(msg.payload);
      } else if (msg.channel === "rebuild_packages" && msg.payload) {
        handleRebuildPackages(msg.payload);
      }
    });

    // Reconnect automatically when the connection ends unexpectedly
    pgClient.on("end", () => {
      if (!stopped) {
        log.warn("Fetch listener connection lost — reconnecting");
        pgClient = null;
        scheduleReconnect();
      }
    });

    pgClient.on("error", (err) => {
      log.error({ err }, "Fetch listener connection error");
      if (!stopped && pgClient) {
        try {
          pgClient.release(true);
        } catch (releaseErr) {
          log.debug({ err: releaseErr }, "Failed to release pg client after error");
        }
        pgClient = null;
        scheduleReconnect();
      }
    });

    log.info("Fetch listener started (channel_fetch, generate_invite, create_destination, ingestion_trigger, join_channel, archive_extract, rebuild_packages)");
  } catch (err) {
    log.error({ err }, "Failed to start fetch listener — retrying");
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  setTimeout(() => {
    if (!stopped) {
      connectListener();
    }
  }, RECONNECT_DELAY_MS);
}

export function stopFetchListener(): void {
  stopped = true;
  if (pgClient) {
    pgClient.release();
    pgClient = null;
  }
  log.info("Fetch listener stopped");
}

// ── Channel fetch handler ──

// Chain promises to ensure sequential execution
let fetchQueue: Promise<void> = Promise.resolve();

function handleChannelFetch(requestId: string): void {
  fetchQueue = fetchQueue.then(async () => {
    try {
      await withTdlibMutex("fetch-channels", () =>
        processFetchRequest(requestId)
      );
    } catch (err) {
      log.error({ err, requestId }, "Failed to process fetch request");
    }
  });
}

// ── Invite link generation handler ──

function handleGenerateInvite(channelId: string): void {
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
        } finally {
          await closeTdlibClient(client);
        }
      });
    } catch (err) {
      log.error({ err, channelId }, "Failed to generate invite link");
    }
  });
}

// ── Create destination supergroup handler ──

function handleCreateDestination(payload: string): void {
  fetchQueue = fetchQueue.then(async () => {
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { requestId: string; title: string };
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
            } catch {
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

          log.info(
            { channelId: channel.id, telegramId: result.chatId.toString() },
            "Destination channel created and configured"
          );
        } finally {
          await closeTdlibClient(client);
        }
      });
    } catch (err) {
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
        } catch {
          // Best-effort
        }
      }
    }
  });
}

// ── Join channel handler ──

/**
 * Parse a Telegram link/username into its type and identifier.
 *
 * Supported formats:
 *   - @username or username → public chat search
 *   - https://t.me/username → public chat search
 *   - https://t.me/+INVITE_HASH → join by invite link
 *   - https://t.me/joinchat/INVITE_HASH → join by invite link (legacy)
 */
function parseTelegramInput(input: string): { type: "username"; username: string } | { type: "invite"; link: string } | null {
  const trimmed = input.trim();

  // Invite link patterns
  const invitePatterns = [
    /^https?:\/\/t\.me\/\+([a-zA-Z0-9_-]+)$/,
    /^https?:\/\/t\.me\/joinchat\/([a-zA-Z0-9_-]+)$/,
    /^https?:\/\/telegram\.me\/\+([a-zA-Z0-9_-]+)$/,
    /^https?:\/\/telegram\.me\/joinchat\/([a-zA-Z0-9_-]+)$/,
  ];

  for (const pattern of invitePatterns) {
    if (pattern.test(trimmed)) {
      return { type: "invite", link: trimmed };
    }
  }

  // Public link: https://t.me/username
  const publicLinkMatch = trimmed.match(/^https?:\/\/(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{3,31})$/);
  if (publicLinkMatch) {
    return { type: "username", username: publicLinkMatch[1] };
  }

  // @username or bare username
  const usernameMatch = trimmed.match(/^@?([a-zA-Z][a-zA-Z0-9_]{3,31})$/);
  if (usernameMatch) {
    return { type: "username", username: usernameMatch[1] };
  }

  return null;
}

function handleJoinChannel(payload: string): void {
  fetchQueue = fetchQueue.then(async () => {
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { requestId: string; input: string; accountId: string };
      requestId = parsed.requestId;

      await withTdlibMutex("join-channel", async () => {
        await updateFetchRequestStatus(requestId!, "IN_PROGRESS");

        const accounts = await getActiveAccounts();
        const account = accounts.find((a) => a.id === parsed.accountId) ?? accounts[0];
        if (!account) {
          throw new Error("No authenticated accounts available");
        }

        const client = await createTdlibClient({ id: account.id, phone: account.phone });

        try {
          const linkInfo = parseTelegramInput(parsed.input);
          if (!linkInfo) {
            throw new Error(
              "Invalid input. Use a t.me link (e.g. https://t.me/channel_name), " +
              "an invite link (e.g. https://t.me/+abc123), or a @username."
            );
          }

          let chatInfo: { chatId: bigint; title: string; type: string; isForum: boolean };

          if (linkInfo.type === "username") {
            // Public chat: search by username
            const result = await searchPublicChat(client, linkInfo.username);
            if (!result) {
              throw new Error(`Public channel "@${linkInfo.username}" not found. Check the username and try again.`);
            }
            if (result.type !== "channel" && result.type !== "supergroup") {
              throw new Error(`"@${linkInfo.username}" is a ${result.type}, not a channel or group. Only channels and supergroups are supported.`);
            }
            chatInfo = { chatId: result.chatId, title: result.title, type: result.type, isForum: result.isForum };
          } else {
            // Private/invite link: join first, then get chat info
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let joinResult: any;
            try {
              joinResult = await client.invoke({
                _: "joinChatByInviteLink",
                invite_link: linkInfo.link,
              });
            } catch (joinErr: unknown) {
              const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
              // "INVITE_REQUEST_SENT" means the chat requires admin approval
              if (msg.includes("INVITE_REQUEST_SENT")) {
                throw new Error("Join request sent. An admin of that channel must approve it before it can be added.");
              }
              // Already a member is fine
              if (!msg.includes("USER_ALREADY_PARTICIPANT") && !msg.includes("INVITE_HASH_EXPIRED")) {
                throw new Error(`Failed to join via invite link: ${msg}`);
              }
              // If already a participant, we need to get chat info from the link
              // Try checkChatInviteLink to get the chat id
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const checkResult = (await client.invoke({
                  _: "checkChatInviteLink",
                  invite_link: linkInfo.link,
                })) as any;
                if (checkResult.chat_id) {
                  joinResult = { id: checkResult.chat_id };
                } else {
                  throw joinErr;
                }
              } catch {
                throw joinErr;
              }
            }

            // Get full chat info
            const chatId = joinResult?.id ?? joinResult?.chat_id;
            if (!chatId) {
              throw new Error("Joined channel but could not determine chat ID.");
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const chat = (await client.invoke({ _: "getChat", chat_id: chatId })) as any;
            let type: string = "other";
            let isForum = false;

            if (chat.type?._ === "chatTypeSupergroup") {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sg = (await client.invoke({
                  _: "getSupergroup",
                  supergroup_id: chat.type.supergroup_id,
                })) as any;
                type = sg.is_channel ? "channel" : "supergroup";
                isForum = sg.is_forum ?? false;
              } catch {
                type = "supergroup";
              }
            } else if (chat.type?._ === "chatTypeBasicGroup") {
              type = "group";
            }

            if (type !== "channel" && type !== "supergroup") {
              throw new Error(`The joined chat is a ${type}, not a channel or group. Only channels and supergroups are supported.`);
            }

            chatInfo = { chatId: BigInt(chatId), title: chat.title ?? "Unknown", type, isForum };
          }

          // Upsert channel in DB (active as source by default since user explicitly added it)
          const channel = await upsertChannel({
            telegramId: chatInfo.chatId,
            title: chatInfo.title,
            type: "SOURCE",
            isForum: chatInfo.isForum,
            isActive: true,
          });

          // Link the account as READER
          await ensureAccountChannelLink(account.id, channel.id, "READER");

          log.info(
            { channelId: channel.id, telegramId: chatInfo.chatId.toString(), title: chatInfo.title },
            "Channel joined and added"
          );

          await updateFetchRequestStatus(requestId!, "COMPLETED", {
            resultJson: JSON.stringify({
              channelId: channel.id,
              telegramId: chatInfo.chatId.toString(),
              title: chatInfo.title,
              type: chatInfo.type,
              isForum: chatInfo.isForum,
            }),
          });
        } finally {
          await closeTdlibClient(client);
        }
      });
    } catch (err) {
      log.error({ err, payload }, "Failed to join channel");
      if (requestId) {
        try {
          await updateFetchRequestStatus(requestId, "FAILED", {
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Best-effort
        }
      }
    }
  });
}

// ── Archive extract handler ──

function handleArchiveExtract(requestId: string): void {
  fetchQueue = fetchQueue.then(async () => {
    try {
      log.info({ requestId }, "Archive extract request received");
      await processExtractRequest(requestId);
    } catch (err) {
      log.error({ err, requestId }, "Failed to process archive extract request");
    }
  });
}

// ── Ingestion trigger handler ──

function handleIngestionTrigger(): void {
  fetchQueue = fetchQueue.then(async () => {
    try {
      log.info("Ingestion trigger received from UI");
      await triggerImmediateCycle();
    } catch (err) {
      log.error({ err }, "Failed to trigger immediate ingestion cycle");
    }
  });
}

// ── Package database rebuild handler ──

function handleRebuildPackages(requestId: string): void {
  fetchQueue = fetchQueue.then(async () => {
    try {
      await withTdlibMutex("rebuild-packages", () =>
        rebuildPackageDatabase(requestId)
      );
    } catch (err) {
      log.error({ err, requestId }, "Failed to rebuild package database");
    }
  });
}
