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
    client = await createTdlibClient({ id: account.id, phone: account.phone });

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

    for (const [, channelPackages] of byChannel) {
      for (const pkg of channelPackages) {
        const exists = await verifyMessageExists(
          client,
          destChannel.telegramId,
          pkg.destMessageId!
        );

        if (exists) {
          verifiedCount++;
        } else {
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
        }
      }
    }

    if (resetCount > 0) {
      log.info(
        { resetCount, verifiedCount, totalChecked: packages.length },
        "Upload recovery complete — packages reset for re-processing"
      );
    } else {
      log.info(
        { verifiedCount, totalChecked: packages.length },
        "Upload recovery complete — all destination messages verified"
      );
    }
  } catch (err) {
    log.error({ err }, "Upload recovery failed (non-fatal, will retry next startup)");
  } finally {
    if (client) {
      await closeTdlibClient(client);
    }
  }
}

/**
 * Check whether a message exists in a Telegram chat.
 * Returns false if the message was deleted or never existed.
 */
async function verifyMessageExists(
  client: Client,
  chatTelegramId: bigint,
  messageId: bigint
): Promise<boolean> {
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

    // TDLib returns the message object if it exists.
    // A deleted message may return with content type "messageChatDeleteMessage"
    // or the call may throw. Check that we got a real message with content.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = result as any;
    if (!msg || !msg.content) {
      return false;
    }

    // Check that the message has document content (our uploads are documents)
    // A message that exists but has no document content was likely cleared/replaced
    if (msg.content._ !== "messageDocument") {
      log.debug(
        {
          messageId: Number(messageId),
          contentType: msg.content._,
        },
        "Destination message exists but is not a document"
      );
      return false;
    }

    return true;
  } catch (err) {
    // TDLib throws "Message not found" (error code 404) for deleted messages
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number })?.code;

    if (code === 404 || message.includes("not found") || message.includes("Not Found")) {
      return false;
    }

    // For other errors (network issues, etc.), assume the message exists
    // to avoid incorrectly resetting packages due to transient failures
    log.warn(
      { err, messageId: Number(messageId) },
      "Could not verify message (assuming it exists)"
    );
    return true;
  }
}
