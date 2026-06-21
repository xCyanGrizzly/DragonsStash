import { db } from "./client.js";
import type { ArchiveType, FetchStatus } from "@prisma/client";

export async function getActiveAccounts() {
  return db.telegramAccount.findMany({
    where: { isActive: true, authState: "AUTHENTICATED" },
  });
}

export async function getPendingAccounts() {
  return db.telegramAccount.findMany({
    where: { isActive: true, authState: "PENDING" },
  });
}

export async function hasAnyChannels(): Promise<boolean> {
  const count = await db.telegramChannel.count();
  return count > 0;
}

export async function getSourceChannelMappings(accountId: string) {
  return db.accountChannelMap.findMany({
    where: {
      accountId,
      role: "READER",
      channel: { type: "SOURCE", isActive: true },
    },
    include: { channel: true },
  });
}

// ── Global destination channel ──

export async function getGlobalDestinationChannel() {
  const setting = await db.globalSetting.findUnique({
    where: { key: "destination_channel_id" },
  });
  if (!setting) return null;
  return db.telegramChannel.findFirst({
    where: { id: setting.value, type: "DESTINATION", isActive: true },
  });
}

export async function getGlobalSetting(key: string): Promise<string | null> {
  const setting = await db.globalSetting.findUnique({ where: { key } });
  return setting?.value ?? null;
}

export async function setGlobalSetting(key: string, value: string) {
  return db.globalSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function packageExistsByHash(contentHash: string) {
  const pkg = await db.package.findFirst({
    where: { contentHash, destMessageId: { not: null } },
    select: { id: true },
  });
  return pkg !== null;
}

/**
 * Find an already-uploaded package by content hash.
 * Used to detect orphaned uploads — files that reached Telegram
 * but whose package record was created from a previous successful run.
 */
export async function getUploadedPackageByHash(contentHash: string) {
  return db.package.findFirst({
    where: { contentHash, destMessageId: { not: null }, destChannelId: { not: null } },
    select: { destChannelId: true, destMessageId: true, destMessageIds: true },
  });
}

export interface CreatePackageStubInput {
  contentHash: string;
  fileName: string;
  fileSize: bigint;
  archiveType: ArchiveType;
  sourceChannelId: string;
  sourceMessageId: bigint;
  sourceTopicId?: bigint | null;
  /** TDLib remote.unique_id of the first part — for future dedup. */
  remoteUniqueId?: string | null;
  destChannelId: string;
  destMessageId: bigint;
  destMessageIds: bigint[];
  isMultipart: boolean;
  partCount: number;
  ingestionRunId: string;
  creator?: string | null;
  tags?: string[];
}

/**
 * Write a minimal Package record immediately after Telegram confirms the upload.
 * Call this before preview/metadata extraction so recoverIncompleteUploads() can
 * detect and verify the package if the worker crashes mid-metadata.
 *
 * Follow with updatePackageWithMetadata() once file entries and preview are ready.
 */
export async function createPackageStub(
  input: CreatePackageStubInput
): Promise<{ id: string }> {
  const pkg = await db.package.create({
    data: {
      contentHash: input.contentHash,
      fileName: input.fileName,
      fileSize: input.fileSize,
      archiveType: input.archiveType,
      sourceChannelId: input.sourceChannelId,
      sourceMessageId: input.sourceMessageId,
      sourceTopicId: input.sourceTopicId ?? undefined,
      remoteUniqueId: input.remoteUniqueId ?? undefined,
      destChannelId: input.destChannelId,
      destMessageId: input.destMessageId,
      destMessageIds: input.destMessageIds,
      isMultipart: input.isMultipart,
      partCount: input.partCount,
      fileCount: 0,
      ingestionRunId: input.ingestionRunId,
      creator: input.creator ?? undefined,
      tags: input.tags?.length ? input.tags : undefined,
    },
    select: { id: true },
  });

  try {
    await db.$queryRawUnsafe(
      `SELECT pg_notify('new_package', $1)`,
      JSON.stringify({
        packageId: pkg.id,
        fileName: input.fileName,
        creator: input.creator ?? null,
        tags: input.tags ?? [],
      })
    );
  } catch {
    // Best-effort
  }

  return pkg;
}

/**
 * Update a stub Package with file entries and preview after metadata extraction.
 * Called as Phase 2 of the two-phase write after createPackageStub().
 */
export async function updatePackageWithMetadata(
  packageId: string,
  input: {
    files: {
      path: string;
      fileName: string;
      extension: string | null;
      compressedSize: bigint;
      uncompressedSize: bigint;
      crc32: string | null;
    }[];
    previewData?: Buffer | null;
    previewMsgId?: bigint | null;
  }
): Promise<void> {
  await db.package.update({
    where: { id: packageId },
    data: {
      fileCount: input.files.length,
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      previewMsgId: input.previewMsgId ?? undefined,
      files: {
        create: input.files,
      },
    },
  });
}

/**
 * Check if a package already exists for a given source message ID
 * AND was successfully uploaded to the destination (destMessageId is set).
 * Used as an early skip before downloading.
 */
export async function packageExistsBySourceMessage(
  sourceChannelId: string,
  sourceMessageId: bigint
): Promise<boolean> {
  const pkg = await db.package.findFirst({
    where: { sourceChannelId, sourceMessageId, destMessageId: { not: null } },
    select: { id: true },
  });
  return pkg !== null;
}

/**
 * Strongest pre-download dedup signal: a Package in this channel already
 * has a matching TDLib remote.unique_id. The unique_id is stable across
 * reposts of the exact same file content, so a hit is a guaranteed
 * (lossless) duplicate. No false positives.
 *
 * Falls back to the older findRepostedPackage (name + size) for packages
 * that were ingested before we started capturing remote.unique_id.
 */
export async function findPackageByRemoteUniqueId(
  sourceChannelId: string,
  remoteUniqueId: string
): Promise<{
  id: string;
  destMessageId: bigint | null;
  sourceTopicId: bigint | null;
} | null> {
  return db.package.findFirst({
    where: {
      sourceChannelId,
      remoteUniqueId,
      destMessageId: { not: null },
    },
    orderBy: { sourceTopicId: { sort: "desc", nulls: "last" } },
    select: { id: true, destMessageId: true, sourceTopicId: true },
  });
}

/**
 * Detect a likely repost: same source channel + same fileName + same total
 * fileSize already exists with destMessageId set. Used to skip downloads
 * when the channel admin re-posts the same file under a new message ID
 * (which `packageExistsBySourceMessage` cannot catch because the message ID
 * is different).
 *
 * Returns the existing package's destMessageId for logging/observability,
 * or null if no match. Approximate: same name + same total size is an
 * extremely strong signal that it's the same content, but theoretically
 * two unrelated files could collide. If that ever happens, the new file
 * gets treated as a duplicate and is lost; the user can manually re-link
 * via the UI by removing the existing Package.
 */
export async function findRepostedPackage(
  sourceChannelId: string,
  fileName: string,
  fileSize: bigint
): Promise<{
  id: string;
  destMessageId: bigint | null;
  sourceTopicId: bigint | null;
} | null> {
  return db.package.findFirst({
    where: {
      sourceChannelId,
      fileName,
      fileSize,
      destMessageId: { not: null },
    },
    // Prefer the existing Package with the most specific (non-NULL)
    // sourceTopicId, so when the user is re-scanning and the file already
    // exists in a specific topic, the audit log shows the most informative
    // match. NULLS LAST in DESC order achieves that for any non-null IDs.
    orderBy: { sourceTopicId: { sort: "desc", nulls: "last" } },
    select: { id: true, destMessageId: true, sourceTopicId: true },
  });
}

/**
 * Delete orphaned Package rows that have the same content hash but never
 * completed the upload (destMessageId is null). Called before creating a
 * new complete record to avoid unique constraint violations.
 */
export async function deleteOrphanedPackageByHash(contentHash: string): Promise<void> {
  await db.package.deleteMany({
    where: { contentHash, destMessageId: null },
  });
}

export interface CreatePackageInput {
  contentHash: string;
  fileName: string;
  fileSize: bigint;
  archiveType: ArchiveType;
  sourceChannelId: string;
  sourceMessageId: bigint;
  sourceTopicId?: bigint | null;
  destChannelId?: string;
  destMessageId?: bigint;
  destMessageIds?: bigint[];
  isMultipart: boolean;
  partCount: number;
  ingestionRunId: string;
  creator?: string | null;
  tags?: string[];
  previewData?: Buffer | null;
  previewMsgId?: bigint | null;
  sourceCaption?: string | null;
  replyToMessageId?: bigint | null;
  files: {
    path: string;
    fileName: string;
    extension: string | null;
    compressedSize: bigint;
    uncompressedSize: bigint;
    crc32: string | null;
  }[];
}

export async function createPackageWithFiles(input: CreatePackageInput) {
  const pkg = await db.package.create({
    data: {
      contentHash: input.contentHash,
      fileName: input.fileName,
      fileSize: input.fileSize,
      archiveType: input.archiveType,
      sourceChannelId: input.sourceChannelId,
      sourceMessageId: input.sourceMessageId,
      sourceTopicId: input.sourceTopicId ?? undefined,
      destChannelId: input.destChannelId,
      destMessageId: input.destMessageId,
      destMessageIds: input.destMessageIds ?? (input.destMessageId ? [input.destMessageId] : []),
      isMultipart: input.isMultipart,
      partCount: input.partCount,
      fileCount: input.files.length,
      ingestionRunId: input.ingestionRunId,
      creator: input.creator ?? undefined,
      tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      previewMsgId: input.previewMsgId ?? undefined,
      sourceCaption: input.sourceCaption ?? undefined,
      replyToMessageId: input.replyToMessageId ?? undefined,
      files: {
        create: input.files,
      },
    },
  });

  // Notify the bot service about the new package (for subscription alerts)
  try {
    await db.$queryRawUnsafe(
      `SELECT pg_notify('new_package', $1)`,
      JSON.stringify({
        packageId: pkg.id,
        fileName: input.fileName,
        creator: input.creator ?? null,
        tags: input.tags ?? [],
      })
    );
  } catch {
    // Best-effort — don't fail the ingestion if notification fails
  }

  return pkg;
}

export async function createIngestionRun(accountId: string) {
  return db.ingestionRun.create({
    data: {
      accountId,
      status: "RUNNING",
      currentActivity: "Starting ingestion run",
      currentStep: "initializing",
      lastActivityAt: new Date(),
    },
  });
}

export interface ActivityUpdate {
  currentActivity: string;
  currentStep: string;
  currentChannel?: string | null;
  currentFile?: string | null;
  currentFileNum?: number | null;
  totalFiles?: number | null;
  downloadedBytes?: bigint | null;
  totalBytes?: bigint | null;
  downloadPercent?: number | null;
  messagesScanned?: number;
  zipsFound?: number;
  zipsDuplicate?: number;
  zipsIngested?: number;
}

export async function updateRunActivity(
  runId: string,
  activity: ActivityUpdate
) {
  return db.ingestionRun.update({
    where: { id: runId },
    data: {
      currentActivity: activity.currentActivity,
      currentStep: activity.currentStep,
      currentChannel: activity.currentChannel ?? undefined,
      currentFile: activity.currentFile ?? undefined,
      currentFileNum: activity.currentFileNum ?? undefined,
      totalFiles: activity.totalFiles ?? undefined,
      downloadedBytes: activity.downloadedBytes ?? undefined,
      totalBytes: activity.totalBytes ?? undefined,
      downloadPercent: activity.downloadPercent ?? undefined,
      lastActivityAt: new Date(),
      ...(activity.messagesScanned !== undefined && { messagesScanned: activity.messagesScanned }),
      ...(activity.zipsFound !== undefined && { zipsFound: activity.zipsFound }),
      ...(activity.zipsDuplicate !== undefined && { zipsDuplicate: activity.zipsDuplicate }),
      ...(activity.zipsIngested !== undefined && { zipsIngested: activity.zipsIngested }),
    },
  });
}

const CLEAR_ACTIVITY = {
  currentActivity: null,
  currentStep: null,
  currentChannel: null,
  currentFile: null,
  currentFileNum: null,
  totalFiles: null,
  downloadedBytes: null,
  totalBytes: null,
  downloadPercent: null,
  lastActivityAt: new Date(),
};

export async function completeIngestionRun(
  runId: string,
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
  }
) {
  return db.ingestionRun.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      finishedAt: new Date(),
      ...counters,
      ...CLEAR_ACTIVITY,
    },
  });
}

export async function failIngestionRun(runId: string, errorMessage: string) {
  return db.ingestionRun.update({
    where: { id: runId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage,
      ...CLEAR_ACTIVITY,
    },
  });
}

export async function updateLastProcessedMessage(
  mappingId: string,
  messageId: bigint
) {
  return db.accountChannelMap.update({
    where: { id: mappingId },
    data: { lastProcessedMessageId: messageId },
  });
}

export interface ScanStateUpdate {
  /** New watermark to persist. Use the same value the caller would have
   *  passed to updateLastProcessedMessage / upsertTopicProgress. */
  lastProcessedMessageId: bigint | null;
  /** True if the scan found archives OR has retryable SkippedPackages
   *  pending. The caller computes this via the trulyIdle formula. */
  lastScanFoundArchives: boolean;
  /** Pre-incremented value of consecutiveEmptyScans. Caller passes:
   *    trulyIdle ? prev + 1 : 0
   *  We do the arithmetic outside the helper so the helper stays a pure
   *  setter — easier to reason about. */
  consecutiveEmptyScans: number;
}

/**
 * Atomically update an AccountChannelMap's watermark and scan-state fields.
 * Replaces the older updateLastProcessedMessage for the post-scan write.
 * Sets lastScannedAt = NOW() server-side.
 */
export async function upsertChannelScanState(
  mappingId: string,
  update: ScanStateUpdate
) {
  return db.accountChannelMap.update({
    where: { id: mappingId },
    data: {
      lastProcessedMessageId: update.lastProcessedMessageId ?? undefined,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
  });
}

/**
 * Atomically upsert a TopicProgress row with the new watermark + scan-state
 * fields. Same semantics as upsertChannelScanState but for forum topics.
 */
export async function upsertTopicScanState(
  accountChannelMapId: string,
  topicId: bigint,
  topicName: string | null,
  update: ScanStateUpdate
) {
  return db.topicProgress.upsert({
    where: {
      accountChannelMapId_topicId: { accountChannelMapId, topicId },
    },
    create: {
      accountChannelMapId,
      topicId,
      topicName,
      lastProcessedMessageId: update.lastProcessedMessageId,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
    update: {
      topicName,
      lastProcessedMessageId: update.lastProcessedMessageId ?? undefined,
      lastScannedAt: new Date(),
      lastScanFoundArchives: update.lastScanFoundArchives,
      consecutiveEmptyScans: update.consecutiveEmptyScans,
    },
  });
}

export async function markStaleRunsAsFailed() {
  return db.ingestionRun.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: "Worker restarted — run was still marked as RUNNING",
    },
  });
}

export async function updateAccountAuthState(
  accountId: string,
  authState: "PENDING" | "AWAITING_CODE" | "AWAITING_PASSWORD" | "AUTHENTICATED" | "EXPIRED",
  authCode?: string | null
) {
  return db.telegramAccount.update({
    where: { id: accountId },
    data: { authState, authCode, lastSeenAt: authState === "AUTHENTICATED" ? new Date() : undefined },
  });
}

export async function updateAccountPremiumStatus(
  accountId: string,
  isPremium: boolean
): Promise<void> {
  await db.telegramAccount.update({
    where: { id: accountId },
    data: { isPremium },
  });
}

export async function getAccountAuthCode(accountId: string) {
  const account = await db.telegramAccount.findUnique({
    where: { id: accountId },
    select: { authCode: true, authState: true },
  });
  return account;
}

// ── Channel sync (auto-discovery from Telegram) ──

export interface UpsertChannelInput {
  telegramId: bigint;
  title: string;
  type: "SOURCE" | "DESTINATION";
  isForum: boolean;
  isActive?: boolean;
}

/**
 * Upsert a channel by telegramId. Returns the channel record.
 * If it already exists, update title and forum status.
 * New channels default to disabled (isActive: false) so the admin must
 * explicitly enable them before the worker processes them.
 * Pass isActive: true for DESTINATION channels that must be active immediately.
 */
export async function upsertChannel(input: UpsertChannelInput) {
  return db.telegramChannel.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      title: input.title,
      type: input.type,
      isForum: input.isForum,
      isActive: input.isActive ?? false,
    },
    update: {
      title: input.title,
      isForum: input.isForum,
    },
  });
}

/**
 * Link an account to a channel if not already linked.
 * Uses a try/catch on unique constraint to make it idempotent.
 */
export async function ensureAccountChannelLink(
  accountId: string,
  channelId: string,
  role: "READER" | "WRITER"
) {
  try {
    return await db.accountChannelMap.create({
      data: { accountId, channelId, role },
    });
  } catch (err: unknown) {
    // Already linked — ignore unique constraint violation
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return null;
    }
    throw err;
  }
}

// ── Forum / Topic progress ──

export async function setChannelForum(channelId: string, isForum: boolean) {
  return db.telegramChannel.update({
    where: { id: channelId },
    data: { isForum },
  });
}

export async function getTopicProgress(mappingId: string) {
  return db.topicProgress.findMany({
    where: { accountChannelMapId: mappingId },
  });
}

export async function upsertTopicProgress(
  mappingId: string,
  topicId: bigint,
  topicName: string | null,
  lastProcessedMessageId: bigint
) {
  return db.topicProgress.upsert({
    where: {
      accountChannelMapId_topicId: {
        accountChannelMapId: mappingId,
        topicId,
      },
    },
    create: {
      accountChannelMapId: mappingId,
      topicId,
      topicName,
      lastProcessedMessageId,
    },
    update: {
      topicName,
      lastProcessedMessageId,
    },
  });
}

/**
 * Ensure a TopicProgress row exists for every discovered topic so the admin
 * UI can list and toggle them — including brand-new topics. Inserts missing
 * rows only (fetchEnabled defaults to true); never overwrites watermarks,
 * scan-state, or the user's fetchEnabled choice on rows that already exist.
 */
export async function ensureTopicProgressRows(
  mappingId: string,
  topics: { topicId: bigint; name: string | null }[]
): Promise<void> {
  if (topics.length === 0) return;
  await db.topicProgress.createMany({
    data: topics.map((t) => ({
      accountChannelMapId: mappingId,
      topicId: t.topicId,
      topicName: t.name,
    })),
    skipDuplicates: true,
  });
}

/**
 * Read the CURRENT per-topic fetch flag straight from the DB. Returns true
 * when no row exists yet (default = enabled). Called fresh inside the topic
 * loop so a mid-run toggle is honoured for topics not yet started.
 */
export async function isTopicFetchEnabled(
  mappingId: string,
  topicId: bigint
): Promise<boolean> {
  const row = await db.topicProgress.findUnique({
    where: {
      accountChannelMapId_topicId: { accountChannelMapId: mappingId, topicId },
    },
    select: { fetchEnabled: true },
  });
  return row?.fetchEnabled ?? true;
}

// ── Channel fetch requests (DB-mediated communication with web app) ──

export async function getChannelFetchRequest(requestId: string) {
  return db.channelFetchRequest.findUnique({
    where: { id: requestId },
    include: { account: true },
  });
}

export async function updateFetchRequestStatus(
  requestId: string,
  status: FetchStatus,
  extra?: { resultJson?: string; error?: string }
) {
  return db.channelFetchRequest.update({
    where: { id: requestId },
    data: {
      status,
      resultJson: extra?.resultJson ?? undefined,
      error: extra?.error ?? undefined,
    },
  });
}

export async function getAccountLinkedChannelIds(accountId: string): Promise<Set<string>> {
  const links = await db.accountChannelMap.findMany({
    where: { accountId },
    select: { channel: { select: { telegramId: true } } },
  });
  return new Set(links.map((l) => l.channel.telegramId.toString()));
}

export async function getExistingChannelsByTelegramId(): Promise<Map<string, string>> {
  const channels = await db.telegramChannel.findMany({
    select: { id: true, telegramId: true },
  });
  const map = new Map<string, string>();
  for (const ch of channels) {
    map.set(ch.telegramId.toString(), ch.id);
  }
  return map;
}

export async function getAccountById(accountId: string) {
  return db.telegramAccount.findUnique({ where: { id: accountId } });
}

/**
 * Find packages that have a destMessageId set (appear uploaded) but may
 * reference messages that no longer exist in Telegram. These need
 * verification on startup.
 *
 * Groups by destChannelId so the caller can batch-verify per channel.
 */
export async function getPackagesWithDestMessage() {
  return db.package.findMany({
    where: { destMessageId: { not: null }, destChannelId: { not: null } },
    select: {
      id: true,
      fileName: true,
      contentHash: true,
      destChannelId: true,
      destMessageId: true,
      sourceChannel: { select: { telegramId: true } },
    },
  });
}

/**
 * Reset a package's destination fields so it will be re-processed
 * on the next ingestion run (treated as not-yet-uploaded).
 */
export async function resetPackageDestination(packageId: string) {
  return db.package.update({
    where: { id: packageId },
    data: { destChannelId: null, destMessageId: null },
  });
}

export async function upsertSkippedPackage(data: {
  fileName: string;
  fileSize: bigint;
  reason: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
  errorMessage?: string;
  sourceChannelId: string;
  sourceMessageId: bigint;
  sourceTopicId?: bigint | null;
  isMultipart: boolean;
  partCount: number;
  accountId: string;
}) {
  return db.skippedPackage.upsert({
    where: {
      sourceChannelId_sourceMessageId: {
        sourceChannelId: data.sourceChannelId,
        sourceMessageId: data.sourceMessageId,
      },
    },
    update: {
      reason: data.reason,
      errorMessage: data.errorMessage ?? null,
      fileName: data.fileName,
      fileSize: data.fileSize,
      attemptCount: { increment: 1 },
      createdAt: new Date(),
    },
    create: {
      fileName: data.fileName,
      fileSize: data.fileSize,
      reason: data.reason,
      errorMessage: data.errorMessage ?? null,
      sourceChannelId: data.sourceChannelId,
      sourceMessageId: data.sourceMessageId,
      sourceTopicId: data.sourceTopicId ?? null,
      isMultipart: data.isMultipart,
      partCount: data.partCount,
      accountId: data.accountId,
    },
  });
}

/**
 * Return source-message IDs in a channel whose SkippedPackage attemptCount has
 * reached or exceeded the cap — these are treated as "permanently failed for
 * now" so the watermark can advance past them. The user can manually retry via
 * the UI to reset the SkippedPackage record.
 */
export async function getCappedSkippedMessageIds(
  sourceChannelId: string,
  cap: number
): Promise<Set<bigint>> {
  const rows = await db.skippedPackage.findMany({
    where: {
      sourceChannelId,
      attemptCount: { gte: cap },
    },
    select: { sourceMessageId: true },
  });
  return new Set(rows.map((r) => r.sourceMessageId));
}

export async function deleteSkippedPackage(
  sourceChannelId: string,
  sourceMessageId: bigint
) {
  return db.skippedPackage.deleteMany({
    where: { sourceChannelId, sourceMessageId },
  });
}

/**
 * Find SkippedPackages for a given account+channel that are still eligible
 * for auto-retry (attemptCount below the cap). Used at the start of a scan
 * to pull the watermark back so we don't strand failed messages forever
 * after the watermark has advanced past them.
 *
 * For non-forum channels, pass `topicId: null` to get rows with NULL topic.
 * For forum channels, pass the topic ID to scope to that topic only.
 */
export async function getRetryableSkippedMessageIds(args: {
  accountId: string;
  sourceChannelId: string;
  topicId: bigint | null;
  cap: number;
}): Promise<bigint[]> {
  const rows = await db.skippedPackage.findMany({
    where: {
      accountId: args.accountId,
      sourceChannelId: args.sourceChannelId,
      sourceTopicId: args.topicId,
      attemptCount: { lt: args.cap },
    },
    select: { sourceMessageId: true },
    orderBy: { sourceMessageId: "asc" },
  });
  return rows.map((r) => r.sourceMessageId);
}

/**
 * Update a Package's source topic when a more specific topic context is
 * discovered for the same content. Used when findRepostedPackage matches
 * an existing Package whose topic is less specific (e.g., "General") than
 * the topic we just encountered the file in.
 *
 * Also updates the creator if the new topic name is more informative than
 * the existing creator (i.e., the existing creator was derived from a
 * less-specific topic name like "General").
 */
export async function updatePackageTopicContext(
  packageId: string,
  newTopicId: bigint,
  newTopicName: string | null
): Promise<void> {
  await db.package.update({
    where: { id: packageId },
    data: {
      sourceTopicId: newTopicId,
      // Only overwrite creator if the new topic name is meaningful (non-empty,
      // non-General). Keeps explicit creator values from filename or admin
      // input intact.
      ...(newTopicName && newTopicName !== "General"
        ? { creator: newTopicName }
        : {}),
    },
  });
}

export async function createOrFindPackageGroup(input: {
  mediaAlbumId: string;
  sourceChannelId: string;
  name: string;
  previewData?: Buffer | null;
}): Promise<string> {
  // findFirst + conditional create (Prisma doesn't support upsert on nullable compound unique)
  const existing = await db.packageGroup.findFirst({
    where: {
      mediaAlbumId: input.mediaAlbumId,
      sourceChannelId: input.sourceChannelId,
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  try {
    const group = await db.packageGroup.create({
      data: {
        mediaAlbumId: input.mediaAlbumId,
        sourceChannelId: input.sourceChannelId,
        name: input.name,
        previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      },
    });
    return group.id;
  } catch (err) {
    // Handle race condition: another process created the group between our findFirst and create
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      const raced = await db.packageGroup.findFirst({
        where: { mediaAlbumId: input.mediaAlbumId, sourceChannelId: input.sourceChannelId },
        select: { id: true },
      });
      if (raced) return raced.id;
    }
    throw err;
  }
}

export async function linkPackagesToGroup(
  packageIds: string[],
  groupId: string
): Promise<void> {
  await db.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: groupId },
  });
}

export async function createTimeWindowGroup(input: {
  sourceChannelId: string;
  name: string;
  packageIds: string[];
}): Promise<string> {
  const group = await db.packageGroup.create({
    data: {
      sourceChannelId: input.sourceChannelId,
      name: input.name,
      groupingSource: "AUTO_TIME",
    },
  });

  await db.package.updateMany({
    where: { id: { in: input.packageIds } },
    data: { packageGroupId: group.id },
  });

  return group.id;
}

export async function createAutoGroup(input: {
  sourceChannelId: string;
  name: string;
  packageIds: string[];
  groupingSource: "ALBUM" | "MANUAL" | "AUTO_TIME" | "AUTO_PATTERN" | "AUTO_ZIP" | "AUTO_CAPTION" | "AUTO_REPLY";
}): Promise<string> {
  const group = await db.packageGroup.create({
    data: {
      sourceChannelId: input.sourceChannelId,
      name: input.name,
      groupingSource: input.groupingSource,
    },
  });

  await db.package.updateMany({
    where: { id: { in: input.packageIds } },
    data: { packageGroupId: group.id },
  });

  return group.id;
}
