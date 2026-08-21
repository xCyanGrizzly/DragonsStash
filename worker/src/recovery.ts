import { childLogger } from "./util/logger.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { withFloodWait } from "./util/retry.js";
import {
  getActiveAccounts,
  getPackagesWithDestMessage,
  resetPackageDestination,
  getGlobalDestinationChannel,
} from "./db/queries.js";
import type { Client } from "tdl";

const log = childLogger("recovery");

/**
 * Verify that destination messages still exist in Telegram for all
 * packages that claim to be uploaded. If a message is missing (deleted
 * or never actually committed), reset the package so the next ingestion
 * run will re-download and re-upload it.
 *
 * This handles the case where the worker crashed mid-upload: TDLib may
 * have returned a temporary message ID that was stored as destMessageId
 * but the upload never completed server-side, or the message was later
 * deleted from the destination channel.
 *
 * Called once on worker startup, before the scheduler begins.
 */
export async function recoverIncompleteUploads(): Promise<void> {
  const packages = await getPackagesWithDestMessage();
  if (packages.length === 0) {
    log.debug("No packages with destination messages to verify");
    return;
  }

  // We need a TDLib client to verify messages. Use the first active account.
  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    log.info("No active accounts available for upload verification, skipping recovery");
    return;
  }

  const destChannel = await getGlobalDestinationChannel();
  if (!destChannel) {
    log.info("No destination channel configured, skipping recovery");
    return;
  }

  // Group packages by destChannelId for efficient verification
  const byChannel = new Map<string, typeof packages>();
  for (const pkg of packages) {
    const channelId = pkg.destChannelId!;
    if (!byChannel.has(channelId)) {
      byChannel.set(channelId, []);
    }
    byChannel.get(channelId)!.push(pkg);
  }

  log.info(
    { totalPackages: packages.length, channels: byChannel.size },
    "Verifying destination messages exist in Telegram"
  );

  const account = accounts[0];
  let client: Client | undefined;

  try {
    ({ client } = await createTdlibClient({ id: account.id, phone: account.phone }));

    // Load the chat list so TDLib can resolve chat IDs
    try {
      await client.invoke({
        _: "getChats",
        chat_list: { _: "chatListMain" },
        limit: 1000,
      });
    } catch {
      // May already be loaded
    }

    let resetCount = 0;
    let verifiedCount = 0;
    let unknownCount = 0;
    let wrongContentCount = 0;

    // Batch size for getMessages. TDLib accepts up to ~100 IDs per call.
    // Using 100 means 20k packages → ~200 round-trips instead of 20k.
    const BATCH_SIZE = 100;
    // Telegram soft-throttles sustained sequential history reads from user
    // accounts — no FLOOD_WAIT, just growing per-call latency the longer a
    // single in-flight request stream runs. A small number of batches in
    // flight at once cuts wall-clock time substantially without approaching
    // real per-account rate limits.
    const CONCURRENCY = 3;

    const tdlibClient = client;
    const destChannelInfo = destChannel;
    const batches: (typeof packages)[] = [];
    for (const [, channelPackages] of byChannel) {
      for (let i = 0; i < channelPackages.length; i += BATCH_SIZE) {
        batches.push(channelPackages.slice(i, i + BATCH_SIZE));
      }
    }

    async function processBatch(batch: typeof packages) {
      const batchResults = await verifyMessagesBatch(
        tdlibClient,
        destChannelInfo.telegramId,
        batch.map((p) => p.destMessageId!)
      );

      for (let j = 0; j < batch.length; j++) {
        const pkg = batch[j];
        const result = batchResults[j];

        if (result.state === "exists") {
          verifiedCount++;
        } else if (result.state === "deleted") {
          log.warn(
            {
              packageId: pkg.id,
              fileName: pkg.fileName,
              destMessageId: Number(pkg.destMessageId),
            },
            "Destination message missing in Telegram, resetting package for re-upload"
          );
          await resetPackageDestination(pkg.id);
          resetCount++;
        } else if (result.state === "wrong-content") {
          // The message exists but isn't a document anymore (got cleared /
          // replaced). Treat as missing so we re-upload.
          log.warn(
            {
              packageId: pkg.id,
              fileName: pkg.fileName,
              destMessageId: Number(pkg.destMessageId),
              contentType: result.contentType,
            },
            "Destination message is not a document, resetting package for re-upload"
          );
          await resetPackageDestination(pkg.id);
          wrongContentCount++;
        } else {
          // Unknown — TDLib couldn't tell us. Don't reset, but DO count this
          // so the summary line shows recovery wasn't 100% successful.
          unknownCount++;
          log.warn(
            {
              packageId: pkg.id,
              fileName: pkg.fileName,
              destMessageId: Number(pkg.destMessageId),
              reason: result.reason.slice(0, 200),
            },
            "Could not verify destination message — will retry on next startup"
          );
        }
      }
    }

    let nextBatchIndex = 0;
    async function poolWorker() {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex++];
        await processBatch(batch);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => poolWorker())
    );

    log.info(
      {
        verifiedCount,
        resetCount,
        wrongContentCount,
        unknownCount,
        totalChecked: packages.length,
      },
      unknownCount === 0
        ? "Upload recovery complete"
        : "Upload recovery complete — some packages could not be verified, will retry next startup"
    );
  } catch (err) {
    log.error({ err }, "Upload recovery failed (non-fatal, will retry next startup)");
  } finally {
    if (client) {
      await closeTdlibClient(client);
    }
  }
}

type VerifyResult =
  | { state: "exists" }
  | { state: "deleted" }
  | { state: "wrong-content"; contentType: string }
  | { state: "unknown"; reason: string };

/**
 * Batch version of verifyMessageExists. Calls TDLib's getMessages (plural)
 * with up to ~100 message IDs at once. Returns one VerifyResult per input
 * ID, in input order. Missing messages come back as null in TDLib's response
 * — translated to {state: "deleted"} here.
 *
 * Falls back to per-message verification on any error so that one bad batch
 * doesn't lose all verification for that chunk.
 */
async function verifyMessagesBatch(
  client: Client,
  chatTelegramId: bigint,
  messageIds: bigint[]
): Promise<VerifyResult[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await withFloodWait(
      () =>
        client.invoke({
          _: "getMessages",
          chat_id: Number(chatTelegramId),
          message_ids: messageIds.map((id) => Number(id)),
        }),
      "getMessages:verify"
    )) as { messages?: (null | { content?: { _: string } })[] };

    const messages = result.messages ?? [];
    return messageIds.map((_id, i) => {
      const m = messages[i];
      if (!m || !m.content) return { state: "deleted" };
      if (m.content._ !== "messageDocument") {
        return { state: "wrong-content", contentType: String(m.content._) };
      }
      return { state: "exists" };
    });
  } catch (err) {
    // If the whole batch errors out, fall back to per-message verification.
    log.warn(
      { err, batchSize: messageIds.length, chatTelegramId: chatTelegramId.toString() },
      "getMessages batch failed, falling back to per-message verification"
    );
    const out: VerifyResult[] = [];
    for (const id of messageIds) {
      out.push(await verifyMessageExists(client, chatTelegramId, id));
    }
    return out;
  }
}

/**
 * Check whether a message exists in a Telegram chat and is the document we
 * uploaded. Returns a discriminated result instead of a bare boolean so the
 * caller can distinguish "definitely gone" (reset) from "couldn't reach TG"
 * (leave alone, try again next startup).
 *
 * Previous version conflated all non-404 errors with "exists", which masked
 * recovery completely when TDLib had a degraded connection — the worker
 * would log "all destination messages verified" even though it had answered
 * questions it couldn't actually answer.
 */
async function verifyMessageExists(
  client: Client,
  chatTelegramId: bigint,
  messageId: bigint
): Promise<VerifyResult> {
  try {
    const result = await withFloodWait(
      () =>
        client.invoke({
          _: "getMessage",
          chat_id: Number(chatTelegramId),
          message_id: Number(messageId),
        }),
      "getMessage:verify"
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = result as any;
    if (!msg || !msg.content) {
      return { state: "deleted" };
    }

    if (msg.content._ !== "messageDocument") {
      return { state: "wrong-content", contentType: String(msg.content._) };
    }

    return { state: "exists" };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number })?.code;

    // Hard "the message is definitely gone" signals from TDLib:
    //   - HTTP 404
    //   - "Message not found" / "MESSAGE_ID_INVALID" error strings
    const lower = errMessage.toLowerCase();
    if (
      code === 404 ||
      lower.includes("message not found") ||
      lower.includes("message_id_invalid") ||
      lower.includes("messageidinvalid") ||
      lower.includes("not found")
    ) {
      return { state: "deleted" };
    }

    // Everything else (network, connection, TDLib internal) is genuinely
    // unknown — do NOT claim "verified".
    return { state: "unknown", reason: errMessage };
  }
}
