import type { Client } from "tdl";
import { childLogger } from "./util/logger.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { scanChatDocuments } from "./tdlib/chat-documents.js";
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
    const { client } = await createTdlibClient({
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
        const archiveType = archiveSet.type === "7Z" ? "SEVEN_Z" as const : archiveSet.type as "ZIP" | "RAR" | "DOCUMENT";

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
 * Scan the destination channel and keep only the documents whose names
 * `archive/detect.ts` recognizes. The paging itself lives in
 * `tdlib/chat-documents.ts` and is shared with the file-list repair path.
 */
async function scanDestinationChannel(
  client: Client,
  chatId: bigint,
  onProgress?: (messagesScanned: number) => Promise<void>
): Promise<TelegramMessage[]> {
  const scan = await scanChatDocuments(client, chatId, onProgress);

  const archives: TelegramMessage[] = [];
  for (const doc of scan.documents) {
    if (isArchiveAttachment(doc.fileName)) {
      archives.push(doc);
    } else {
      // Not matched by any pattern in archive/detect.ts, so it is dropped without a
      // packages/skipped_packages row. Grep "unrecognized attachment" to find naming
      // schemes we do not handle yet.
      log.debug(
        { chatId: chatId.toString(), messageId: Number(doc.id), fileName: doc.fileName },
        "Skipping unrecognized attachment (no archive/document pattern matched)"
      );
    }
  }

  log.info(
    { chatId: chatId.toString(), archives: archives.length, totalScanned: scan.totalScanned, pages: scan.pages },
    "Destination channel scan complete"
  );

  return archives;
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
