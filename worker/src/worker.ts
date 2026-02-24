import path from "path";
import { unlink, readdir } from "fs/promises";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { tryAcquireLock, releaseLock } from "./db/locks.js";
import {
  getSourceChannelMappings,
  getDestinationChannel,
  packageExistsByHash,
  createPackageWithFiles,
  createIngestionRun,
  completeIngestionRun,
  failIngestionRun,
  updateLastProcessedMessage,
  updateRunActivity,
  setChannelForum,
  getTopicProgress,
  upsertTopicProgress,
} from "./db/queries.js";
import type { ActivityUpdate } from "./db/queries.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { getChannelMessages, downloadFile, downloadPhotoThumbnail } from "./tdlib/download.js";
import type { DownloadProgress, ChannelScanResult } from "./tdlib/download.js";
import { isChatForum, getForumTopicList, getTopicMessages } from "./tdlib/topics.js";
import { matchPreviewToArchive } from "./preview/match.js";
import { groupArchiveSets } from "./archive/multipart.js";
import type { ArchiveSet } from "./archive/multipart.js";
import { extractCreatorFromFileName } from "./archive/creator.js";
import { hashParts } from "./archive/hash.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { byteLevelSplit } from "./archive/split.js";
import { uploadToChannel } from "./upload/channel.js";
import type { TelegramAccount, TelegramChannel } from "@prisma/client";
import type { Client } from "tdl";

const log = childLogger("worker");

/**
 * Throttle DB writes for download progress to avoid hammering the DB.
 * Only writes if at least 2 seconds have passed since the last write.
 */
function createThrottledActivityUpdater(runId: string, minIntervalMs = 2000) {
  let lastWriteTime = 0;
  let pendingUpdate: ActivityUpdate | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (pendingUpdate) {
      const update = pendingUpdate;
      pendingUpdate = null;
      lastWriteTime = Date.now();
      await updateRunActivity(runId, update).catch(() => {});
    }
  };

  return {
    update: (activity: ActivityUpdate) => {
      pendingUpdate = activity;
      const elapsed = Date.now() - lastWriteTime;
      if (elapsed >= minIntervalMs) {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, minIntervalMs - elapsed);
      }
    },
    flush,
  };
}

/** Shared context passed to the archive processing pipeline. */
interface PipelineContext {
  client: Client;
  runId: string;
  channelTitle: string;
  channel: TelegramChannel;
  destChannelTelegramId: bigint;
  destChannelId: string;
  throttled: ReturnType<typeof createThrottledActivityUpdater>;
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
  };
  /** Creator from forum topic name (null for non-forum). */
  topicCreator: string | null;
  /** Forum topic ID (null for non-forum). */
  sourceTopicId: bigint | null;
  accountLog: ReturnType<typeof childLogger>;
}

/**
 * Run a full ingestion cycle for a single Telegram account.
 * Every step writes live activity to the DB so the admin UI can display it.
 */
export async function runWorkerForAccount(
  account: TelegramAccount
): Promise<void> {
  const accountLog = childLogger("worker", { accountId: account.id, phone: account.phone });

  // 1. Acquire advisory lock
  const acquired = await tryAcquireLock(account.id);
  if (!acquired) {
    accountLog.info("Account already locked, skipping");
    return;
  }

  let runId: string | undefined;

  try {
    // 2. Create ingestion run
    const run = await createIngestionRun(account.id);
    runId = run.id;
    const activeRunId = runId;
    accountLog.info({ runId }, "Ingestion run started");

    const throttled = createThrottledActivityUpdater(activeRunId);

    // 3. Initialize TDLib client
    await updateRunActivity(activeRunId, {
      currentActivity: "Connecting to Telegram",
      currentStep: "connecting",
    });

    const client = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });

    const counters = {
      messagesScanned: 0,
      zipsFound: 0,
      zipsDuplicate: 0,
      zipsIngested: 0,
    };

    try {
      // 4. Get assigned source channels and destination
      const channelMappings = await getSourceChannelMappings(account.id);
      const destChannel = await getDestinationChannel(account.id);

      if (!destChannel) {
        throw new Error("No active destination channel configured");
      }

      for (const mapping of channelMappings) {
        const channel = mapping.channel;

        // ── Check if channel is a forum ──
        const forum = await isChatForum(client, channel.telegramId);
        if (forum !== channel.isForum) {
          await setChannelForum(channel.id, forum);
          accountLog.info(
            { channelId: channel.id, title: channel.title, isForum: forum },
            "Updated channel forum status"
          );
        }

        const pipelineCtx: PipelineContext = {
          client,
          runId: activeRunId,
          channelTitle: channel.title,
          channel,
          destChannelTelegramId: destChannel.telegramId,
          destChannelId: destChannel.id,
          throttled,
          counters,
          topicCreator: null,
          sourceTopicId: null,
          accountLog,
        };

        if (forum) {
          // ── Forum channel: scan per-topic ──
          await updateRunActivity(activeRunId, {
            currentActivity: `Enumerating topics in "${channel.title}"`,
            currentStep: "scanning",
            currentChannel: channel.title,
            currentFile: null,
            currentFileNum: null,
            totalFiles: null,
            downloadedBytes: null,
            totalBytes: null,
            downloadPercent: null,
          });

          const topics = await getForumTopicList(client, channel.telegramId);
          const topicProgressList = await getTopicProgress(mapping.id);

          accountLog.info(
            { channelId: channel.id, title: channel.title, topicCount: topics.length },
            "Scanning forum channel by topic"
          );

          for (const topic of topics) {
            const progress = topicProgressList.find(
              (tp) => tp.topicId === topic.topicId
            );

            await updateRunActivity(activeRunId, {
              currentActivity: `Scanning topic "${topic.name}" in "${channel.title}"`,
              currentStep: "scanning",
              currentChannel: `${channel.title} › ${topic.name}`,
              currentFile: null,
              currentFileNum: null,
              totalFiles: null,
              downloadedBytes: null,
              totalBytes: null,
              downloadPercent: null,
            });

            const scanResult = await getTopicMessages(
              client,
              channel.telegramId,
              topic.topicId,
              progress?.lastProcessedMessageId
            );

            if (scanResult.archives.length === 0) {
              accountLog.debug(
                { channelId: channel.id, topic: topic.name },
                "No new archives in topic"
              );
              continue;
            }

            accountLog.info(
              { topic: topic.name, archives: scanResult.archives.length, photos: scanResult.photos.length },
              "Found messages in topic"
            );

            // Process archives with topic creator
            pipelineCtx.topicCreator = topic.name;
            pipelineCtx.sourceTopicId = topic.topicId;
            pipelineCtx.channelTitle = `${channel.title} › ${topic.name}`;

            await processArchiveSets(pipelineCtx, scanResult, run.id);

            // Update topic progress
            const allMsgIds = [
              ...scanResult.archives.map((m) => m.id),
              ...scanResult.photos.map((p) => p.id),
            ];
            if (allMsgIds.length > 0) {
              const maxId = allMsgIds.reduce((a, b) => (a > b ? a : b));
              await upsertTopicProgress(
                mapping.id,
                topic.topicId,
                topic.name,
                maxId
              );
            }
          }
        } else {
          // ── Non-forum channel: flat scan (existing behavior) ──
          await updateRunActivity(activeRunId, {
            currentActivity: `Scanning "${channel.title}" for new archives`,
            currentStep: "scanning",
            currentChannel: channel.title,
            currentFile: null,
            currentFileNum: null,
            totalFiles: null,
            downloadedBytes: null,
            totalBytes: null,
            downloadPercent: null,
          });

          accountLog.info(
            { channelId: channel.id, title: channel.title },
            "Processing source channel"
          );

          const scanResult = await getChannelMessages(
            client,
            channel.telegramId,
            mapping.lastProcessedMessageId
          );

          if (scanResult.archives.length === 0) {
            accountLog.debug({ channelId: channel.id }, "No new archives");
            continue;
          }

          accountLog.info(
            { archives: scanResult.archives.length, photos: scanResult.photos.length },
            "Found messages in channel"
          );

          // For non-forum, creator comes from filename (set to null, resolved per-archive)
          pipelineCtx.topicCreator = null;
          pipelineCtx.sourceTopicId = null;
          pipelineCtx.channelTitle = channel.title;

          await processArchiveSets(pipelineCtx, scanResult, run.id);

          // Update last processed message
          const allMsgIds = [
            ...scanResult.archives.map((m) => m.id),
            ...scanResult.photos.map((p) => p.id),
          ];
          if (allMsgIds.length > 0) {
            const maxId = allMsgIds.reduce((a, b) => (a > b ? a : b));
            await updateLastProcessedMessage(mapping.id, maxId);
          }
        }
      }

      // ── Done ──
      await completeIngestionRun(activeRunId, counters);
      accountLog.info({ counters }, "Ingestion run completed");
    } finally {
      await closeTdlibClient(client);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    accountLog.error({ err }, "Ingestion run failed");
    if (runId) {
      await failIngestionRun(runId, message).catch((e) =>
        accountLog.error({ e }, "Failed to mark run as failed")
      );
    }
  } finally {
    await releaseLock(account.id);
  }
}

/**
 * Process a scan result through the archive pipeline:
 * group → download → hash → dedup → metadata → split → upload → preview → index.
 */
async function processArchiveSets(
  ctx: PipelineContext,
  scanResult: ChannelScanResult,
  ingestionRunId: string
): Promise<void> {
  const { client, runId, channelTitle, channel, throttled, counters, accountLog } = ctx;

  // Group into archive sets
  const archiveSets = groupArchiveSets(scanResult.archives);
  counters.zipsFound += archiveSets.length;

  // Match preview photos to archive sets
  const previewMatches = matchPreviewToArchive(
    scanResult.photos,
    archiveSets.map((s) => ({
      baseName: s.baseName,
      firstMessageId: s.parts[0].id,
      firstMessageDate: s.parts[0].date,
    }))
  );

  if (previewMatches.size > 0) {
    accountLog.info(
      { matched: previewMatches.size, total: archiveSets.length },
      "Matched preview photos to archives"
    );
  }

  await updateRunActivity(runId, {
    currentActivity: `Found ${archiveSets.length} archive(s) in "${channelTitle}"`,
    currentStep: "scanning",
    currentChannel: channelTitle,
    totalFiles: archiveSets.length,
    zipsFound: counters.zipsFound,
  });

  for (let setIdx = 0; setIdx < archiveSets.length; setIdx++) {
    await processOneArchiveSet(
      ctx,
      archiveSets[setIdx],
      setIdx,
      archiveSets.length,
      previewMatches,
      ingestionRunId
    );
  }
}

/**
 * Process a single archive set through the full pipeline.
 */
async function processOneArchiveSet(
  ctx: PipelineContext,
  archiveSet: ArchiveSet,
  setIdx: number,
  totalSets: number,
  previewMatches: Map<string, { id: bigint; fileId: string }>,
  ingestionRunId: string
): Promise<void> {
  const {
    client, runId, channelTitle, channel,
    destChannelTelegramId, destChannelId,
    throttled, counters, topicCreator, sourceTopicId, accountLog,
  } = ctx;

  counters.messagesScanned += archiveSet.parts.length;
  const archiveName = archiveSet.parts[0].fileName;
  const tempPaths: string[] = [];
  let splitPaths: string[] = [];

  try {
    // ── Downloading ──
    for (let partIdx = 0; partIdx < archiveSet.parts.length; partIdx++) {
      const part = archiveSet.parts[partIdx];
      const tempPath = path.join(
        config.tempDir,
        `${ingestionRunId}_${part.id}_${part.fileName}`
      );

      const partLabel = archiveSet.parts.length > 1
        ? ` (part ${partIdx + 1}/${archiveSet.parts.length})`
        : "";

      await updateRunActivity(runId, {
        currentActivity: `Downloading ${part.fileName}${partLabel}`,
        currentStep: "downloading",
        currentChannel: channelTitle,
        currentFile: part.fileName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
        downloadedBytes: 0n,
        totalBytes: part.fileSize,
        downloadPercent: 0,
        messagesScanned: counters.messagesScanned,
      });

      accountLog.info(
        {
          fileName: part.fileName,
          fileSize: Number(part.fileSize),
          part: partIdx + 1,
          totalParts: archiveSet.parts.length,
        },
        "Downloading archive part"
      );

      await downloadFile(
        client,
        part.fileId,
        tempPath,
        part.fileSize,
        part.fileName,
        (progress: DownloadProgress) => {
          throttled.update({
            currentActivity: `Downloading ${part.fileName}${partLabel} — ${progress.percent}%`,
            currentStep: "downloading",
            currentChannel: channelTitle,
            currentFile: part.fileName,
            currentFileNum: setIdx + 1,
            totalFiles: totalSets,
            downloadedBytes: BigInt(progress.downloadedBytes),
            totalBytes: BigInt(progress.totalBytes),
            downloadPercent: progress.percent,
          });
        }
      );
      await throttled.flush();
      tempPaths.push(tempPath);
    }

    // ── Hashing ──
    await updateRunActivity(runId, {
      currentActivity: `Computing hash for ${archiveName}`,
      currentStep: "hashing",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
      downloadedBytes: null,
      totalBytes: null,
      downloadPercent: null,
    });

    const contentHash = await hashParts(tempPaths);

    // ── Deduplicating ──
    await updateRunActivity(runId, {
      currentActivity: `Checking if ${archiveName} is a duplicate`,
      currentStep: "deduplicating",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    const exists = await packageExistsByHash(contentHash);
    if (exists) {
      counters.zipsDuplicate++;
      accountLog.debug({ contentHash }, "Duplicate archive, skipping");

      await updateRunActivity(runId, {
        currentActivity: `Skipped ${archiveName} (duplicate)`,
        currentStep: "deduplicating",
        currentChannel: channelTitle,
        currentFile: archiveName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
        zipsDuplicate: counters.zipsDuplicate,
      });
      return;
    }

    // ── Reading metadata ──
    await updateRunActivity(runId, {
      currentActivity: `Reading file list from ${archiveName}`,
      currentStep: "reading_metadata",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    let entries: { path: string; fileName: string; extension: string | null; compressedSize: bigint; uncompressedSize: bigint; crc32: string | null }[] = [];
    try {
      if (archiveSet.type === "ZIP") {
        entries = await readZipCentralDirectory(tempPaths);
      } else {
        entries = await readRarContents(tempPaths[0]);
      }
    } catch (err) {
      accountLog.warn({ err, baseName: archiveSet.baseName }, "Failed to read archive metadata, ingesting without file list");
    }

    // ── Splitting (if needed) ──
    let uploadPaths = tempPaths;
    const totalSize = archiveSet.parts.reduce(
      (sum, p) => sum + p.fileSize,
      0n
    );

    if (!archiveSet.isMultipart && totalSize > 2n * 1024n * 1024n * 1024n) {
      await updateRunActivity(runId, {
        currentActivity: `Splitting ${archiveName} for upload (>2GB)`,
        currentStep: "splitting",
        currentChannel: channelTitle,
        currentFile: archiveName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
      });
      splitPaths = await byteLevelSplit(tempPaths[0]);
      uploadPaths = splitPaths;
    }

    // ── Uploading ──
    const uploadLabel = uploadPaths.length > 1
      ? ` (${uploadPaths.length} parts)`
      : "";
    await updateRunActivity(runId, {
      currentActivity: `Uploading ${archiveName} to archive channel${uploadLabel}`,
      currentStep: "uploading",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    const destResult = await uploadToChannel(
      client,
      destChannelTelegramId,
      uploadPaths
    );

    // ── Preview thumbnail ──
    let previewData: Buffer | null = null;
    let previewMsgId: bigint | null = null;
    const matchedPhoto = previewMatches.get(archiveSet.baseName);
    if (matchedPhoto) {
      await updateRunActivity(runId, {
        currentActivity: `Downloading preview image for ${archiveName}`,
        currentStep: "preview",
        currentChannel: channelTitle,
        currentFile: archiveName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
      });
      previewData = await downloadPhotoThumbnail(client, matchedPhoto.fileId);
      previewMsgId = matchedPhoto.id;
    }

    // ── Resolve creator: topic name > filename extraction > null ──
    const creator = topicCreator ?? extractCreatorFromFileName(archiveName) ?? null;

    // ── Indexing ──
    await updateRunActivity(runId, {
      currentActivity: `Saving metadata for ${archiveName} (${entries.length} files)`,
      currentStep: "indexing",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    await createPackageWithFiles({
      contentHash,
      fileName: archiveName,
      fileSize: totalSize,
      archiveType: archiveSet.type,
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId,
      destChannelId,
      destMessageId: destResult.messageId,
      isMultipart:
        archiveSet.parts.length > 1 || uploadPaths.length > 1,
      partCount: uploadPaths.length,
      ingestionRunId,
      creator,
      previewData,
      previewMsgId,
      files: entries,
    });

    counters.zipsIngested++;

    await updateRunActivity(runId, {
      currentActivity: `Ingested ${archiveName} (${entries.length} files indexed)`,
      currentStep: "complete",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
      zipsIngested: counters.zipsIngested,
    });

    accountLog.info(
      { fileName: archiveName, contentHash, fileCount: entries.length, creator },
      "Archive ingested"
    );
  } finally {
    // ALWAYS delete temp files
    await deleteFiles([...tempPaths, ...splitPaths]);
  }
}

async function deleteFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      // File may already be deleted or never created
    }
  }
}

/**
 * Clean up any leftover temp files from previous runs.
 */
export async function cleanupTempDir(): Promise<void> {
  try {
    const files = await readdir(config.tempDir);
    for (const file of files) {
      await unlink(path.join(config.tempDir, file)).catch(() => {});
    }
    if (files.length > 0) {
      log.info({ count: files.length }, "Cleaned up stale temp files");
    }
  } catch {
    // Directory might not exist yet
  }
}
