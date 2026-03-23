import path from "path";
import { unlink, readdir, mkdir, rm } from "fs/promises";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { tryAcquireLock, releaseLock } from "./db/locks.js";
import {
  getSourceChannelMappings,
  getGlobalDestinationChannel,
  packageExistsByHash,
  packageExistsBySourceMessage,
  createPackageWithFiles,
  createIngestionRun,
  completeIngestionRun,
  failIngestionRun,
  updateLastProcessedMessage,
  updateRunActivity,
  setChannelForum,
  getTopicProgress,
  upsertTopicProgress,
  upsertChannel,
  ensureAccountChannelLink,
  getGlobalSetting,
  getChannelFetchRequest,
  updateFetchRequestStatus,
  getAccountLinkedChannelIds,
  getExistingChannelsByTelegramId,
  getAccountById,
  deleteOrphanedPackageByHash,
} from "./db/queries.js";
import type { ActivityUpdate } from "./db/queries.js";
import { createTdlibClient, closeTdlibClient } from "./tdlib/client.js";
import { getAccountChats, joinChatByInviteLink } from "./tdlib/chats.js";
import { getChannelMessages, downloadFile, downloadPhotoThumbnail } from "./tdlib/download.js";
import type { DownloadProgress, ChannelScanResult } from "./tdlib/download.js";
import { isChatForum, getForumTopicList, getTopicMessages } from "./tdlib/topics.js";
import { matchPreviewToArchive } from "./preview/match.js";
import { pickPreviewFile, extractPreviewImage } from "./preview/extract.js";
import { groupArchiveSets } from "./archive/multipart.js";
import type { ArchiveSet } from "./archive/multipart.js";
import { extractCreatorFromFileName, extractCreatorFromChannelTitle } from "./archive/creator.js";
import { hashParts } from "./archive/hash.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
import { byteLevelSplit, concatenateFiles } from "./archive/split.js";
import { uploadToChannel } from "./upload/channel.js";
import type { TelegramAccount, TelegramChannel } from "@prisma/client";
import type { Client } from "tdl";

const log = childLogger("worker");

/**
 * Authenticate a PENDING account by creating a TDLib client.
 * TDLib will send an SMS code to the phone number, and the client.login()
 * callbacks set the authState to AWAITING_CODE. Once the admin enters the
 * code via the UI, pollForAuthCode picks it up and completes the login.
 *
 * After successful auth:
 * 1. Fetches channels from Telegram and writes as a ChannelFetchRequest
 *    (so the admin can select sources in the UI)
 * 2. Auto-joins the destination group if an invite link is configured
 */
export async function authenticateAccount(
  account: TelegramAccount
): Promise<void> {
  const aLog = childLogger("auth", { accountId: account.id, phone: account.phone });
  aLog.info("Starting authentication flow");

  let client: Client | undefined;
  try {
    client = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });
    aLog.info("Authentication successful");

    // Auto-fetch channels and create a fetch request result
    aLog.info("Fetching channels from Telegram...");
    await createAutoFetchRequest(client, account.id, aLog);

    // Auto-join the destination group if an invite link exists
    const inviteLink = await getGlobalSetting("destination_invite_link");
    if (inviteLink) {
      aLog.info("Attempting to join destination group via invite link...");
      try {
        await joinChatByInviteLink(client, inviteLink);
        // Link this account as WRITER to the destination channel
        const destChannel = await getGlobalDestinationChannel();
        if (destChannel) {
          await ensureAccountChannelLink(account.id, destChannel.id, "WRITER");
          aLog.info({ destChannel: destChannel.title }, "Joined destination group and linked as WRITER");
        }
      } catch (err) {
        // May already be a member — that's fine
        aLog.warn({ err }, "Could not join destination group (may already be a member)");
        // Still try to link as WRITER
        const destChannel = await getGlobalDestinationChannel();
        if (destChannel) {
          await ensureAccountChannelLink(account.id, destChannel.id, "WRITER");
        }
      }
    }
  } catch (err) {
    aLog.error({ err }, "Authentication failed");
  } finally {
    if (client) {
      await closeTdlibClient(client);
    }
  }
}

/**
 * Process a ChannelFetchRequest: fetch channels from Telegram,
 * enrich with DB state, and write the result JSON.
 * Called by the fetch listener (pg_notify) and by authenticateAccount.
 */
export async function processFetchRequest(requestId: string): Promise<void> {
  const aLog = childLogger("fetch-request", { requestId });
  const request = await getChannelFetchRequest(requestId);

  if (!request || request.status !== "PENDING") {
    aLog.warn("Fetch request not found or not pending, skipping");
    return;
  }

  await updateFetchRequestStatus(requestId, "IN_PROGRESS");
  aLog.info({ accountId: request.accountId }, "Processing fetch request");

  const client = await createTdlibClient({
    id: request.account.id,
    phone: request.account.phone,
  });

  try {
    const chats = await getAccountChats(client);

    // Enrich with DB state
    const linkedTelegramIds = await getAccountLinkedChannelIds(request.accountId);
    const existingChannels = await getExistingChannelsByTelegramId();

    const enrichedChats = chats.map((chat) => {
      const telegramIdStr = chat.chatId.toString();
      return {
        chatId: telegramIdStr,
        title: chat.title,
        type: chat.type,
        isForum: chat.isForum,
        memberCount: chat.memberCount ?? null,
        alreadyLinked: linkedTelegramIds.has(telegramIdStr),
        existingChannelId: existingChannels.get(telegramIdStr) ?? null,
      };
    });

    // Also upsert channel metadata while we have the data
    for (const chat of chats) {
      try {
        await upsertChannel({
          telegramId: chat.chatId,
          title: chat.title,
          type: "SOURCE",
          isForum: chat.isForum,
        });
      } catch {
        // Non-critical — metadata sync can fail silently
      }
    }

    await updateFetchRequestStatus(requestId, "COMPLETED", {
      resultJson: JSON.stringify(enrichedChats),
    });

    aLog.info(
      { total: chats.length, linked: [...linkedTelegramIds].length },
      "Fetch request completed"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    aLog.error({ err }, "Fetch request failed");
    await updateFetchRequestStatus(requestId, "FAILED", { error: message });
  } finally {
    await closeTdlibClient(client);
  }
}

/**
 * Internal helper called after authentication to auto-create a fetch request
 * with the channel list (so the UI can show the picker immediately).
 */
async function createAutoFetchRequest(
  client: Client,
  accountId: string,
  aLog: ReturnType<typeof childLogger>
): Promise<void> {
  const chats = await getAccountChats(client);

  const linkedTelegramIds = await getAccountLinkedChannelIds(accountId);
  const existingChannels = await getExistingChannelsByTelegramId();

  const enrichedChats = chats.map((chat) => {
    const telegramIdStr = chat.chatId.toString();
    return {
      chatId: telegramIdStr,
      title: chat.title,
      type: chat.type,
      isForum: chat.isForum,
      memberCount: chat.memberCount ?? null,
      alreadyLinked: linkedTelegramIds.has(telegramIdStr),
      existingChannelId: existingChannels.get(telegramIdStr) ?? null,
    };
  });

  // Upsert channel metadata
  for (const chat of chats) {
    try {
      await upsertChannel({
        telegramId: chat.chatId,
        title: chat.title,
        type: "SOURCE",
        isForum: chat.isForum,
      });
    } catch {
      // Non-critical
    }
  }

  // Create the fetch request record with the result already filled in
  const { db } = await import("./db/client.js");
  await db.channelFetchRequest.create({
    data: {
      accountId,
      status: "COMPLETED",
      resultJson: JSON.stringify(enrichedChats),
    },
  });

  aLog.info(
    { total: chats.length },
    "Auto-fetch request created with channel list"
  );
}

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

    // Load the full chat list so TDLib knows about all chats.
    // Without this, getChat/searchChatMessages fail with "Chat not found".
    // TDLib returns chats in batches — keep calling until empty.
    try {
      for (let page = 0; page < 50; page++) {
        const chatResult = await client.invoke({
          _: "getChats",
          chat_list: { _: "chatListMain" },
          limit: 100,
        }) as { chat_ids?: number[] };
        if (!chatResult.chat_ids || chatResult.chat_ids.length === 0) break;
      }
    } catch {
      // Ignore — chat list may already be loaded
    }

    const counters = {
      messagesScanned: 0,
      zipsFound: 0,
      zipsDuplicate: 0,
      zipsIngested: 0,
    };

    try {
      // 4. Get assigned source channels and global destination
      const channelMappings = await getSourceChannelMappings(account.id);
      const destChannel = await getGlobalDestinationChannel();

      if (!destChannel) {
        throw new Error("No global destination channel configured — set one in the admin UI");
      }

      const totalChannels = channelMappings.length;

      if (totalChannels === 0) {
        accountLog.info("No active source channels linked to this account — nothing to ingest");
      }

      for (let chIdx = 0; chIdx < channelMappings.length; chIdx++) {
        const mapping = channelMappings[chIdx];
        const channel = mapping.channel;
        const channelLabel = totalChannels > 1
          ? `[${chIdx + 1}/${totalChannels}] ${channel.title}`
          : channel.title;

        try {
        // ── Ensure TDLib knows about this chat ──
        // getChats may not have loaded all channels (pagination, archive folder, etc.)
        // so we explicitly load each channel before scanning.
        try {
          await client.invoke({
            _: "getChat",
            chat_id: Number(channel.telegramId),
          });
        } catch (chatErr) {
          accountLog.warn(
            { err: chatErr, channelId: channel.id, title: channel.title, telegramId: channel.telegramId.toString() },
            "TDLib does not know about this chat — it may not be accessible to this account. Skipping."
          );
          continue;
        }

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
            currentActivity: `Enumerating topics in "${channelLabel}"`,
            currentStep: "scanning",
            currentChannel: channelLabel,
            currentFile: null,
            currentFileNum: null,
            totalFiles: null,
            downloadedBytes: null,
            totalBytes: null,
            downloadPercent: null,
            messagesScanned: counters.messagesScanned,
          });

          const topics = await getForumTopicList(client, channel.telegramId);
          const topicProgressList = await getTopicProgress(mapping.id);

          accountLog.info(
            { channelId: channel.id, title: channel.title, topicCount: topics.length },
            "Scanning forum channel by topic"
          );

          for (let tIdx = 0; tIdx < topics.length; tIdx++) {
            const topic = topics[tIdx];
            try {
              const progress = topicProgressList.find(
                (tp) => tp.topicId === topic.topicId
              );

              const topicLabel = `${channel.title} › ${topic.name}`;
              const topicProgress = topics.length > 1
                ? ` (topic ${tIdx + 1}/${topics.length})`
                : "";

              await updateRunActivity(activeRunId, {
                currentActivity: `Scanning "${topicLabel}"${topicProgress}`,
                currentStep: "scanning",
                currentChannel: channelLabel,
                currentFile: null,
                currentFileNum: null,
                totalFiles: null,
                downloadedBytes: null,
                totalBytes: null,
                downloadPercent: null,
                messagesScanned: counters.messagesScanned,
              });

              const scanResult = await getTopicMessages(
                client,
                channel.telegramId,
                topic.topicId,
                progress?.lastProcessedMessageId,
                100,
                (scanned) => {
                  throttled.update({
                    currentActivity: `Scanning "${topicLabel}"${topicProgress} — ${scanned} messages scanned`,
                    currentStep: "scanning",
                    currentChannel: channelLabel,
                    messagesScanned: counters.messagesScanned + scanned,
                  });
                }
              );

              // Add scanned messages to global counter
              counters.messagesScanned += scanResult.totalScanned;

              if (scanResult.archives.length === 0) {
                accountLog.info(
                  { channelId: channel.id, topic: topic.name, totalScanned: scanResult.totalScanned },
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

              const maxProcessedId = await processArchiveSets(pipelineCtx, scanResult, run.id, progress?.lastProcessedMessageId);

              // Only advance progress to the highest successfully processed message
              if (maxProcessedId) {
                await upsertTopicProgress(
                  mapping.id,
                  topic.topicId,
                  topic.name,
                  maxProcessedId
                );
              }
            } catch (topicErr) {
              accountLog.warn(
                { err: topicErr, channelId: channel.id, topic: topic.name, topicId: topic.topicId.toString() },
                "Failed to process topic, skipping"
              );
            }
          }
        } else {
          // ── Non-forum channel: flat scan (existing behavior) ──
          await updateRunActivity(activeRunId, {
            currentActivity: `Scanning "${channelLabel}" for new archives`,
            currentStep: "scanning",
            currentChannel: channelLabel,
            currentFile: null,
            currentFileNum: null,
            totalFiles: null,
            downloadedBytes: null,
            totalBytes: null,
            downloadPercent: null,
            messagesScanned: counters.messagesScanned,
          });

          accountLog.info(
            { channelId: channel.id, title: channel.title },
            "Processing source channel"
          );

          const scanResult = await getChannelMessages(
            client,
            channel.telegramId,
            mapping.lastProcessedMessageId,
            100,
            (scanned) => {
              throttled.update({
                currentActivity: `Scanning "${channelLabel}" — ${scanned} messages scanned`,
                currentStep: "scanning",
                currentChannel: channelLabel,
                messagesScanned: counters.messagesScanned + scanned,
              });
            }
          );

          // Add scanned messages to global counter
          counters.messagesScanned += scanResult.totalScanned;

          if (scanResult.archives.length === 0) {
            accountLog.info({ channelId: channel.id, title: channel.title, totalScanned: scanResult.totalScanned }, "No new archives in channel");
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

          const maxProcessedId = await processArchiveSets(pipelineCtx, scanResult, run.id, mapping.lastProcessedMessageId);

          // Only advance progress to the highest successfully processed message
          if (maxProcessedId) {
            await updateLastProcessedMessage(mapping.id, maxProcessedId);
          }
        }
        } catch (channelErr) {
          accountLog.warn(
            { err: channelErr, channelId: channel.id, title: channel.title },
            "Failed to process channel, skipping to next"
          );
        }
      }

      // ── Done ──
      await throttled.flush();
      await completeIngestionRun(activeRunId, counters);
      accountLog.info({ counters }, "Ingestion run completed");
    } finally {
      await throttled.flush();
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
 *
 * Returns the highest message ID that was successfully processed (ingested or
 * confirmed duplicate). The caller should only advance the progress boundary
 * to this value — never to the max of all scanned messages.
 */
async function processArchiveSets(
  ctx: PipelineContext,
  scanResult: ChannelScanResult,
  ingestionRunId: string,
  lastProcessedMessageId?: bigint | null
): Promise<bigint | null> {
  const { client, runId, channelTitle, channel, throttled, counters, accountLog } = ctx;

  // Group into archive sets
  let archiveSets = groupArchiveSets(scanResult.archives);

  // Filter out sets where ALL parts are at or below the boundary (already processed)
  if (lastProcessedMessageId) {
    const totalBefore = archiveSets.length;
    archiveSets = archiveSets.filter((set) =>
      set.parts.some((p) => p.id > lastProcessedMessageId)
    );
    const filtered = totalBefore - archiveSets.length;
    if (filtered > 0) {
      accountLog.info(
        { filtered, remaining: archiveSets.length },
        "Filtered out already-processed archive sets"
      );
    }
  }

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
    messagesScanned: counters.messagesScanned,
  });

  // Track the highest message ID that was successfully processed
  let maxProcessedId: bigint | null = null;

  for (let setIdx = 0; setIdx < archiveSets.length; setIdx++) {
    try {
      await processOneArchiveSet(
        ctx,
        archiveSets[setIdx],
        setIdx,
        archiveSets.length,
        previewMatches,
        ingestionRunId
      );

      // Set completed (ingested or confirmed duplicate) — advance watermark
      const setMaxId = archiveSets[setIdx].parts.reduce(
        (max, p) => (p.id > max ? p.id : max),
        0n
      );
      if (setMaxId > (maxProcessedId ?? 0n)) {
        maxProcessedId = setMaxId;
      }
    } catch (setErr) {
      // If a set fails, do NOT advance the watermark past it
      accountLog.warn(
        { err: setErr, baseName: archiveSets[setIdx].baseName },
        "Archive set failed, watermark will not advance past this set"
      );
    }
  }

  return maxProcessedId;
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

  const archiveName = archiveSet.parts[0].fileName;

  // ── Early skip: check if this archive set was already ingested ──
  // This avoids re-downloading large archives that were processed in a prior run.
  const alreadyIngested = await packageExistsBySourceMessage(
    channel.id,
    archiveSet.parts[0].id
  );
  if (alreadyIngested) {
    counters.zipsDuplicate++;
    accountLog.debug(
      { fileName: archiveName, sourceMessageId: Number(archiveSet.parts[0].id) },
      "Archive already ingested (by source message), skipping"
    );
    await updateRunActivity(runId, {
      currentActivity: `Skipped ${archiveName} (already ingested)`,
      currentStep: "deduplicating",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
      zipsDuplicate: counters.zipsDuplicate,
    });
    return;
  }

  // ── Size guard: skip archives that exceed WORKER_MAX_ZIP_SIZE_MB ──
  const totalArchiveSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);
  const maxSizeBytes = BigInt(config.maxZipSizeMB) * 1024n * 1024n;
  if (totalArchiveSize > maxSizeBytes) {
    accountLog.warn(
      {
        fileName: archiveName,
        totalSizeMB: Number(totalArchiveSize / (1024n * 1024n)),
        maxSizeMB: config.maxZipSizeMB,
      },
      "Archive exceeds max size limit, skipping"
    );
    await updateRunActivity(runId, {
      currentActivity: `Skipped ${archiveName} (exceeds ${config.maxZipSizeMB}MB limit)`,
      currentStep: "skipping",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });
    return;
  }

  const tempPaths: string[] = [];
  let splitPaths: string[] = [];

  // Per-set subdirectory so uploaded files keep their original filenames
  const setDir = path.join(config.tempDir, `${ingestionRunId}_${archiveSet.parts[0].id}`);
  await mkdir(setDir, { recursive: true });

  try {
    // ── Downloading ──
    for (let partIdx = 0; partIdx < archiveSet.parts.length; partIdx++) {
      const part = archiveSet.parts[partIdx];
      const tempPath = path.join(setDir, part.fileName);

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
      } else if (archiveSet.type === "RAR") {
        entries = await readRarContents(tempPaths[0]);
      } else if (archiveSet.type === "7Z") {
        entries = await read7zContents(tempPaths[0]);
      } else if (archiveSet.type === "DOCUMENT") {
        // Standalone documents (PDF, STL, etc.) — no extraction,
        // record the file itself as the single entry
        const part = archiveSet.parts[0];
        const ext = part.fileName.match(/\.([^.]+)$/)?.[1] ?? null;
        entries = [{
          path: part.fileName,
          fileName: part.fileName,
          extension: ext,
          compressedSize: part.fileSize,
          uncompressedSize: part.fileSize,
          crc32: null,
        }];
      }
    } catch (err) {
      accountLog.warn({ err, baseName: archiveSet.baseName }, "Failed to read archive metadata, ingesting without file list");
    }

    // ── Splitting / Repacking (if needed) ──
    let uploadPaths = [...tempPaths];
    const totalSize = archiveSet.parts.reduce(
      (sum, p) => sum + p.fileSize,
      0n
    );
    const MAX_UPLOAD_SIZE = 2n * 1024n * 1024n * 1024n;
    const hasOversizedPart = archiveSet.parts.some((p) => p.fileSize > MAX_UPLOAD_SIZE);

    if (hasOversizedPart) {
      // Full repack: concatenate all parts → single file → re-split into uniform 2GB chunks
      await updateRunActivity(runId, {
        currentActivity: `Repacking ${archiveName} (parts >2GB, concatenating + re-splitting)`,
        currentStep: "splitting",
        currentChannel: channelTitle,
        currentFile: archiveName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
      });
      const concatPath = path.join(setDir, `${archiveSet.baseName}.concat`);
      await concatenateFiles(tempPaths, concatPath);
      splitPaths = await byteLevelSplit(concatPath);
      uploadPaths = splitPaths;
      // Clean up the concat intermediate file
      await unlink(concatPath).catch(() => {});
    } else if (!archiveSet.isMultipart && totalSize > MAX_UPLOAD_SIZE) {
      // Single file >2GB: split directly
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
      // Only set previewMsgId if we actually got the image data —
      // otherwise the UI thinks there's a preview but the API returns 404
      if (previewData) {
        previewMsgId = matchedPhoto.id;
      }
    }

    // ── Fallback: extract preview image from inside the archive ──
    if (!previewData && entries.length > 0 && archiveSet.type !== "DOCUMENT") {
      const previewEntry = pickPreviewFile(entries);
      if (previewEntry) {
        accountLog.debug(
          { fileName: archiveName, previewFile: previewEntry.path },
          "Attempting to extract preview image from archive"
        );
        const archiveTypeForExtract = archiveSet.type === "7Z" ? "SEVEN_Z" as const : archiveSet.type as "ZIP" | "RAR";
        previewData = await extractPreviewImage(
          tempPaths[0],
          archiveTypeForExtract,
          previewEntry.path
        );
      }
    }

    // ── Resolve creator: topic name > filename extraction > channel title > null ──
    const creator = topicCreator
      ?? extractCreatorFromFileName(archiveName)
      ?? extractCreatorFromChannelTitle(channelTitle)
      ?? null;

    // ── Indexing ──
    await updateRunActivity(runId, {
      currentActivity: `Saving metadata for ${archiveName} (${entries.length} files)`,
      currentStep: "indexing",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    // Clean up any orphaned record (same hash but no dest upload) before creating
    await deleteOrphanedPackageByHash(contentHash);

    // Auto-inherit source channel category as initial tag
    const tags: string[] = [];
    if (channel.category) {
      tags.push(channel.category);
    }

    await createPackageWithFiles({
      contentHash,
      fileName: archiveName,
      fileSize: totalSize,
      archiveType: archiveSet.type === "7Z" ? "SEVEN_Z" : archiveSet.type,
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
      tags,
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
    // ALWAYS delete temp files and the set directory
    await deleteFiles([...tempPaths, ...splitPaths]);
    await rm(setDir, { recursive: true, force: true }).catch(() => {});
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
 * Clean up any leftover temp files/directories from previous runs.
 */
export async function cleanupTempDir(): Promise<void> {
  try {
    const entries = await readdir(config.tempDir);
    for (const entry of entries) {
      await rm(path.join(config.tempDir, entry), { recursive: true, force: true }).catch(() => {});
    }
    if (entries.length > 0) {
      log.info({ count: entries.length }, "Cleaned up stale temp files");
    }
  } catch {
    // Directory might not exist yet
  }
}
