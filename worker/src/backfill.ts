import path from "path";
import { mkdir, rm } from "fs/promises";
import { db } from "./db/client.js";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { withTdlibMutex } from "./util/mutex.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { downloadFile } from "./tdlib/download.js";
import { getActiveAccounts } from "./db/queries.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
import type { FileEntry } from "./archive/zip-reader.js";

const log = childLogger("backfill");

/**
 * Re-extract file listings for Packages whose fileCount is 0 — usually
 * caused by historical bugs in the archive readers (e.g. the RAR parser
 * that silently returned [] for every archive before 0bdd4ba).
 *
 * For each candidate Package:
 *   1. Download all destMessageIds from the destination channel
 *   2. Run the appropriate reader (ZIP / RAR / 7Z) on the assembled files
 *   3. Insert PackageFile rows + update Package.fileCount
 *   4. Clean up the temp files
 *
 * Triggered via pg_notify "backfill_filelists" with optional payload
 * `{"limit": N, "archiveType": "RAR"}` — both fields optional, defaults
 * are limit=100, archiveType=any.
 */
export async function processBackfillRequest(payloadJson: string): Promise<void> {
  let limit = 100;
  let archiveTypeFilter: "ZIP" | "RAR" | "SEVEN_Z" | undefined;
  try {
    const parsed = JSON.parse(payloadJson) as { limit?: number; archiveType?: string };
    if (typeof parsed.limit === "number" && parsed.limit > 0) limit = parsed.limit;
    if (parsed.archiveType === "ZIP" || parsed.archiveType === "RAR" || parsed.archiveType === "SEVEN_Z") {
      archiveTypeFilter = parsed.archiveType;
    }
  } catch {
    // Empty / invalid payload — use defaults
  }

  const candidates = await db.package.findMany({
    where: {
      fileCount: 0,
      destChannelId: { not: null },
      destMessageId: { not: null },
      archiveType: archiveTypeFilter
        ? archiveTypeFilter
        : { in: ["ZIP", "RAR", "SEVEN_Z"] },
    },
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      archiveType: true,
      destChannelId: true,
      destMessageId: true,
      destMessageIds: true,
      isMultipart: true,
      partCount: true,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (candidates.length === 0) {
    log.info({ archiveTypeFilter }, "Backfill: no candidates with fileCount=0");
    return;
  }

  log.info(
    { count: candidates.length, archiveTypeFilter },
    "Backfill: starting batch"
  );

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    log.warn("Backfill: no authenticated accounts — aborting");
    return;
  }

  // Prefer the Premium account if available (faster downloads, larger files)
  const account = accounts.find((a) => a.isPremium) ?? accounts[0];

  await withTdlibMutex(account.phone, "backfill", async () => {
    const { client } = await createTdlibClient({ id: account.id, phone: account.phone });

    try {
      // Load chats so TDLib knows about the destination chat
      try {
        await client.invoke({
          _: "getChats",
          chat_list: { _: "chatListMain" },
          limit: 1000,
        });
      } catch {
        // May already be loaded
      }

      let processed = 0;
      let succeeded = 0;
      let failed = 0;

      for (const pkg of candidates) {
        processed++;
        const ctx = { packageId: pkg.id, fileName: pkg.fileName };

        try {
          await processOnePackage(client, pkg, ctx);
          succeeded++;
        } catch (err) {
          failed++;
          log.warn({ err, ...ctx }, "Backfill failed for package");
        }
      }

      log.info(
        { processed, succeeded, failed, archiveTypeFilter },
        "Backfill batch complete"
      );
    } finally {
      await closeTdlibClient(client).catch(() => {});
    }
  });
}

interface BackfillPackage {
  id: string;
  fileName: string;
  fileSize: bigint;
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT" | string;
  destChannelId: string | null;
  destMessageId: bigint | null;
  destMessageIds: bigint[];
  isMultipart: boolean;
  partCount: number;
}

async function processOnePackage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  pkg: BackfillPackage,
  ctx: { packageId: string; fileName: string }
): Promise<void> {
  if (!pkg.destChannelId || !pkg.destMessageId) {
    log.debug(ctx, "Skipping: no destination channel/message");
    return;
  }

  // Look up the destination channel's Telegram ID
  const destChannel = await db.telegramChannel.findUnique({
    where: { id: pkg.destChannelId },
    select: { telegramId: true },
  });
  if (!destChannel) {
    throw new Error("Destination channel not found in DB");
  }
  const chatId = Number(destChannel.telegramId);

  // Resolve which message IDs to download. The Package may carry a
  // single destMessageId or multiple destMessageIds (for multipart).
  const messageIds: bigint[] =
    pkg.destMessageIds.length > 0
      ? pkg.destMessageIds
      : pkg.destMessageId
      ? [pkg.destMessageId]
      : [];

  if (messageIds.length === 0) {
    throw new Error("Package has no destination message IDs");
  }

  const tempDir = path.join(config.tempDir, `backfill_${pkg.id}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const partPaths: string[] = [];

    for (let i = 0; i < messageIds.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = (await client.invoke({
        _: "getMessage",
        chat_id: chatId,
        message_id: Number(messageIds[i]),
      })) as unknown as {
        content?: { document?: { file_name?: string; document?: { id: number; size: number } } };
      };

      const doc = message?.content?.document;
      if (!doc?.document?.id) {
        throw new Error(`Destination message ${messageIds[i]} has no document`);
      }

      const fileId = String(doc.document.id);
      const fileName = doc.file_name ?? `${pkg.id}.part${i + 1}`;
      const localPath = path.join(tempDir, fileName);

      await downloadFile(
        client,
        fileId,
        localPath,
        BigInt(doc.document.size),
        fileName
      );

      partPaths.push(localPath);
    }

    // Run the appropriate reader on the assembled file(s)
    let entries: FileEntry[] = [];
    if (pkg.archiveType === "ZIP") {
      entries = await readZipCentralDirectory(partPaths);
    } else if (pkg.archiveType === "RAR") {
      // unrar auto-discovers sibling parts when in the same directory
      entries = await readRarContents(partPaths[0]);
    } else if (pkg.archiveType === "SEVEN_Z") {
      entries = await read7zContents(partPaths[0]);
    } else {
      log.debug({ ...ctx, archiveType: pkg.archiveType }, "Skipping unsupported archive type");
      return;
    }

    if (entries.length === 0) {
      log.warn(ctx, "Reader returned 0 entries — archive may be encrypted or corrupt");
      return;
    }

    // Write everything in a single transaction so a partial backfill never
    // leaves the Package half-indexed.
    await db.$transaction(async (tx) => {
      // Re-check fileCount inside the transaction: another worker might
      // have backfilled this package between our read and write.
      const current = await tx.package.findUnique({
        where: { id: pkg.id },
        select: { fileCount: true },
      });
      if (current && current.fileCount > 0) {
        log.debug({ ...ctx, existingFileCount: current.fileCount }, "Already backfilled by another worker — skipping");
        return;
      }

      await tx.packageFile.deleteMany({ where: { packageId: pkg.id } });
      await tx.packageFile.createMany({
        data: entries.map((e) => ({
          packageId: pkg.id,
          path: e.path,
          fileName: e.fileName,
          extension: e.extension,
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
          crc32: e.crc32,
        })),
      });
      await tx.package.update({
        where: { id: pkg.id },
        data: { fileCount: entries.length },
      });
    });

    log.info({ ...ctx, fileCount: entries.length }, "Backfilled file list");
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
