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
  isMultipart: boolean;
  partCount: number;
  ingestionRunId: string;
  creator?: string | null;
  tags?: string[];
  previewData?: Buffer | null;
  previewMsgId?: bigint | null;
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
      isMultipart: input.isMultipart,
      partCount: input.partCount,
      fileCount: input.files.length,
      ingestionRunId: input.ingestionRunId,
      creator: input.creator ?? undefined,
      tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      previewMsgId: input.previewMsgId ?? undefined,
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
