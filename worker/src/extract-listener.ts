import path from "path";
import { mkdir, rm } from "fs/promises";
import { db } from "./db/client.js";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { downloadFile } from "./tdlib/download.js";
import { getActiveAccounts } from "./db/queries.js";
import { extractPreviewImage } from "./preview/extract.js";
import { getImageMimeType } from "./archive/extract-image.js";

const log = childLogger("extract-listener");

/**
 * Process a single archive extract request.
 * Downloads the archive from Telegram (dest channel), extracts the
 * requested image file, and writes the result to the DB.
 */
export async function processExtractRequest(requestId: string): Promise<void> {
  const request = await db.archiveExtractRequest.findUnique({
    where: { id: requestId },
    include: {
      package: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          archiveType: true,
          destChannelId: true,
          destMessageId: true,
          isMultipart: true,
          partCount: true,
        },
      },
    },
  });

  if (!request || request.status !== "PENDING") {
    log.debug({ requestId }, "Extract request not found or not pending");
    return;
  }

  const pkg = request.package;
  if (!pkg.destChannelId || !pkg.destMessageId) {
    await db.archiveExtractRequest.update({
      where: { id: requestId },
      data: { status: "FAILED", error: "Package has no destination upload" },
    });
    return;
  }

  // Multipart archives require downloading and reassembling all parts,
  // which is too complex for on-demand extraction. Reject early.
  if (pkg.isMultipart && pkg.partCount > 1) {
    await db.archiveExtractRequest.update({
      where: { id: requestId },
      data: { status: "FAILED", error: "Image extraction is not supported for multipart archives" },
    });
    return;
  }

  // Check for a cached result first: if another request for the same
  // package+filePath already completed, reuse its data.
  const cached = await db.archiveExtractRequest.findFirst({
    where: {
      packageId: pkg.id,
      filePath: request.filePath,
      status: "COMPLETED",
      imageData: { not: null },
      id: { not: requestId },
    },
    select: { imageData: true, contentType: true },
  });

  if (cached?.imageData) {
    log.info({ requestId, filePath: request.filePath }, "Reusing cached extraction result");
    await db.archiveExtractRequest.update({
      where: { id: requestId },
      data: {
        status: "COMPLETED",
        imageData: cached.imageData,
        contentType: cached.contentType,
      },
    });
    return;
  }

  await db.archiveExtractRequest.update({
    where: { id: requestId },
    data: { status: "IN_PROGRESS" },
  });

  log.info(
    { requestId, packageId: pkg.id, filePath: request.filePath, archiveType: pkg.archiveType },
    "Processing extract request"
  );

  const tempDir = path.join(config.tempDir, `extract_${requestId}`);

  try {
    await mkdir(tempDir, { recursive: true });

    // Wrap the entire TDLib session in the mutex so no other TDLib
    // operation can run concurrently (TDLib is single-session).
    await withTdlibMutex("extract", async () => {
      const accounts = await getActiveAccounts();
      if (accounts.length === 0) {
        throw new Error("No authenticated Telegram accounts available");
      }

      const account = accounts[0];
      const client = await createTdlibClient({ id: account.id, phone: account.phone });

      try {
        // Load chat list so TDLib can find the dest channel
        try {
          await client.invoke({
            _: "getChats",
            chat_list: { _: "chatListMain" },
            limit: 1000,
          });
        } catch {
          // May already be loaded
        }

        // Get the dest channel telegram ID
        const destChannel = await db.telegramChannel.findUnique({
          where: { id: pkg.destChannelId! },
          select: { telegramId: true },
        });

        if (!destChannel) {
          throw new Error("Destination channel not found in DB");
        }

        const chatId = Number(destChannel.telegramId);
        const messageId = Number(pkg.destMessageId);

        // Get the file_id from the destination message
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = await client.invoke({
          _: "getMessage",
          chat_id: chatId,
          message_id: messageId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;

        const doc = message?.content?.document;
        if (!doc?.document?.id) {
          throw new Error("Could not find document in destination message");
        }

        const fileId = String(doc.document.id);
        const fileName = doc.file_name || pkg.fileName;
        const archivePath = path.join(tempDir, fileName);

        log.info(
          { requestId, fileName, fileId, chatId, messageId },
          "Downloading archive for extraction"
        );

        await downloadFile(
          client,
          fileId,
          archivePath,
          pkg.fileSize,
          fileName
        );

        // Extract the requested image using the existing CLI-based extractor.
        // This pipes the file to stdout (no temp files needed for the extracted image).
        const imageData = await extractPreviewImage(
          archivePath,
          pkg.archiveType as "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT",
          request.filePath
        );

        if (!imageData) {
          throw new Error(`Could not extract "${request.filePath}" from archive`);
        }

        // Cap at 5MB for safety
        if (imageData.length > 5 * 1024 * 1024) {
          throw new Error(`Extracted image is too large (${(imageData.length / 1024 / 1024).toFixed(1)}MB)`);
        }

        const contentType = getImageMimeType(request.filePath);

        await db.archiveExtractRequest.update({
          where: { id: requestId },
          data: {
            status: "COMPLETED",
            imageData: new Uint8Array(imageData),
            contentType,
          },
        });

        log.info(
          { requestId, filePath: request.filePath, bytes: imageData.length },
          "Image extracted successfully"
        );
      } finally {
        await closeTdlibClient(client).catch(() => {});
      }
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err, requestId }, "Extract request failed");
    await db.archiveExtractRequest.update({
      where: { id: requestId },
      data: { status: "FAILED", error: errMsg },
    }).catch(() => {});
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
