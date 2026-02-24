import { db } from "./client.js";
import type { ArchiveType } from "@prisma/client";

export async function getActiveAccounts() {
  return db.telegramAccount.findMany({
    where: { isActive: true, authState: "AUTHENTICATED" },
  });
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

export async function getDestinationChannel(accountId: string) {
  const mapping = await db.accountChannelMap.findFirst({
    where: {
      accountId,
      role: "WRITER",
      channel: { type: "DESTINATION", isActive: true },
    },
    include: { channel: true },
  });
  return mapping?.channel ?? null;
}

export async function packageExistsByHash(contentHash: string) {
  const pkg = await db.package.findUnique({
    where: { contentHash },
    select: { id: true },
  });
  return pkg !== null;
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
  return db.package.create({
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
      previewData: input.previewData ? new Uint8Array(input.previewData) : undefined,
      previewMsgId: input.previewMsgId ?? undefined,
      files: {
        create: input.files,
      },
    },
  });
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
