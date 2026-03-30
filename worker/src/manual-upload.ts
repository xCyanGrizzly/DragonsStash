import path from "path";
import { rm } from "fs/promises";
import { db } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import { config } from "./util/config.js";
import { hashParts } from "./archive/hash.js";
import { byteLevelSplit } from "./archive/split.js";
import { uploadToChannel } from "./upload/channel.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
import { getActiveAccounts } from "./db/queries.js";

const log = childLogger("manual-upload");

export async function processManualUpload(uploadId: string): Promise<void> {
  log.info({ uploadId }, "Processing manual upload");

  const upload = await db.manualUpload.findUnique({
    where: { id: uploadId },
    include: { files: true },
  });

  if (!upload || upload.status !== "PENDING") {
    log.warn({ uploadId }, "Manual upload not found or not pending");
    return;
  }

  await db.manualUpload.update({
    where: { id: uploadId },
    data: { status: "PROCESSING" },
  });

  try {
    // Get destination channel
    const destSetting = await db.globalSetting.findUnique({
      where: { key: "destination_channel_id" },
    });
    if (!destSetting) throw new Error("No destination channel configured");

    const destChannel = await db.telegramChannel.findFirst({
      where: { id: destSetting.value, type: "DESTINATION", isActive: true },
    });
    if (!destChannel) throw new Error("Destination channel not found or inactive");

    // Get a TDLib client (use first active account)
    const accounts = await getActiveAccounts();
    const account = accounts[0];
    if (!account) throw new Error("No authenticated Telegram account available");

    const client = await createTdlibClient({ id: account.id, phone: account.phone });

    try {
      const packageIds: string[] = [];

      for (const file of upload.files) {
        try {
          const filePath = file.filePath;
          const fileName = file.fileName;
          const fileSize = file.fileSize;

          log.info({ fileName, fileSize: Number(fileSize) }, "Processing file");

          // Determine archive type
          let archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT" = "DOCUMENT";
          const ext = fileName.toLowerCase();
          if (ext.endsWith(".zip")) archiveType = "ZIP";
          else if (ext.endsWith(".rar")) archiveType = "RAR";
          else if (ext.endsWith(".7z")) archiveType = "SEVEN_Z";

          // Hash the file
          const contentHash = await hashParts([filePath]);

          // Check for duplicates
          const existing = await db.package.findFirst({
            where: { contentHash, destMessageId: { not: null } },
            select: { id: true },
          });

          if (existing) {
            log.info({ fileName, contentHash }, "Duplicate file, skipping upload");
            await db.manualUploadFile.update({
              where: { id: file.id },
              data: { packageId: existing.id },
            });
            packageIds.push(existing.id);
            continue;
          }

          // Read archive metadata
          let entries: {
            path: string;
            fileName: string;
            extension: string | null;
            compressedSize: bigint;
            uncompressedSize: bigint;
            crc32: string | null;
          }[] = [];
          try {
            if (archiveType === "ZIP") entries = await readZipCentralDirectory([filePath]);
            else if (archiveType === "RAR") entries = await readRarContents(filePath);
            else if (archiveType === "SEVEN_Z") entries = await read7zContents(filePath);
          } catch {
            log.debug({ fileName }, "Could not read archive metadata");
          }

          // Split if needed
          const MAX_UPLOAD_SIZE = BigInt(config.maxPartSizeMB) * 1024n * 1024n;
          let uploadPaths = [filePath];
          if (fileSize > MAX_UPLOAD_SIZE) {
            uploadPaths = await byteLevelSplit(filePath);
          }

          // Upload to Telegram
          const destResult = await uploadToChannel(
            client,
            destChannel.telegramId,
            uploadPaths
          );

          // Create package record
          const pkg = await db.package.create({
            data: {
              contentHash,
              fileName,
              fileSize,
              archiveType,
              sourceChannelId: destChannel.id,
              sourceMessageId: destResult.messageId,
              destChannelId: destChannel.id,
              destMessageId: destResult.messageId,
              destMessageIds: destResult.messageIds,
              isMultipart: uploadPaths.length > 1,
              partCount: uploadPaths.length,
              fileCount: entries.length,
              files: entries.length > 0 ? { create: entries } : undefined,
            },
          });

          await db.manualUploadFile.update({
            where: { id: file.id },
            data: { packageId: pkg.id },
          });

          packageIds.push(pkg.id);
          log.info({ fileName, packageId: pkg.id }, "File processed and uploaded");

          // Clean up split files (but not the original)
          if (uploadPaths.length > 1) {
            for (const splitPath of uploadPaths) {
              if (splitPath !== filePath) {
                await rm(splitPath, { force: true }).catch(() => {});
              }
            }
          }
        } catch (fileErr) {
          log.error({ err: fileErr, fileName: file.fileName }, "Failed to process file");
        }
      }

      // Group packages if multiple files
      if (packageIds.length >= 2) {
        const groupName =
          upload.groupName ?? upload.files[0].fileName.replace(/\.[^.]+$/, "");
        const group = await db.packageGroup.create({
          data: {
            name: groupName,
            sourceChannelId: destChannel.id,
            groupingSource: "MANUAL",
          },
        });
        await db.package.updateMany({
          where: { id: { in: packageIds } },
          data: { packageGroupId: group.id },
        });
        log.info(
          { groupId: group.id, groupName, packageCount: packageIds.length },
          "Created group for uploaded files"
        );
      }

      await db.manualUpload.update({
        where: { id: uploadId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      log.info(
        { uploadId, fileCount: upload.files.length, packageCount: packageIds.length },
        "Manual upload completed"
      );
    } finally {
      await closeTdlibClient(client);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, uploadId }, "Manual upload failed");
    await db.manualUpload.update({
      where: { id: uploadId },
      data: { status: "FAILED", errorMessage: message },
    });
  }

  // Clean up uploaded files
  try {
    const uploadDir = path.join("/data/uploads", uploadId);
    await rm(uploadDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
