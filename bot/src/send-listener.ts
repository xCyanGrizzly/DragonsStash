import type pg from "pg";
import { pool } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import {
  getPendingSendRequest,
  updateSendRequest,
  findMatchingSubscriptions,
  getGlobalDestinationChannel,
} from "./db/queries.js";
import { copyMessageToUser, copyMultipleMessagesToUser, sendTextMessage, sendPhotoMessage } from "./tdlib/client.js";
import { sleep } from "./util/flood-wait.js";

const log = childLogger("send-listener");

let pgClient: pg.PoolClient | null = null;
let stopped = false;

/** Delay (ms) before attempting to reconnect after a connection loss. */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Start listening for pg_notify signals:
 *   - `bot_send` — payload = requestId → send a package to a user
 *   - `new_package` — payload = JSON { packageId, fileName, creator } → notify subscribers
 *
 * If the underlying connection is lost, the listener automatically reconnects
 * so that pg_notify signals are never silently dropped.
 */
export async function startSendListener(): Promise<void> {
  stopped = false;
  await connectListener();
}

async function connectListener(): Promise<void> {
  try {
    pgClient = await pool.connect();
    await pgClient.query("LISTEN bot_send");
    await pgClient.query("LISTEN new_package");

    pgClient.on("notification", (msg) => {
      if (msg.channel === "bot_send" && msg.payload) {
        handleBotSend(msg.payload);
      } else if (msg.channel === "new_package" && msg.payload) {
        handleNewPackage(msg.payload);
      }
    });

    // Reconnect automatically when the connection ends unexpectedly
    pgClient.on("end", () => {
      if (!stopped) {
        log.warn("Send listener connection lost — reconnecting");
        pgClient = null;
        scheduleReconnect();
      }
    });

    pgClient.on("error", (err) => {
      log.error({ err }, "Send listener connection error");
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

    log.info("Send listener started (bot_send, new_package)");
  } catch (err) {
    log.error({ err }, "Failed to start send listener — retrying");
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

export function stopSendListener(): void {
  stopped = true;
  if (pgClient) {
    pgClient.release();
    pgClient = null;
  }
  log.info("Send listener stopped");
}

// ── bot_send handler ──

let sendQueue: Promise<void> = Promise.resolve();

function handleBotSend(requestId: string): void {
  sendQueue = sendQueue.then(() => processSendRequest(requestId)).catch((err) => {
    log.error({ err, requestId }, "Send request processing failed");
  });
}

async function processSendRequest(requestId: string): Promise<void> {
  const request = await getPendingSendRequest(requestId);
  if (!request || request.status !== "PENDING") {
    log.warn({ requestId }, "Send request not found or not pending");
    return;
  }

  log.info(
    {
      requestId,
      packageId: request.packageId,
      targetTgId: request.telegramLink.telegramUserId.toString(),
    },
    "Processing send request"
  );

  await updateSendRequest(requestId, "SENDING");

  try {
    const pkg = request.package;
    const targetUserId = request.telegramLink.telegramUserId;

    if (!pkg.destChannelId || !pkg.destMessageId) {
      throw new Error("Package has no destination message — cannot forward");
    }

    // Get the destination channel's Telegram ID
    const destChannel = await getGlobalDestinationChannel();
    if (!destChannel) {
      throw new Error("No global destination channel configured");
    }

    // Send preview with rich caption if available
    if (pkg.previewData) {
      const lines: string[] = [];
      lines.push(`📦 *${escapeMarkdown(pkg.fileName)}*`);
      if (pkg.creator) lines.push(`👤 ${escapeMarkdown(pkg.creator)}`);
      if (pkg.fileCount > 0) lines.push(`📁 ${pkg.fileCount} files`);
      if (pkg.tags && pkg.tags.length > 0) {
        lines.push(`🏷️ ${pkg.tags.map((t: string) => escapeMarkdown(t)).join(", ")}`);
      }
      if (pkg.sourceChannel) {
        lines.push(`📡 Source: ${escapeMarkdown(pkg.sourceChannel.title)}`);
      }
      lines.push("");
      lines.push("_Sent from Dragon's Stash_");

      const caption = lines.join("\n");
      await sendPhotoMessage(targetUserId, Buffer.from(pkg.previewData), caption);
    }

    // Forward the actual archive file(s) from destination channel
    const messageIds = pkg.destMessageIds as bigint[] | undefined;
    if (messageIds && messageIds.length > 1) {
      log.info(
        { requestId, parts: messageIds.length },
        "Sending multi-part archive"
      );
      await copyMultipleMessagesToUser(
        destChannel.telegramId,
        messageIds,
        targetUserId
      );
    } else {
      // Single part or legacy (no destMessageIds populated)
      await copyMessageToUser(
        destChannel.telegramId,
        pkg.destMessageId,
        targetUserId
      );
    }

    await updateSendRequest(requestId, "SENT");
    log.info({ requestId }, "Send request completed successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, requestId }, "Send request failed");
    await updateSendRequest(requestId, "FAILED", message);
  }
}

// ── new_package handler ──

async function handleNewPackage(payload: string): Promise<void> {
  try {
    const data = JSON.parse(payload) as {
      packageId: string;
      fileName: string;
      creator: string | null;
      tags?: string[];
    };

    const subs = await findMatchingSubscriptions(data.fileName, data.creator);
    if (subs.length === 0) return;

    log.info(
      { packageId: data.packageId, matchedSubscriptions: subs.length },
      "Notifying subscribers of new package"
    );

    // Group by user to send one notification per user
    const userSubs = new Map<string, string[]>();
    for (const sub of subs) {
      const key = sub.telegramUserId.toString();
      const patterns = userSubs.get(key) ?? [];
      patterns.push(sub.pattern);
      userSubs.set(key, patterns);
    }

    const creator = data.creator ? ` by ${escapeHtml(data.creator)}` : "";
    for (const [telegramUserId, patterns] of userSubs) {
      const msg = [
        `🔔 <b>New package matching your subscriptions:</b>`,
        ``,
        `📦 <b>${escapeHtml(data.fileName)}</b>${creator}`,
        ...(data.tags && data.tags.length > 0
          ? [`🏷️ ${data.tags.map((t: string) => escapeHtml(t)).join(", ")}`]
          : []),
        ``,
        `Matched: ${patterns.map((p) => `"${escapeHtml(p)}"`).join(", ")}`,
        ``,
        `Use /package ${data.packageId} for details.`,
      ].join("\n");

      await sendTextMessage(BigInt(telegramUserId), msg, "textParseModeHTML").catch((err) => {
        log.warn(
          { err, telegramUserId, packageId: data.packageId },
          "Failed to notify subscriber"
        );
      });

      // Rate limit delay between notifications (~20 msgs/sec, under 30 msgs/sec bot limit)
      await sleep(50);
    }
  } catch (err) {
    log.error({ err, payload }, "Failed to process new_package notification");
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
