import path from "path";
import { unlink, readdir, mkdir, rm } from "fs/promises";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { tryAcquireLock, releaseLock, tryAcquireHashLock, releaseHashLock } from "./db/locks.js";
import {
  getSourceChannelMappings,
  getGlobalDestinationChannel,
  packageExistsByHash,
  packageExistsBySourceMessage,
  createPackageStub,
  updatePackageWithMetadata,
  createIngestionRun,
  completeIngestionRun,
  failIngestionRun,
  updateLastProcessedMessage,
  updateRunActivity,
  setChannelForum,
  setChannelAllowsForwarding,
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
  getUploadedPackageByHash,
  upsertSkippedPackage,
  deleteSkippedPackage,
  getCappedSkippedMessageIds,
  findRepostedPackage,
  findPackageByRemoteUniqueId,
  getRetryableSkippedMessageIds,
  updatePackageTopicContext,
  upsertChannelScanState,
  upsertTopicScanState,
  ensureTopicProgressRows,
  isTopicFetchEnabled,
} from "./db/queries.js";
import type { ActivityUpdate } from "./db/queries.js";
import { createTdlibClient, closeTdlibClient, optimizeTdlibStorage } from "./tdlib/client.js";
import {
  getAccountChats,
  joinChatByInviteLink,
  getChannelLastMessageId,
  getForumTopicLastMessageId,
} from "./tdlib/chats.js";
import { getCurrentCycle } from "./scheduler.js";
import { getChannelMessages, downloadFile, downloadPhotoThumbnail } from "./tdlib/download.js";
import type { DownloadProgress, ChannelScanResult } from "./tdlib/download.js";
import { isChatForum, getForumTopicList, getTopicMessages } from "./tdlib/topics.js";
import { matchPreviewToArchive } from "./preview/match.js";
import { pickPreviewFile, extractPreviewImage } from "./preview/extract.js";
import { groupArchiveSets } from "./archive/multipart.js";
import type { ArchiveSet } from "./archive/multipart.js";
import { extractCreatorFromFileName, extractCreatorFromChannelTitle } from "./archive/creator.js";
import { extractSlicerTags } from "./archive/slicer-tags.js";
import { testArchiveIntegrity } from "./archive/integrity.js";
import { hashParts } from "./archive/hash.js";
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
import { readScannedListingRanged } from "./archive/ranged/dispatch.js";
import { deriveForwardContentHash } from "./archive/forward-identity.js";
import { checkFingerprintRepost } from "./archive/forward-repost-check.js";
import { forwardArchiveToChannel } from "./upload/forward.js";
import { tryProvenanceBackfill } from "./provenance-backfill.js";
import { byteLevelSplit, concatenateFiles } from "./archive/split.js";
import { uploadToChannel, UploadStallError } from "./upload/channel.js";
import { processAlbumGroups, detectGroupingConflicts, type IndexedPackageRef } from "./grouping.js";
import { db } from "./db/client.js";
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
    client = (await createTdlibClient({
      id: account.id,
      phone: account.phone,
    })).client;
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

  const { client } = await createTdlibClient({
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
  accountId: string;
  accountPhone: string;
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
    zipsBackfilled: number;
    zipsForwarded: number;
  };
  /** Creator from forum topic name (null for non-forum). */
  topicCreator: string | null;
  /** Forum topic ID (null for non-forum). */
  sourceTopicId: bigint | null;
  accountLog: ReturnType<typeof childLogger>;
  maxUploadSize: bigint;
  /** How many consecutive upload stalls have occurred (resets on success). */
  consecutiveStalls: number;
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

    // Use let so the client can be replaced on TDLib recreation after stalls
    let { client, isPremium } = await createTdlibClient({
      id: account.id,
      phone: account.phone,
    });
    const maxUploadSize = isPremium
      ? 3950n * 1024n * 1024n
      : BigInt(config.maxPartSizeMB) * 1024n * 1024n;

    // Load all chats into TDLib's local cache using loadChats (the recommended API).
    // Without this, getChat/searchChatMessages fail with "Chat not found".
    // loadChats returns a 404 when all chats have been loaded — that's the stop signal.
    //
    // TDLib 1.8.64+ removed the synchronous getChatFolders call; folder IDs
    // now arrive only via the updateChatFolders event. We listen briefly,
    // then load main + archive + any folders we caught. Chats inside folders
    // are also reachable from chatListMain so missing the folder sweep is
    // not a functional regression — it just loses a small bit of cache warming.
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const folderLists: any[] = await new Promise((resolve) => {
        const ids: number[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (update: any) => {
          if (update?._ === "updateChatFolders") {
            const folders = update.chat_folders as { id: number }[] | undefined;
            if (folders) for (const f of folders) ids.push(f.id);
          }
        };
        client.on("update", handler);
        setTimeout(() => {
          client.off("update", handler);
          resolve(ids.map((id) => ({ _: "chatListFolder", chat_folder_id: id })));
        }, 200);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatLists: any[] = [
        { _: "chatListMain" },
        { _: "chatListArchive" },
        ...folderLists,
      ];

      for (const chatList of chatLists) {
        try {
          for (let page = 0; page < 500; page++) {
            await client.invoke({
              _: "loadChats",
              chat_list: chatList,
              limit: 100,
            });
            // loadChats returns ok — keep going until 404
          }
        } catch {
          // 404 = all chats loaded (expected), or unsupported list type
        }
      }
    }

    const counters = {
      messagesScanned: 0,
      zipsFound: 0,
      zipsDuplicate: 0,
      zipsIngested: 0,
      zipsBackfilled: 0,
      zipsForwarded: 0,
    };

    try {
      // 4. Get assigned source channels and global destination
      const channelMappings = await getSourceChannelMappings(account.id);
      const destChannel = await getGlobalDestinationChannel();

      if (!destChannel) {
        throw new Error("No global destination channel configured — set one in the admin UI");
      }

      // ── Ensure TDLib knows about the destination chat ──
      // Source channels get an explicit getChat below, but the destination was
      // previously only loaded via loadChats — which can miss it if the account
      // archived/moved it. Failing here surfaces the problem clearly instead of
      // letting every upload fail with a cryptic "Chat not found".
      try {
        await client.invoke({
          _: "getChat",
          chat_id: Number(destChannel.telegramId),
        });
      } catch (destErr) {
        accountLog.error(
          { err: destErr, destChannel: destChannel.title, telegramId: destChannel.telegramId.toString() },
          "Destination chat is not accessible to this account — uploads will fail. Re-join via invite link or remove this account."
        );
        // Surface as a persistent notification so the admin sees it in the UI
        try {
          await db.systemNotification.create({
            data: {
              type: "UPLOAD_FAILED",
              severity: "ERROR",
              title: `Destination chat unreachable for ${account.phone}`,
              message: `Account ${account.phone} cannot access the destination chat "${destChannel.title}". Uploads for this account will fail until access is restored. Re-join via the invite link in admin settings.`,
              context: {
                accountId: account.id,
                accountPhone: account.phone,
                destChannelId: destChannel.id,
                destChannelTitle: destChannel.title,
              },
            },
          });
        } catch {
          // Best-effort notification
        }
        // Skip this account's ingestion cycle entirely — there's no point
        // scanning + downloading if we can't upload.
        throw new Error(
          `Destination chat "${destChannel.title}" is not accessible to account ${account.phone}`
        );
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
        // so we explicitly load each channel before scanning. The response is
        // also where we read has_protected_content (below) to decide whether
        // this channel is eligible for the forward-priority ingestion path.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let chatInfo: any;
        try {
          chatInfo = await client.invoke({
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

        // ── Check if channel allows forwarding ──
        // TDLib's chat.has_protected_content is documented on the general
        // Chat object (core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1chat.html),
        // but PENDING LIVE VERIFICATION here: confirm on first deploy that a
        // real chatTypeSupergroup/channel response actually populates this
        // field (some TDLib doc pages describe it in the context of basic
        // groups only). If it's ever `undefined` in practice, this block is a
        // no-op and allowsForwarding stays at its last-known/null value —
        // which safely keeps the channel on the download path.
        const hasProtectedContent: boolean | undefined = chatInfo?.has_protected_content;
        if (typeof hasProtectedContent === "boolean") {
          const allowsForwarding = !hasProtectedContent;
          if (allowsForwarding !== channel.allowsForwarding) {
            await setChannelAllowsForwarding(channel.id, allowsForwarding);
            accountLog.info(
              { channelId: channel.id, title: channel.title, allowsForwarding },
              "Updated channel forwarding permission"
            );
          }
          channel.allowsForwarding = allowsForwarding;
        }

        const pipelineCtx: PipelineContext = {
          client,
          runId: activeRunId,
          accountId: account.id,
          accountPhone: account.phone,
          channelTitle: channel.title,
          channel,
          destChannelTelegramId: destChannel.telegramId,
          destChannelId: destChannel.id,
          throttled,
          counters,
          topicCreator: null,
          sourceTopicId: null,
          accountLog,
          maxUploadSize,
          consecutiveStalls: 0,
        };

        if (forum) {
          // ── Forum channel: scan per-topic ──
          await updateRunActivity(activeRunId, {
            currentActivity: `Enumerating topics in "${channelLabel}"`,
            currentStep: "scanning",
            currentChannel: channelLabel,
            currentTopicId: null,
            currentAccountChannelMapId: null,
            currentFile: null,
            currentFileNum: null,
            totalFiles: null,
            downloadedBytes: null,
            totalBytes: null,
            downloadPercent: null,
            messagesScanned: counters.messagesScanned,
          });

          const rawTopics = await getForumTopicList(client, channel.telegramId);
          const topicProgressList = await getTopicProgress(mapping.id);

          // Persist a TopicProgress row for every discovered topic so the
          // admin UI can list and toggle them — including brand-new topics.
          // Inserts missing rows only; existing watermarks / scan-state /
          // fetchEnabled choices are left untouched.
          await ensureTopicProgressRows(
            mapping.id,
            rawTopics.map((t) => ({ topicId: t.topicId, name: t.name }))
          );

          // Process more-specific topics BEFORE "General" so the first
          // encounter of any file is in its most specific context. This makes
          // newly-created Packages carry useful topic info (e.g., a campaign
          // name) instead of just "General".
          const topics = [...rawTopics].sort((a, b) => {
            const aIsGeneral = a.name === "General";
            const bIsGeneral = b.name === "General";
            if (aIsGeneral === bIsGeneral) return 0;
            return aIsGeneral ? 1 : -1;
          });

          accountLog.info(
            { channelId: channel.id, title: channel.title, topicCount: topics.length },
            "Scanning forum channel by topic (specific topics first, General last)"
          );

          for (let tIdx = 0; tIdx < topics.length; tIdx++) {
            const topic = topics[tIdx];
            try {
              // ── Per-topic fetch toggle (live, mid-run honouring) ──
              // Read the CURRENT enabled flag straight from the DB (not the
              // run-start `topicProgressList` snapshot) so disabling a topic
              // mid-run skips it for the remainder of this run.
              if (!(await isTopicFetchEnabled(mapping.id, topic.topicId))) {
                accountLog.info(
                  { channel: channel.title, topic: topic.name },
                  "Topic fetch disabled by user — skipping"
                );
                continue;
              }

              let progress = topicProgressList.find(
                (tp) => tp.topicId === topic.topicId
              );

              // ── General-topic ID migration ──
              // TDLib 1.8.50 reported `info.message_thread_id = 1048576` for
              // the General topic (a magic constant). TDLib 1.8.64 reports
              // `info.forum_topic_id = 1` for the same topic. Old DB rows
              // therefore don't match the new numeric ID — fall back to a
              // name match so we don't restart General from message 0. On
              // the next watermark write, we'll save under the new ID and
              // future runs hit the topicId match directly. The orphaned
              // 1048576 row remains as harmless dead data.
              if (!progress && topic.name === "General") {
                const oldGeneral = topicProgressList.find(
                  (tp) => tp.topicName === "General" && tp.topicId !== topic.topicId
                );
                if (oldGeneral) {
                  accountLog.info(
                    {
                      channel: channel.title,
                      oldTopicId: oldGeneral.topicId.toString(),
                      newTopicId: topic.topicId.toString(),
                      preservedWatermark: oldGeneral.lastProcessedMessageId?.toString() ?? null,
                    },
                    "Reusing old General-topic progress under new TDLib forum_topic_id"
                  );
                  progress = oldGeneral;
                }
              }

              // ── Topic-scan-skip guard ──
              // Same three-signal decision as the non-forum branch, but
              // scoped to a single topic. Uses `progress` for the persisted
              // scan-state fields (lastScannedAt etc).
              try {
                const retryableForTopic = await getRetryableSkippedMessageIds({
                  accountId: account.id,
                  sourceChannelId: channel.id,
                  topicId: topic.topicId,
                  cap: config.maxSkipAttempts,
                });
                if (retryableForTopic.length === 0 && progress?.lastScannedAt) {
                  const sinceLastScanMs = Date.now() - progress.lastScannedAt.getTime();
                  const withinRecencyWindow = sinceLastScanMs < config.skipRecentScanWindowMs;
                  const inBackoff =
                    (progress.consecutiveEmptyScans ?? 0) >= config.emptyScanBackoffThreshold;
                  const backoffSkipsThisCycle =
                    inBackoff && getCurrentCycle() % config.emptyScanBackoffEveryNth !== 0;

                  if (
                    (withinRecencyWindow && !progress.lastScanFoundArchives) ||
                    backoffSkipsThisCycle
                  ) {
                    accountLog.debug(
                      {
                        channel: channel.title,
                        topic: topic.name,
                        sinceLastScanMs,
                        consecutiveEmptyScans: progress.consecutiveEmptyScans,
                        reason: withinRecencyWindow ? "recent-idle" : "backoff",
                      },
                      "Skipping topic — recently scanned and idle, or in backoff"
                    );
                    continue;
                  }
                }
              } catch (skipErr) {
                accountLog.warn(
                  { err: skipErr, topic: topic.name },
                  "Topic skip guard failed, proceeding with scan"
                );
              }

              // ── SkippedPackage retry pass ──
              // If we have failed messages in this topic with attemptCount
              // below the cap, pull the watermark back below the lowest of
              // them so the scan re-picks them up. Without this, a message
              // that failed before my watermark cap fix (or had its watermark
              // advanced past it via the all-failures fallback) is stuck in
              // SkippedPackage forever.
              try {
                const retryable = await getRetryableSkippedMessageIds({
                  accountId: account.id,
                  sourceChannelId: channel.id,
                  topicId: topic.topicId,
                  cap: config.maxSkipAttempts,
                });
                if (retryable.length > 0) {
                  const lowest = retryable[0];
                  const currentWatermark = progress?.lastProcessedMessageId ?? null;
                  if (currentWatermark !== null && currentWatermark >= lowest) {
                    const resetTo = lowest - 1n;
                    await upsertTopicProgress(
                      mapping.id,
                      topic.topicId,
                      topic.name,
                      resetTo
                    );
                    accountLog.info(
                      {
                        topic: topic.name,
                        retryableCount: retryable.length,
                        lowestSkippedMsgId: lowest.toString(),
                        oldWatermark: currentWatermark.toString(),
                        newWatermark: resetTo.toString(),
                      },
                      "Resetting topic watermark to retry skipped messages"
                    );
                    progress = { ...(progress ?? { id: "", accountChannelMapId: mapping.id, topicId: topic.topicId, topicName: topic.name }), lastProcessedMessageId: resetTo } as typeof progress;
                  }
                }
              } catch (retryErr) {
                accountLog.warn(
                  { err: retryErr, topic: topic.name },
                  "SkippedPackage retry pass failed (non-fatal)"
                );
              }

              const topicLabel = `${channel.title} › ${topic.name}`;
              const topicProgress = topics.length > 1
                ? ` (topic ${tIdx + 1}/${topics.length})`
                : "";

              // ── getForumTopic short-circuit ──
              // After the retry pass has settled the effective watermark,
              // ask TDLib for the topic's last_message_id. If it's <= our
              // watermark, no new content — skip the paginated search.
              const topicLastId = await getForumTopicLastMessageId(
                client,
                channel.telegramId,
                topic.topicId
              );
              const effectiveTopicWatermark = progress?.lastProcessedMessageId ?? null;
              if (
                topicLastId !== null
                && effectiveTopicWatermark !== null
                && topicLastId <= effectiveTopicWatermark
              ) {
                accountLog.info(
                  {
                    channel: channel.title,
                    topic: topic.name,
                    topicLastId: topicLastId.toString(),
                    watermark: effectiveTopicWatermark.toString(),
                  },
                  "Topic caught up via getForumTopic — skipping searchChatMessages"
                );
                await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                  lastProcessedMessageId: effectiveTopicWatermark,
                  lastScanFoundArchives: false,
                  consecutiveEmptyScans: (progress?.consecutiveEmptyScans ?? 0) + 1,
                });
                continue;
              }

              await updateRunActivity(activeRunId, {
                currentActivity: `Scanning "${topicLabel}"${topicProgress}`,
                currentStep: "scanning",
                currentChannel: channelLabel,
                currentTopicId: topic.topicId,
                currentAccountChannelMapId: mapping.id,
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
                // Still advance topic watermark so we don't re-scan these
                // messages next cycle. Truly idle only when no retryable
                // SkippedPackages are pending for this topic — chronically-
                // failing archives must NOT push a topic into backoff.
                const retryableTopicNoArchives = await getRetryableSkippedMessageIds({
                  accountId: account.id,
                  sourceChannelId: channel.id,
                  topicId: topic.topicId,
                  cap: config.maxSkipAttempts,
                });
                const topicTrulyIdleNoArchives = retryableTopicNoArchives.length === 0;
                if (scanResult.maxScannedMessageId) {
                  await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                    lastProcessedMessageId: scanResult.maxScannedMessageId,
                    lastScanFoundArchives: !topicTrulyIdleNoArchives,
                    consecutiveEmptyScans: topicTrulyIdleNoArchives
                      ? (progress?.consecutiveEmptyScans ?? 0) + 1
                      : 0,
                  });
                }
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

              const { maxProcessedId, minFailedId } = await processArchiveSets(
                pipelineCtx,
                scanResult,
                run.id,
                progress?.lastProcessedMessageId,
                // Incremental watermark advance — saves progress per-set so a
                // worker restart mid-scan doesn't lose all work.
                async (messageId) => {
                  await upsertTopicProgress(
                    mapping.id,
                    topic.topicId,
                    topic.name,
                    messageId
                  );
                },
                // shouldStop: re-read the live fetch flag before each archive
                // set. A mid-run "disable topic" lets the current file finish,
                // then skips the rest of this topic's archives.
                async () => !(await isTopicFetchEnabled(mapping.id, topic.topicId))
              );
              // Sync client back in case it was recreated during upload stall recovery
              client = pipelineCtx.client;

              // Final watermark write at the end of the scan (covers the
              // no-archives-found and all-failures-with-fallback cases).
              // The incremental updates above already handle the success path.
              let topicWatermark = maxProcessedId ?? scanResult.maxScannedMessageId;
              if (minFailedId !== null && topicWatermark !== null && topicWatermark >= minFailedId) {
                topicWatermark = minFailedId - 1n;
              }
              // trulyIdle: no archives this scan AND no failures AND no
              // retryable pending. Same definition as the non-forum branch.
              const retryableTopicPendingNow = await getRetryableSkippedMessageIds({
                accountId: account.id,
                sourceChannelId: channel.id,
                topicId: topic.topicId,
                cap: config.maxSkipAttempts,
              });
              const topicTrulyIdle =
                scanResult.archives.length === 0
                && minFailedId === null
                && retryableTopicPendingNow.length === 0;
              const newTopicConsecutive = topicTrulyIdle
                ? (progress?.consecutiveEmptyScans ?? 0) + 1
                : 0;
              if (topicWatermark !== null) {
                await upsertTopicScanState(mapping.id, topic.topicId, topic.name, {
                  lastProcessedMessageId: topicWatermark,
                  lastScanFoundArchives: !topicTrulyIdle,
                  consecutiveEmptyScans: newTopicConsecutive,
                });
              }
            } catch (topicErr) {
              accountLog.warn(
                { err: topicErr, channelId: channel.id, topic: topic.name, topicId: topic.topicId.toString() },
                "Failed to process topic, skipping"
              );
            }
          }
        } else {
          // ── Channel-scan-skip guard ──
          // Before any TDLib call, decide whether this channel can be
          // skipped entirely this cycle. Three signals (in order):
          //   1. retryable SkippedPackages exist → MUST scan
          //   2. lastScannedAt within window AND last scan was idle → skip
          //   3. in backoff AND not the Nth cycle → skip
          try {
            const retryable = await getRetryableSkippedMessageIds({
              accountId: account.id,
              sourceChannelId: channel.id,
              topicId: null,
              cap: config.maxSkipAttempts,
            });
            if (retryable.length === 0 && mapping.lastScannedAt) {
              const sinceLastScanMs = Date.now() - mapping.lastScannedAt.getTime();
              const withinRecencyWindow = sinceLastScanMs < config.skipRecentScanWindowMs;
              const inBackoff = mapping.consecutiveEmptyScans >= config.emptyScanBackoffThreshold;
              const backoffSkipsThisCycle =
                inBackoff && getCurrentCycle() % config.emptyScanBackoffEveryNth !== 0;

              if (
                (withinRecencyWindow && !mapping.lastScanFoundArchives) ||
                backoffSkipsThisCycle
              ) {
                accountLog.debug(
                  {
                    channel: channel.title,
                    sinceLastScanMs,
                    consecutiveEmptyScans: mapping.consecutiveEmptyScans,
                    reason: withinRecencyWindow ? "recent-idle" : "backoff",
                  },
                  "Skipping channel — recently scanned and idle, or in backoff"
                );
                continue;
              }
            }
          } catch (skipErr) {
            // Skip guard is best-effort. If the retryable query fails,
            // fall through and do the normal scan.
            accountLog.warn(
              { err: skipErr, channel: channel.title },
              "Skip guard failed, proceeding with scan"
            );
          }

          // ── Non-forum channel: flat scan (existing behavior) ──
          await updateRunActivity(activeRunId, {
            currentActivity: `Scanning "${channelLabel}" for new archives`,
            currentStep: "scanning",
            currentChannel: channelLabel,
            currentTopicId: null,
            currentAccountChannelMapId: null,
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

          // ── SkippedPackage retry pass ──
          // Pull the watermark back below the lowest still-retryable
          // SkippedPackage so they get picked up by the scan. See the matching
          // block in the forum branch for the rationale.
          let effectiveChannelWatermark = mapping.lastProcessedMessageId;
          try {
            const retryable = await getRetryableSkippedMessageIds({
              accountId: account.id,
              sourceChannelId: channel.id,
              topicId: null,
              cap: config.maxSkipAttempts,
            });
            if (retryable.length > 0) {
              const lowest = retryable[0];
              if (effectiveChannelWatermark !== null && effectiveChannelWatermark >= lowest) {
                const resetTo = lowest - 1n;
                await updateLastProcessedMessage(mapping.id, resetTo);
                accountLog.info(
                  {
                    channel: channel.title,
                    retryableCount: retryable.length,
                    lowestSkippedMsgId: lowest.toString(),
                    oldWatermark: effectiveChannelWatermark.toString(),
                    newWatermark: resetTo.toString(),
                  },
                  "Resetting channel watermark to retry skipped messages"
                );
                effectiveChannelWatermark = resetTo;
              }
            }
          } catch (retryErr) {
            accountLog.warn(
              { err: retryErr, channel: channel.title },
              "SkippedPackage retry pass failed (non-fatal)"
            );
          }

          // ── getChat short-circuit ──
          // After the retry pass has settled the effective watermark, ask
          // TDLib for the channel's last_message.id. If it's <= our watermark,
          // no new content exists since last cycle — skip the paginated
          // searchChatMessages entirely. Still update scan-state so the
          // recent-scan skip can kick in next cycle.
          const channelLastId = await getChannelLastMessageId(client, channel.telegramId);
          if (
            channelLastId !== null
            && effectiveChannelWatermark !== null
            && channelLastId <= effectiveChannelWatermark
          ) {
            accountLog.info(
              {
                channel: channel.title,
                channelLastId: channelLastId.toString(),
                watermark: effectiveChannelWatermark.toString(),
              },
              "Channel caught up via getChat — skipping searchChatMessages"
            );
            await upsertChannelScanState(mapping.id, {
              lastProcessedMessageId: effectiveChannelWatermark,
              lastScanFoundArchives: false,
              consecutiveEmptyScans: (mapping.consecutiveEmptyScans ?? 0) + 1,
            });
            continue;
          }

          const scanResult = await getChannelMessages(
            client,
            channel.telegramId,
            effectiveChannelWatermark,
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
            // Truly idle requires no retryable SkippedPackages — a channel
            // with a chronically-failing archive must NOT enter backoff just
            // because no NEW archives showed up this scan.
            const retryableNoArchives = await getRetryableSkippedMessageIds({
              accountId: account.id,
              sourceChannelId: channel.id,
              topicId: null,
              cap: config.maxSkipAttempts,
            });
            const channelTrulyIdleNoArchives = retryableNoArchives.length === 0;
            if (scanResult.maxScannedMessageId) {
              await upsertChannelScanState(mapping.id, {
                lastProcessedMessageId: scanResult.maxScannedMessageId,
                lastScanFoundArchives: !channelTrulyIdleNoArchives,
                consecutiveEmptyScans: channelTrulyIdleNoArchives
                  ? (mapping.consecutiveEmptyScans ?? 0) + 1
                  : 0,
              });
            }
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

          const { maxProcessedId, minFailedId } = await processArchiveSets(
            pipelineCtx,
            scanResult,
            run.id,
            effectiveChannelWatermark,
            // Incremental watermark advance — saves progress per-set so a
            // worker restart mid-scan doesn't lose all work.
            async (messageId) => {
              await updateLastProcessedMessage(mapping.id, messageId);
            }
          );
          // Sync client back in case it was recreated during upload stall recovery
          client = pipelineCtx.client;

          // Final watermark write at the end of the scan (covers the
          // no-archives-found and all-failures-with-fallback cases).
          // The incremental updates above already handle the success path.
          let channelWatermark = maxProcessedId ?? scanResult.maxScannedMessageId;
          if (minFailedId !== null && channelWatermark !== null && channelWatermark >= minFailedId) {
            channelWatermark = minFailedId - 1n;
          }
          // trulyIdle: nothing new this scan AND nothing failed AND no
          // retryable SkippedPackages pending. The retryable check matters —
          // a chronically-failing archive should NEVER let the channel back
          // off, even though zipsFound stays at 0 for it.
          const retryablePendingNow = await getRetryableSkippedMessageIds({
            accountId: account.id,
            sourceChannelId: channel.id,
            topicId: null,
            cap: config.maxSkipAttempts,
          });
          const trulyIdle =
            scanResult.archives.length === 0
            && minFailedId === null
            && retryablePendingNow.length === 0;
          const newConsecutive = trulyIdle
            ? (mapping.consecutiveEmptyScans ?? 0) + 1
            : 0;
          if (channelWatermark !== null) {
            await upsertChannelScanState(mapping.id, {
              lastProcessedMessageId: channelWatermark,
              lastScanFoundArchives: !trulyIdle,
              consecutiveEmptyScans: newConsecutive,
            });
          }
        }
        } catch (channelErr) {
          accountLog.warn(
            { err: channelErr, channelId: channel.id, title: channel.title },
            "Failed to process channel, skipping to next"
          );

          // If the channel is no longer accessible (account got removed,
          // channel deleted, etc.), surface a persistent notification so the
          // admin can decide what to do. Dedupe by (channelId, accountId)
          // within the last 24h so we don't flood the notifications list every
          // cycle.
          const errMsg = channelErr instanceof Error ? channelErr.message : String(channelErr);
          const isAccessError =
            errMsg.includes("Can't access the chat") ||
            errMsg.includes("CHAT_FORBIDDEN") ||
            errMsg.includes("CHANNEL_PRIVATE") ||
            errMsg.includes("Chat not found");
          if (isAccessError) {
            try {
              const recent = await db.systemNotification.findFirst({
                where: {
                  type: "CHANNEL_ACCESS_LOST",
                  context: { path: ["channelId"], equals: channel.id },
                  createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                },
                select: { id: true },
              });
              if (!recent) {
                await db.systemNotification.create({
                  data: {
                    type: "CHANNEL_ACCESS_LOST",
                    severity: "WARNING",
                    title: `Lost access to "${channel.title}" for ${account.phone}`,
                    message: `Account ${account.phone} can no longer access source channel "${channel.title}". The worker is skipping this channel every cycle. Re-join the channel or unlink it from this account in admin settings.`,
                    context: {
                      channelId: channel.id,
                      channelTitle: channel.title,
                      telegramId: channel.telegramId.toString(),
                      accountId: account.id,
                      accountPhone: account.phone,
                      errorMessage: errMsg.slice(0, 200),
                    },
                  },
                });
              }
            } catch {
              // Best-effort notification
            }
          }
        }
      }

      // ── Done ──
      await throttled.flush();
      await completeIngestionRun(activeRunId, counters);
      accountLog.info({ counters }, "Ingestion run completed");
    } finally {
      await throttled.flush();
      await optimizeTdlibStorage(client, account.id);
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
 * Infer the SkipReason from an error message so the UI shows the correct badge.
 */
function inferSkipReason(errMsg: string): "DOWNLOAD_FAILED" | "UPLOAD_FAILED" | "EXTRACT_FAILED" {
  const lower = errMsg.toLowerCase();
  if (lower.includes("upload") || lower.includes("forward") || lower.includes("too many requests") || lower.includes("retry after") || lower.includes("send")) {
    return "UPLOAD_FAILED";
  }
  if (lower.includes("extract") || lower.includes("metadata") || lower.includes("central directory") || lower.includes("archive")) {
    return "EXTRACT_FAILED";
  }
  return "DOWNLOAD_FAILED";
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
  lastProcessedMessageId?: bigint | null,
  /** Called after each successful set with a safe watermark value (capped
   *  below any failed message ID in this scan). Used by the caller to
   *  advance the channel/topic watermark incrementally — otherwise a long
   *  scan that gets killed by worker restart loses all progress. */
  onWatermarkAdvance?: (messageId: bigint) => Promise<void>,
  /** Optional cancellation check, polled before each archive set. When it
   *  resolves true, processing stops after the set currently in flight (that
   *  one completes; remaining sets in this scan are skipped). Used by the
   *  forum branch to honour a mid-run "disable topic". */
  shouldStop?: () => Promise<boolean>
): Promise<{ maxProcessedId: bigint | null; minFailedId: bigint | null }> {
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

  // Filter out sets whose source message has hit the auto-retry cap — these are
  // treated as "give up for now" so the watermark can advance past them.
  // Removing them from archiveSets means they are NOT tracked in minFailedId,
  // so the caller's watermark cap won't pin progress below them. The
  // SkippedPackage record stays so the user can manually retry via the UI.
  const cappedIds = await getCappedSkippedMessageIds(channel.id, config.maxSkipAttempts);
  if (cappedIds.size > 0) {
    const beforeCap = archiveSets.length;
    archiveSets = archiveSets.filter(
      (set) => !cappedIds.has(set.parts[0].id)
    );
    const cappedSkipped = beforeCap - archiveSets.length;
    if (cappedSkipped > 0) {
      accountLog.warn(
        { cappedSkipped, cap: config.maxSkipAttempts, remaining: archiveSets.length },
        "Skipping archive sets that hit the auto-retry attempt cap — watermark will advance past them"
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

  // Track the highest message ID that was successfully processed and the
  // lowest message ID of any failed set. The caller uses minFailedId to cap
  // the watermark so failures get retried on the next cycle.
  let maxProcessedId: bigint | null = null;
  let minFailedId: bigint | null = null;
  const indexedPackageRefs: IndexedPackageRef[] = [];

  for (let setIdx = 0; setIdx < archiveSets.length; setIdx++) {
    // Cooperative cancellation: if the caller signals stop (e.g. the topic was
    // disabled mid-run), skip the remaining archive sets in this scan. The set
    // processed in the previous iteration has already completed.
    if (shouldStop && (await shouldStop())) {
      accountLog.info(
        { channel: channelTitle, processed: setIdx, total: archiveSets.length },
        "Stop signal received (topic disabled) — skipping remaining archive sets in this scan"
      );
      break;
    }
    try {
      const packageId = await processOneArchiveSet(
        ctx,
        archiveSets[setIdx],
        setIdx,
        archiveSets.length,
        previewMatches,
        ingestionRunId
      );

      if (packageId) {
        const firstPart = archiveSets[setIdx].parts[0];
        indexedPackageRefs.push({
          packageId,
          sourceMessageId: firstPart.id,
          mediaAlbumId: firstPart.mediaAlbumId,
        });
      }

      // Set completed (ingested or confirmed duplicate) — advance watermark
      const setMaxId = archiveSets[setIdx].parts.reduce(
        (max, p) => (p.id > max ? p.id : max),
        0n
      );
      if (setMaxId > (maxProcessedId ?? 0n)) {
        maxProcessedId = setMaxId;
      }

      // Persist watermark immediately so a worker restart or cycle timeout
      // doesn't throw away progress. We only advance below minFailedId so a
      // later-encountered failure (out of order, e.g., multipart spanning)
      // doesn't get buried by an earlier success in this scan. In practice
      // sets are processed oldest-first, so setMaxId rarely exceeds
      // minFailedId, but the cap keeps the invariant if it ever does.
      if (onWatermarkAdvance) {
        const safeWatermark =
          minFailedId !== null && setMaxId >= minFailedId
            ? minFailedId - 1n
            : setMaxId;
        if (safeWatermark > 0n) {
          await onWatermarkAdvance(safeWatermark).catch((err) => {
            accountLog.warn(
              { err, setMaxId: setMaxId.toString() },
              "Failed to persist incremental watermark (will retry at end of scan)"
            );
          });
        }
      }

      // Reset stall counter on any successful upload
      ctx.consecutiveStalls = 0;
    } catch (setErr) {
      // If a set fails, do NOT advance the watermark past it
      accountLog.warn(
        { err: setErr, baseName: archiveSets[setIdx].baseName },
        "Archive set failed, watermark will not advance past this set"
      );

      // Record the lowest part ID of this set as a failure boundary so the
      // caller can cap the watermark below it and the next scan re-picks it up.
      const setMinId = archiveSets[setIdx].parts.reduce(
        (min, p) => (p.id < min ? p.id : min),
        archiveSets[setIdx].parts[0].id
      );
      if (minFailedId === null || setMinId < minFailedId) {
        minFailedId = setMinId;
      }

      // ── TDLib client recreation on repeated upload stalls ──
      // When the TDLib event stream degrades, uploads complete (bytes sent)
      // but confirmations never arrive. Retrying with the same broken client
      // is futile. Recreate the client to get a fresh connection.
      if (setErr instanceof UploadStallError) {
        ctx.consecutiveStalls++;
        accountLog.warn(
          { consecutiveStalls: ctx.consecutiveStalls },
          "Upload stall detected — TDLib event stream may be degraded"
        );

        // After 1 stalled set (= 3 failed retry attempts already), recreate the client
        if (ctx.consecutiveStalls >= 1) {
          accountLog.info("Recreating TDLib client after consecutive upload stalls");
          try {
            await closeTdlibClient(ctx.client);
          } catch (closeErr) {
            accountLog.warn({ err: closeErr }, "Error closing stale TDLib client");
          }

          try {
            const { client: newClient } = await createTdlibClient({
              id: ctx.accountId,
              phone: ctx.accountPhone,
            });
            ctx.client = newClient;

            // Reload chats so the new client can access channels
            try {
              for (let page = 0; page < 500; page++) {
                await newClient.invoke({
                  _: "loadChats",
                  chat_list: { _: "chatListMain" },
                  limit: 100,
                });
              }
            } catch {
              // 404 = all loaded (expected)
            }

            ctx.consecutiveStalls = 0;
            accountLog.info("TDLib client recreated successfully — continuing ingestion");
          } catch (recreateErr) {
            accountLog.error(
              { err: recreateErr },
              "Failed to recreate TDLib client — aborting remaining uploads"
            );
            break;
          }
        }
      }

      // Record the failure for visibility in the UI
      try {
        const archiveSet = archiveSets[setIdx];
        const totalSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);
        const rawErrMsg = setErr instanceof Error ? setErr.message : String(setErr);
        // Prefix with [<phone>] so the SkippedPackage / notification UI shows
        // which account hit the error — important when two accounts share a
        // source channel and only one is failing.
        const errMsg = `[${ctx.accountPhone}] ${rawErrMsg}`;
        await upsertSkippedPackage({
          fileName: archiveSet.parts[0].fileName,
          fileSize: totalSize,
          reason: inferSkipReason(rawErrMsg),
          errorMessage: errMsg,
          sourceChannelId: ctx.channel.id,
          sourceMessageId: archiveSet.parts[0].id,
          sourceTopicId: ctx.sourceTopicId,
          isMultipart: archiveSet.isMultipart,
          partCount: archiveSet.parts.length,
          accountId: ctx.accountId,
        });
        // Also create a persistent notification
        await db.systemNotification.create({
          data: {
            type: inferSkipReason(rawErrMsg) === "UPLOAD_FAILED" ? "UPLOAD_FAILED" : "DOWNLOAD_FAILED",
            severity: "WARNING",
            title: `Failed to process ${archiveSet.parts[0].fileName}`,
            message: errMsg,
            context: {
              fileName: archiveSet.parts[0].fileName,
              sourceChannelId: ctx.channel.id,
              sourceMessageId: Number(archiveSet.parts[0].id),
              channelTitle: ctx.channelTitle,
              accountPhone: ctx.accountPhone,
              reason: inferSkipReason(rawErrMsg),
            },
          },
        });
      } catch {
        // Best-effort — don't fail the run if skip recording fails
      }
    }
  }

  // Post-processing: group packages by Telegram album ID
  if (indexedPackageRefs.length > 0) {
    await processAlbumGroups(
      ctx.client,
      channel.id,
      indexedPackageRefs,
      scanResult.photos
    );

    // Heuristic auto-grouping passes (rule/time/pattern/creator/zip-path/
    // reply-chain/caption) were removed: the STL view is now a flat list
    // organized by the creator filter, so automatically inventing groups at
    // ingestion is no longer wanted. Album grouping above is kept because it
    // reflects real upload structure (files posted together as one Telegram
    // album), not a heuristic guess. Existing groups and the manual grouping
    // actions in the UI are unaffected.

    // Check for potential grouping conflicts
    await detectGroupingConflicts(channel.id, indexedPackageRefs);
  }

  return { maxProcessedId, minFailedId };
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
): Promise<string | null> {
  const {
    client, runId, channelTitle, channel,
    destChannelTelegramId, destChannelId,
    throttled, counters, topicCreator, sourceTopicId, accountLog,
  } = ctx;

  const archiveName = archiveSet.parts[0].fileName;

  // ── Earliest skip: remote.unique_id match ──
  // TDLib reports a stable unique_id per file content. If we already have a
  // Package in this channel with the same unique_id, it's the exact same
  // file content reposted at a new message ID — zero false positives.
  const firstRemoteUniqueId = archiveSet.parts[0].remoteUniqueId;
  if (firstRemoteUniqueId) {
    const match = await findPackageByRemoteUniqueId(channel.id, firstRemoteUniqueId);
    if (match) {
      counters.zipsDuplicate++;
      accountLog.info(
        {
          fileName: archiveSet.parts[0].fileName,
          sourceMessageId: Number(archiveSet.parts[0].id),
          remoteUniqueId: firstRemoteUniqueId,
          existingPackageId: match.id,
          existingDestMessageId: match.destMessageId ? Number(match.destMessageId) : null,
        },
        "Skipping — remote.unique_id matches an existing Package in this channel"
      );
      await updateRunActivity(runId, {
        currentActivity: `Skipped ${archiveSet.parts[0].fileName} (already ingested by unique_id)`,
        currentStep: "deduplicating",
        currentChannel: channelTitle,
        currentFile: archiveSet.parts[0].fileName,
        currentFileNum: setIdx + 1,
        totalFiles: totalSets,
        zipsDuplicate: counters.zipsDuplicate,
      });
      return null;
    }
  }

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
    return null;
  }

  // Compute the total size across all parts (used by the repost check below
  // AND by the size guard further down).
  const totalArchiveSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);

  // ── Pre-download repost detection ──
  // The source channel admin frequently reposts the same file at new message
  // IDs. packageExistsBySourceMessage misses these (different msgId), so we
  // historically downloaded the file just to discover via hash that it's a
  // duplicate — wasting hours of bandwidth per run.
  //
  // Match by (sourceChannelId, fileName, totalSize). The totalSize comparison
  // makes this very strong — name-and-size collision between unrelated files
  // is rare in practice. If it ever happens, the new file is treated as a
  // duplicate; the user can remove the existing Package via the UI to force
  // a re-ingestion.
  const reposted = await findRepostedPackage(
    channel.id,
    archiveName,
    totalArchiveSize
  );
  if (reposted) {
    counters.zipsDuplicate++;

    // Backfill topic context onto the existing Package when we encounter the
    // same file in a more specific topic. If the existing Package was created
    // from "General" or a non-forum scan and we now see the file in a named
    // topic (e.g., "Artisan Guild January 2022"), update the Package so the
    // user gets richer metadata. We only update when the current scan is in
    // a specific topic AND the existing topic differs.
    const currentTopicName = ctx.topicCreator; // == topic.name for forum scans
    const currentTopicId = ctx.sourceTopicId;
    const isCurrentSpecific = currentTopicName !== null && currentTopicName !== "General";
    const existingTopicDiffers = reposted.sourceTopicId !== currentTopicId;
    if (isCurrentSpecific && currentTopicId !== null && existingTopicDiffers) {
      try {
        await updatePackageTopicContext(reposted.id, currentTopicId, currentTopicName);
        accountLog.info(
          {
            fileName: archiveName,
            packageId: reposted.id,
            existingTopicId: reposted.sourceTopicId ? Number(reposted.sourceTopicId) : null,
            newTopicId: Number(currentTopicId),
            newTopicName: currentTopicName,
          },
          "Updated existing Package with more specific topic context"
        );
      } catch (updErr) {
        accountLog.warn({ err: updErr, packageId: reposted.id }, "Failed to update Package topic context (non-fatal)");
      }
    }

    accountLog.info(
      {
        fileName: archiveName,
        sourceMessageId: Number(archiveSet.parts[0].id),
        existingPackageId: reposted.id,
        existingDestMessageId: reposted.destMessageId ? Number(reposted.destMessageId) : null,
        existingTopicId: reposted.sourceTopicId ? Number(reposted.sourceTopicId) : null,
        currentTopicId: currentTopicId ? Number(currentTopicId) : null,
        currentTopicName,
        totalSize: Number(totalArchiveSize),
      },
      "Skipping repost — same fileName + size already uploaded in this channel"
    );
    await updateRunActivity(runId, {
      currentActivity: `Skipped ${archiveName} (repost of already-uploaded file)`,
      currentStep: "deduplicating",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
      zipsDuplicate: counters.zipsDuplicate,
    });
    return null;
  }

  // ── Cross-channel provenance backfill ──
  // The same-channel checks above missed. Before downloading, see if this
  // archive is the true origin of a placeholder-source package (manual upload
  // / rebuild record whose sourceChannelId == destChannelId). If so, backfill
  // its real provenance and skip the download entirely.
  const archType = archiveSet.type === "7Z" ? "SEVEN_Z" : archiveSet.type;
  if (destChannelId && (archType === "ZIP" || archType === "RAR" || archType === "SEVEN_Z")) {
    try {
      const derivedCreator =
        topicCreator && topicCreator !== "General"
          ? topicCreator
          : (extractCreatorFromFileName(archiveName) ?? topicCreator ?? null);
      const preview = previewMatches.get(archiveSet.baseName);
      const result = await tryProvenanceBackfill({
        client,
        destChannelId,
        scannedSourceChannelId: channel.id,
        fileName: archiveName,
        fileSize: totalArchiveSize,
        archiveType: archType,
        sourceMessageId: archiveSet.parts[0].id,
        sourceTopicId,
        sourceCaption: archiveSet.parts[0].caption ?? null,
        remoteUniqueId: archiveSet.parts[0].remoteUniqueId ?? null,
        creator: derivedCreator,
        scannedParts: archiveSet.parts.map((p) => ({ fileId: p.fileId, fileSize: p.fileSize, fileName: p.fileName })),
        previewData: null,
        previewMsgId: preview?.id ?? null,
      });
      if (result.backfilled) {
        counters.zipsBackfilled++;
        accountLog.info(
          { fileName: archiveName, sourceMessageId: Number(archiveSet.parts[0].id), confidence: result.confidence },
          "Backfilled provenance for placeholder package — skipping download",
        );
        await updateRunActivity(runId, {
          currentActivity: `Backfilled provenance for ${archiveName}`,
          currentStep: "backfilling",
          currentFile: archiveName,
          currentFileNum: setIdx + 1,
          totalFiles: totalSets,
          zipsBackfilled: counters.zipsBackfilled,
        });
        return null;
      }
    } catch (err) {
      accountLog.warn({ err, fileName: archiveName }, "Provenance backfill attempt failed (non-fatal), continuing to normal ingestion");
    }
  }

  // ── Size guard: skip archives that exceed WORKER_MAX_ZIP_SIZE_MB ──
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
    await upsertSkippedPackage({
      fileName: archiveName,
      fileSize: totalArchiveSize,
      reason: "SIZE_LIMIT",
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId: ctx.sourceTopicId,
      isMultipart: archiveSet.isMultipart,
      partCount: archiveSet.parts.length,
      accountId: ctx.accountId,
    });
    return null;
  }

  // ── Forward-priority path ──
  // If the source channel allows forwarding, try to index + forward without a
  // local download. Any failure (ranged listing miss, blocked/failed forward)
  // falls through into the existing download pipeline below so indexing
  // completeness never regresses.
  if (channel.allowsForwarding === true) {
    try {
      const forwardResult = await tryForwardArchiveSet(
        ctx, archiveSet, setIdx, totalSets, previewMatches, ingestionRunId
      );
      if (forwardResult !== undefined) {
        return forwardResult;
      }
      accountLog.info(
        { fileName: archiveName },
        "Forward path unavailable for this archive — falling back to download+reupload"
      );
    } catch (forwardPathErr) {
      accountLog.warn(
        { err: forwardPathErr, fileName: archiveName },
        "Forward path threw unexpectedly — falling back to download+reupload"
      );
    }
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
      return null;
    }

    // ── Hash lock: prevent concurrent workers racing on shared-channel archives ──
    const hashLockAcquired = await tryAcquireHashLock(contentHash);
    if (!hashLockAcquired) {
      counters.zipsDuplicate++;
      accountLog.info(
        { fileName: archiveName, hash: contentHash.slice(0, 16) },
        "Hash lock held by another worker — skipping concurrent duplicate"
      );
      return null;
    }

    let entries: { path: string; fileName: string; extension: string | null; compressedSize: bigint; uncompressedSize: bigint; crc32: string | null }[] = [];
    let creator: string | null = null;
    const tags: string[] = [];
    let stub: { id: string } | null = null;

    try {
    // Re-check after acquiring lock: another worker may have finished between
    // the first check above and this point.
    const existsAfterLock = await packageExistsByHash(contentHash);
    if (existsAfterLock) {
      counters.zipsDuplicate++;
      accountLog.debug(
        { fileName: archiveName, hash: contentHash.slice(0, 16) },
        "Duplicate detected after acquiring hash lock — skipping"
      );
      return null;
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
    const MAX_UPLOAD_SIZE = ctx.maxUploadSize;
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
      splitPaths = await byteLevelSplit(concatPath, ctx.maxUploadSize);
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
      splitPaths = await byteLevelSplit(tempPaths[0], ctx.maxUploadSize);
      uploadPaths = splitPaths;
    }

    // ── Hash verification after split ──
    // If we split/repacked, verify the split parts hash matches the original
    if (splitPaths.length > 0) {
      const splitHash = await hashParts(splitPaths);
      if (splitHash !== contentHash) {
        accountLog.error(
          { fileName: archiveName, originalHash: contentHash, splitHash, parts: splitPaths.length },
          "Hash mismatch after split — file may be corrupted"
        );
        // Record notification for visibility
        try {
          await db.systemNotification.create({
            data: {
              type: "HASH_MISMATCH",
              severity: "ERROR",
              title: `Hash mismatch after splitting ${archiveName}`,
              message: `Expected ${contentHash.slice(0, 16)}… but got ${splitHash.slice(0, 16)}… after splitting into ${splitPaths.length} parts`,
              context: {
                fileName: archiveName,
                originalHash: contentHash,
                splitHash,
                partCount: splitPaths.length,
                sourceChannelId: channel.id,
              },
            },
          });
        } catch {
          // Best-effort notification
        }
        throw new Error(`Hash mismatch after split for ${archiveName}: expected ${contentHash}, got ${splitHash}`);
      }
      accountLog.debug(
        { fileName: archiveName, hash: contentHash.slice(0, 16), parts: splitPaths.length },
        "Split hash verified — matches original"
      );
    }

      // ── Pre-upload integrity test (advisory) ──
      // Run unzip -t / unrar t / 7z t to look for corruption or encryption
      // before we upload. This is ADVISORY only — failures get logged and
      // emit a SystemNotification but never block upload, because:
      //
      //  1. Multipart ZIPs (`.zip.001`, `.zip.002`, ...) aren't testable
      //     chunk-by-chunk. Skip them entirely.
      //  2. Large 7z archives can OOM-kill `7z t` (exit 137) during
      //     decompression on memory-limited containers — that's a tool
      //     limitation, not actual corruption.
      //  3. p7zip can fail with unhelpful messages on newer 7z features.
      //
      // Hash verification + archive metadata parse already cover byte-level
      // corruption and structural readability. The integrity test is a
      // nice-to-have stronger signal; not worth losing uploads over false
      // positives.
      const archType = archiveSet.type === "7Z" ? "SEVEN_Z" : archiveSet.type;
      const isMultipartZip = archType === "ZIP" && tempPaths.length > 1;
      if (!isMultipartZip) {
        const integrity = await testArchiveIntegrity(archType, tempPaths[0]);
        if (!integrity.ok) {
          if (integrity.kind === "inconclusive") {
            // The test tool was killed (OOM) or timed out — typically a large
            // 7z in a memory-limited container. This is a tool limitation, NOT
            // corruption, so log quietly and DON'T raise a notification. The
            // upload proceeds exactly as before.
            accountLog.debug(
              { fileName: archiveName, reason: integrity.reason.slice(0, 200) },
              "Archive integrity test inconclusive — proceeding with upload (advisory check)"
            );
          } else {
            // Encrypted (won't extract for users) or genuinely corrupt — surface
            // clearly via notification but STILL proceed: the user can audit and
            // decide what to do.
            const isEncrypted = integrity.kind === "encrypted";
            accountLog.warn(
              { fileName: archiveName, reason: integrity.reason.slice(0, 200), kind: integrity.kind },
              "Archive integrity test failed — proceeding with upload anyway (advisory check)"
            );
            try {
              await db.systemNotification.create({
                data: {
                  type: isEncrypted ? "UPLOAD_FAILED" : "INTEGRITY_AUDIT",
                  severity: "WARNING",
                  title: isEncrypted
                    ? `Archive may be encrypted: ${archiveName}`
                    : `Integrity test reported issues: ${archiveName}`,
                  message: integrity.reason.slice(0, 1000),
                  context: {
                    fileName: archiveName,
                    sourceChannelId: channel.id,
                    sourceMessageId: Number(archiveSet.parts[0].id),
                    archiveType: archType,
                    advisory: true,
                  },
                },
              });
            } catch {
              // Best-effort notification
            }
          }
        }
      }

      // ── Uploading ──
      // Check if a prior run already uploaded this file (orphaned upload scenario:
      // file reached Telegram but DB write failed or worker crashed before indexing)
      const existingUpload = await getUploadedPackageByHash(contentHash);
      let destResult: { messageId: bigint; messageIds: bigint[] };

      if (existingUpload && existingUpload.destMessageId) {
        accountLog.info(
          { fileName: archiveName, destMessageId: Number(existingUpload.destMessageId) },
          "Reusing existing upload (file already on destination channel)"
        );
        destResult = {
          messageId: existingUpload.destMessageId,
          messageIds: existingUpload.destMessageIds?.length
            ? (existingUpload.destMessageIds as bigint[])
            : [existingUpload.destMessageId],
        };
      } else {
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

        destResult = await uploadToChannel(
          client,
          destChannelTelegramId,
          uploadPaths
        );
      }

      // ── Post-upload integrity check ──
      // Verify the files on disk still match before we index
      if (uploadPaths.length > 0 && !existingUpload) {
        try {
          const postUploadHash = await hashParts(uploadPaths);
          if (splitPaths.length > 0) {
            // Split files — hash should match the split hash (already verified above)
            // No additional check needed since we verified split hash = original hash
          } else if (postUploadHash !== contentHash) {
            accountLog.error(
              { fileName: archiveName, originalHash: contentHash, postUploadHash },
              "Hash changed between hashing and upload — possible disk corruption"
            );
            await db.systemNotification.create({
              data: {
                type: "HASH_MISMATCH",
                severity: "ERROR",
                title: `Post-upload hash mismatch: ${archiveName}`,
                message: `Hash changed between download and upload. Original: ${contentHash.slice(0, 16)}…, post-upload: ${postUploadHash.slice(0, 16)}…`,
                context: { fileName: archiveName, originalHash: contentHash, postUploadHash, sourceChannelId: channel.id },
              },
            });
          }
        } catch {
          // Best-effort — don't fail the ingestion
        }
      }

      // ── Destination read-back verification ──
      // Telegram's updateMessageSendSucceeded fires when TG acknowledges the
      // message, but that's separate from "the message is queryable and
      // contains the file we sent". Fetch each destination message and
      // confirm the document's size matches what we uploaded.
      //
      // Skipped when reusing an existing upload (we never sent anything).
      // Failures here surface as a SystemNotification but DO NOT abort the
      // ingestion — the Package will be created with whatever destMessageIds
      // Telegram returned, and a future recovery run can reset it if needed.
      if (!existingUpload && destResult.messageIds.length > 0) {
        try {
          const expectedSizes = uploadPaths.length === destResult.messageIds.length
            ? await Promise.all(
                uploadPaths.map(async (p) => (await import("fs/promises")).stat(p).then((s) => s.size))
              )
            : null;

          for (let i = 0; i < destResult.messageIds.length; i++) {
            const msgId = Number(destResult.messageIds[i]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tdMsg = (await client.invoke({
              _: "getMessage",
              chat_id: Number(destChannelTelegramId),
              message_id: msgId,
            }).catch(() => null)) as any;

            const doc = tdMsg?.content?.document?.document;
            const actualSize = doc?.size;
            const expected = expectedSizes?.[i];

            if (!actualSize) {
              accountLog.warn(
                { fileName: archiveName, destMessageId: msgId },
                "Post-upload read-back: destination message has no document content"
              );
              await db.systemNotification.create({
                data: {
                  type: "UPLOAD_FAILED",
                  severity: "WARNING",
                  title: `Read-back failed: ${archiveName}`,
                  message: `Destination message ${msgId} has no document content after upload. The upload may have failed silently.`,
                  context: { fileName: archiveName, destMessageId: msgId, sourceChannelId: channel.id },
                },
              });
            } else if (expected !== undefined && actualSize !== expected) {
              accountLog.error(
                { fileName: archiveName, destMessageId: msgId, expectedSize: expected, actualSize },
                "Post-upload read-back: destination file size mismatch"
              );
              await db.systemNotification.create({
                data: {
                  type: "HASH_MISMATCH",
                  severity: "ERROR",
                  title: `Read-back size mismatch: ${archiveName}`,
                  message: `Sent ${expected} bytes but destination message ${msgId} contains a ${actualSize}-byte file.`,
                  context: { fileName: archiveName, destMessageId: msgId, expectedSize: expected, actualSize, sourceChannelId: channel.id },
                },
              });
            }
          }
        } catch (readBackErr) {
          accountLog.warn({ err: readBackErr, fileName: archiveName }, "Post-upload read-back failed (non-fatal)");
        }
      }

      // ── Phase 1: Stub record — persisted immediately after upload ──
      await deleteOrphanedPackageByHash(contentHash);

      creator =
        topicCreator ??
        extractCreatorFromFileName(archiveName) ??
        extractCreatorFromChannelTitle(channelTitle) ??
        null;

      if (channel.category) {
        tags.push(channel.category);
      }

      // Derive slicer tags from the file listing so users can filter the
      // catalog by "what software opens these files". Tags include "lychee",
      // "chitubox", "anycubic", "bambu", "fdm" etc. — only added if matching
      // slicer-specific files are present in the archive.
      const slicerTags = extractSlicerTags(entries);
      for (const tag of slicerTags) {
        if (!tags.includes(tag)) tags.push(tag);
      }

      stub = await createPackageStub({
        contentHash,
        fileName: archiveName,
        fileSize: totalSize,
        archiveType: archiveSet.type === "7Z" ? "SEVEN_Z" : archiveSet.type,
        sourceChannelId: channel.id,
        sourceMessageId: archiveSet.parts[0].id,
        sourceTopicId,
        remoteUniqueId: archiveSet.parts[0].remoteUniqueId ?? null,
        destChannelId,
        destMessageId: destResult.messageId,
        destMessageIds: destResult.messageIds,
        isMultipart: archiveSet.parts.length > 1 || uploadPaths.length > 1,
        partCount: uploadPaths.length,
        ingestionRunId,
        creator,
        tags,
      });

      counters.zipsIngested++;
      await deleteSkippedPackage(channel.id, archiveSet.parts[0].id);
    } finally {
      await releaseHashLock(contentHash);
    }

    if (!stub) return null;

    // ── Preview thumbnail ──
    // (moved here from before stub creation — lock is released, preview doesn't need it)
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

    // ── Phase 2: Update stub with file entries and preview ──
    await updateRunActivity(runId, {
      currentActivity: `Saving metadata for ${archiveName} (${entries.length} files)`,
      currentStep: "indexing",
      currentChannel: channelTitle,
      currentFile: archiveName,
      currentFileNum: setIdx + 1,
      totalFiles: totalSets,
    });

    await updatePackageWithMetadata(stub.id, {
      files: entries,
      previewData,
      previewMsgId,
    });

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

    return stub.id;
  } finally {
    // ALWAYS delete temp files and the set directory
    await deleteFiles([...tempPaths, ...splitPaths]);
    await rm(setDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Attempt the forward-priority path for one archive set: ranged listing (no
 * download) + native Telegram forward to the destination channel.
 *
 * Returns `undefined` when the forward path isn't usable for this specific
 * archive (ranged listing failed, or the forward itself failed) — the caller
 * falls through to the existing download+reupload pipeline in that case, so
 * indexing completeness never regresses.
 *
 * Returns `null` when the archive is a confirmed duplicate (skip, same
 * contract as the pre-download dedup checks earlier in the caller).
 *
 * Returns the new Package id on success.
 */
async function tryForwardArchiveSet(
  ctx: PipelineContext,
  archiveSet: ArchiveSet,
  setIdx: number,
  totalSets: number,
  previewMatches: Map<string, { id: bigint; fileId: string }>,
  ingestionRunId: string,
): Promise<string | null | undefined> {
  const {
    client, channelTitle, channel,
    destChannelTelegramId, destChannelId,
    counters, topicCreator, sourceTopicId, accountLog,
  } = ctx;
  void setIdx;
  void totalSets;

  const archiveName = archiveSet.parts[0].fileName;
  const archType = archiveSet.type === "7Z" ? ("SEVEN_Z" as const) : archiveSet.type;
  if (archType !== "ZIP" && archType !== "RAR" && archType !== "SEVEN_Z") {
    // The ranged listing readers only cover archive formats. Standalone
    // DOCUMENT attachments always go through the existing download path,
    // which for DOCUMENT is already cheap (no extraction, single entry).
    return undefined;
  }

  const scannedParts = archiveSet.parts.map((p) => ({
    fileId: p.fileId,
    fileSize: p.fileSize,
    fileName: p.fileName,
  }));

  const entries = await readScannedListingRanged(archType, client, scannedParts);
  if (!entries) return undefined;

  const totalArchiveSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);
  const firstRemoteUniqueId = archiveSet.parts[0].remoteUniqueId ?? null;
  const contentHash = deriveForwardContentHash(
    entries,
    firstRemoteUniqueId,
    channel.id,
    archiveSet.parts[0].id,
  );

  if (await packageExistsByHash(contentHash)) {
    counters.zipsDuplicate++;
    accountLog.debug({ fileName: archiveName, contentHash }, "Forward-path duplicate (hash), skipping");
    return null;
  }

  const repost = await checkFingerprintRepost(client, entries, archiveName, totalArchiveSize);
  if (repost.isDuplicate) {
    counters.zipsDuplicate++;
    accountLog.info(
      { fileName: archiveName, matchedPackageId: repost.matchedPackageId },
      "Forward-path duplicate (CRC fingerprint match against another channel's copy), skipping"
    );
    return null;
  }

  const hashLockAcquired = await tryAcquireHashLock(contentHash);
  if (!hashLockAcquired) {
    counters.zipsDuplicate++;
    accountLog.info(
      { fileName: archiveName, contentHash },
      "Hash lock held by another worker — skipping concurrent duplicate"
    );
    return null;
  }

  try {
    if (await packageExistsByHash(contentHash)) {
      counters.zipsDuplicate++;
      return null;
    }

    let destResult: { messageId: bigint; messageIds: bigint[] };
    try {
      destResult = await forwardArchiveToChannel(
        client,
        channel.telegramId,
        destChannelTelegramId,
        archiveSet.parts.map((p) => p.id),
      );
    } catch (forwardErr) {
      accountLog.warn(
        { err: forwardErr, fileName: archiveName },
        "Forward failed — falling back to download+reupload for this archive"
      );
      return undefined;
    }

    await deleteOrphanedPackageByHash(contentHash);

    const creator =
      topicCreator ??
      extractCreatorFromFileName(archiveName) ??
      extractCreatorFromChannelTitle(channelTitle) ??
      null;

    const tags: string[] = [];
    if (channel.category) tags.push(channel.category);
    for (const tag of extractSlicerTags(entries)) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    const stub = await createPackageStub({
      contentHash,
      fileName: archiveName,
      fileSize: totalArchiveSize,
      archiveType: archType,
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId,
      remoteUniqueId: firstRemoteUniqueId,
      destChannelId,
      destMessageId: destResult.messageId,
      destMessageIds: destResult.messageIds,
      isMultipart: archiveSet.parts.length > 1,
      partCount: archiveSet.parts.length,
      ingestionRunId,
      creator,
      tags,
    });

    counters.zipsForwarded++;
    await deleteSkippedPackage(channel.id, archiveSet.parts[0].id);

    let previewData: Buffer | null = null;
    let previewMsgId: bigint | null = null;
    const matchedPhoto = previewMatches.get(archiveSet.baseName);
    if (matchedPhoto) {
      previewData = await downloadPhotoThumbnail(client, matchedPhoto.fileId);
      if (previewData) previewMsgId = matchedPhoto.id;
    }

    await updatePackageWithMetadata(stub.id, { files: entries, previewData, previewMsgId });

    accountLog.info(
      { fileName: archiveName, contentHash, fileCount: entries.length, creator },
      "Archive forwarded (no download)"
    );

    return stub.id;
  } finally {
    await releaseHashLock(contentHash);
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
