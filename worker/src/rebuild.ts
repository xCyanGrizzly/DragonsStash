import type { Client } from "tdl";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { invokeWithTimeout, MAX_SCAN_PAGES } from "./tdlib/download.js";
import { isArchiveAttachment } from "./archive/detect.js";
import { extractCreatorFromFileName } from "./archive/creator.js";
import { groupArchiveSets } from "./archive/multipart.js";
import type { TelegramMessage } from "./archive/multipart.js";
import {
  getActiveAccounts,
  getGlobalDestinationChannel,
} from "./db/queries.js";
import { db } from "./db/client.js";

const log = childLogger("rebuild");

export interface RebuildProgress {
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  messagesScanned: number;
  documentsFound: number;
  packagesCreated: number;
  packagesSkipped: number;
  error?: string;
}

/**
 * Scan the destination channel for uploaded archive files and rebuild
 * the package database from what's actually there.
 *
 * Uses searchChatMessages (not getChatHistory) because the destination
 * channel may be a hidden-history supergroup.
 *
 * For each document found:
 *   1. Check if a Package record with that destMessageId already exists -> skip
 *   2. Try to match by fileName to an existing package without destMessageId -> update it
 *   3. Otherwise create a minimal Package record (no file listing, no content hash)
 *
 * This is a "best-effort" rebuild. It restores the mapping between destination
 * messages and package records so that the bot can deliver files. It does NOT
 * re-download archives or rebuild file listings (those require the source channel).
 */
export async function rebuildPackageDatabase(
  requestId: string
): Promise<void> {
  log.info({ requestId }, "Starting package database rebuild");

  try {
    await db.channelFetchRequest.update({
      where: { id: requestId },
      data: { status: "IN_PROGRESS" },
    });

    // Get an authenticated account for TDLib
    const accounts = await getActiveAccounts();
    if (accounts.length === 0) {
      throw new Error("No authenticated accounts available");
    }

    const destChannel = await getGlobalDestinationChannel();
    if (!destChannel) {
      throw new Error("No destination channel configured");
    }

    const account = accounts[0];
    const client = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });

    try {
      const progress: RebuildProgress = {
        status: "IN_PROGRESS",
        messagesScanned: 0,
        documentsFound: 0,
        packagesCreated: 0,
        packagesSkipped: 0,
      };

      // Write initial progress
      await updateRebuildProgress(requestId, progress);

      // Scan the destination channel for all document messages
      const archiveMessages = await scanDestinationChannel(
        client,
        destChannel.telegramId,
        async (scanned) => {
          progress.messagesScanned = scanned;
          await updateRebuildProgress(requestId, progress);
        }
      );

      progress.documentsFound = archiveMessages.length;
      await updateRebuildProgress(requestId, progress);

      log.info(
        {
          messagesScanned: progress.messagesScanned,
          documentsFound: archiveMessages.length,
        },
        "Destination channel scan complete"
      );

      // Group into archive sets (handles multipart)
      const archiveSets = groupArchiveSets(archiveMessages);

      log.info(
        { archiveSets: archiveSets.length, totalMessages: archiveMessages.length },
        "Grouped into archive sets"
      );

      // Get ALL source channels so we can try to match
      const sourceChannels = await db.telegramChannel.findMany({
        where: { type: "SOURCE" },
        select: { id: true, title: true },
      });
      // Use the first source channel as a fallback for unmatched packages
      const fallbackSourceId = sourceChannels[0]?.id ?? null;

      // Process each archive set
      for (const archiveSet of archiveSets) {
        const firstPart = archiveSet.parts[0];
        const fileName = firstPart.fileName;
        const destMessageId = firstPart.id;
        const totalSize = archiveSet.parts.reduce(
          (sum, p) => sum + p.fileSize,
          0n
        );

        // 1. Check if a package with this destMessageId already exists
        const existingByDest = await db.package.findFirst({
          where: {
            destChannelId: destChannel.id,
            destMessageId,
          },
          select: { id: true },
        });

        if (existingByDest) {
          progress.packagesSkipped++;
          await updateRebuildProgress(requestId, progress);
          continue;
        }

        // 2. Try to match by fileName to an existing package without destMessageId
        const existingByName = await db.package.findFirst({
          where: {
            fileName,
            destMessageId: null,
          },
          select: { id: true },
        });

        if (existingByName) {
          // Update existing record with destination info
          await db.package.update({
            where: { id: existingByName.id },
            data: {
              destChannelId: destChannel.id,
              destMessageId,
              isMultipart: archiveSet.parts.length > 1,
              partCount: archiveSet.parts.length,
            },
          });
          progress.packagesCreated++;
          log.debug({ fileName, destMessageId: Number(destMessageId) }, "Updated existing package with dest info");
          await updateRebuildProgress(requestId, progress);
          continue;
        }

        // 3. Create a new minimal Package record
        // We don't have the source message or content hash, so generate a placeholder hash
        const placeholderHash = `rebuild:${destChannel.id}:${destMessageId}`;
        const creator = extractCreatorFromFileName(fileName) ?? null;
        const archiveType = archiveSet.type;

        // We need a sourceChannelId (required FK). Use fallback if available.
        if (!fallbackSourceId) {
          log.warn(
            { fileName },
            "No source channels exist — cannot create package record without a source channel"
          );
          progress.packagesSkipped++;
          await updateRebuildProgress(requestId, progress);
          continue;
        }

        try {
          await db.package.create({
            data: {
              contentHash: placeholderHash,
              fileName,
              fileSize: totalSize,
              archiveType,
              sourceChannelId: fallbackSourceId,
              sourceMessageId: 0n, // Unknown — rebuilt from destination
              destChannelId: destChannel.id,
              destMessageId,
              isMultipart: archiveSet.parts.length > 1,
              partCount: archiveSet.parts.length,
              fileCount: 0,
              creator,
            },
          });
          progress.packagesCreated++;
          log.debug(
            { fileName, destMessageId: Number(destMessageId), creator },
            "Created new package from destination"
          );
        } catch (err) {
          // Unique constraint on contentHash — might be a race or duplicate
          if (err instanceof Error && err.message.includes("Unique constraint")) {
            log.debug({ fileName, placeholderHash }, "Package already exists (hash conflict), skipping");
            progress.packagesSkipped++;
          } else {
            throw err;
          }
        }

        await updateRebuildProgress(requestId, progress);
      }

      // Done
      progress.status = "COMPLETED";
      await updateRebuildProgress(requestId, progress);

      await db.channelFetchRequest.update({
        where: { id: requestId },
        data: {
          status: "COMPLETED",
          resultJson: JSON.stringify(progress),
        },
      });

      log.info(
        {
          messagesScanned: progress.messagesScanned,
          documentsFound: progress.documentsFound,
          packagesCreated: progress.packagesCreated,
          packagesSkipped: progress.packagesSkipped,
        },
        "Package database rebuild complete"
      );
    } finally {
      await closeTdlibClient(client);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, requestId }, "Package database rebuild failed");

    await db.channelFetchRequest.update({
      where: { id: requestId },
      data: {
        status: "FAILED",
        error: message,
        resultJson: JSON.stringify({
          status: "FAILED",
          error: message,
        }),
      },
    });
  }
}

/**
 * Scan the destination channel for document messages using searchChatMessages.
 * Returns archive messages in chronological order (oldest first).
 */
async function scanDestinationChannel(
  client: Client,
  chatId: bigint,
  onProgress?: (messagesScanned: number) => Promise<void>
): Promise<TelegramMessage[]> {
  const archives: TelegramMessage[] = [];
  let currentFromId = 0;
  let totalScanned = 0;
  let pageCount = 0;
  let lastProgressUpdate = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pageCount >= MAX_SCAN_PAGES) {
      log.warn(
        { chatId: chatId.toString(), pageCount, totalScanned },
        "Hit max page limit for destination scan, stopping"
      );
      break;
    }
    pageCount++;

    const previousFromId = currentFromId;

    const result = await invokeWithTimeout<{
      messages?: {
        id: number;
        date: number;
        content: {
          _: string;
          document?: {
            file_name?: string;
            document?: {
              id: number;
              size: number;
            };
          };
        };
      }[];
    }>(client, {
      _: "searchChatMessages",
      chat_id: Number(chatId),
      query: "",
      from_message_id: currentFromId,
      offset: 0,
      limit: 100,
      filter: { _: "searchMessagesFilterDocument" },
      sender_id: null,
      message_thread_id: 0,
      saved_messages_topic_id: 0,
    });

    if (!result.messages || result.messages.length === 0) break;

    totalScanned += result.messages.length;

    for (const msg of result.messages) {
      const doc = msg.content?.document;
      if (doc?.file_name && doc.document && isArchiveAttachment(doc.file_name)) {
        archives.push({
          id: BigInt(msg.id),
          fileName: doc.file_name,
          fileId: String(doc.document.id),
          fileSize: BigInt(doc.document.size),
          date: new Date(msg.date * 1000),
        });
      }
    }

    // Throttle progress updates to every 2 seconds
    const now = Date.now();
    if (onProgress && now - lastProgressUpdate >= 2000) {
      lastProgressUpdate = now;
      await onProgress(totalScanned);
    }

    currentFromId = result.messages[result.messages.length - 1].id;

    // Stuck detection
    if (currentFromId === previousFromId) {
      log.warn(
        { chatId: chatId.toString(), currentFromId, totalScanned },
        "Pagination stuck, breaking"
      );
      break;
    }

    if (result.messages.length < 100) break;

    await sleep(config.apiDelayMs);
  }

  // Final progress update
  if (onProgress) {
    await onProgress(totalScanned);
  }

  log.info(
    {
      chatId: chatId.toString(),
      archives: archives.length,
      totalScanned,
      pages: pageCount,
    },
    "Destination channel scan complete"
  );

  // Reverse to chronological order (oldest first)
  return archives.reverse();
}

/**
 * Update the rebuild progress in the fetch request's resultJson field.
 * Throttled to avoid excessive DB writes.
 */
let lastUpdateTime = 0;
async function updateRebuildProgress(
  requestId: string,
  progress: RebuildProgress
): Promise<void> {
  const now = Date.now();
  // Throttle to every 2 seconds, but always write for status changes
  if (
    progress.status !== "IN_PROGRESS" ||
    now - lastUpdateTime >= 2000
  ) {
    lastUpdateTime = now;
    try {
      await db.channelFetchRequest.update({
        where: { id: requestId },
        data: {
          resultJson: JSON.stringify(progress),
        },
      });
    } catch {
      // Best-effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
