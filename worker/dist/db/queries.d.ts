import type { ArchiveType, FetchStatus } from "@prisma/client";
export declare function getActiveAccounts(): Promise<{
    id: string;
    phone: string;
    displayName: string | null;
    isActive: boolean;
    authState: import("@prisma/client").$Enums.AuthState;
    authCode: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}[]>;
export declare function getPendingAccounts(): Promise<{
    id: string;
    phone: string;
    displayName: string | null;
    isActive: boolean;
    authState: import("@prisma/client").$Enums.AuthState;
    authCode: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}[]>;
export declare function hasAnyChannels(): Promise<boolean>;
export declare function getSourceChannelMappings(accountId: string): Promise<({
    channel: {
        id: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        telegramId: bigint;
        title: string;
        type: import("@prisma/client").$Enums.ChannelType;
        isForum: boolean;
    };
} & {
    accountId: string;
    id: string;
    createdAt: Date;
    channelId: string;
    role: import("@prisma/client").$Enums.ChannelRole;
    lastProcessedMessageId: bigint | null;
})[]>;
export declare function getGlobalDestinationChannel(): Promise<{
    id: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    telegramId: bigint;
    title: string;
    type: import("@prisma/client").$Enums.ChannelType;
    isForum: boolean;
} | null>;
export declare function getGlobalSetting(key: string): Promise<string | null>;
export declare function setGlobalSetting(key: string, value: string): Promise<{
    updatedAt: Date;
    key: string;
    value: string;
}>;
export declare function packageExistsByHash(contentHash: string): Promise<boolean>;
/**
 * Check if a package already exists for a given source message ID
 * AND was successfully uploaded to the destination (destMessageId is set).
 * Used as an early skip before downloading.
 */
export declare function packageExistsBySourceMessage(sourceChannelId: string, sourceMessageId: bigint): Promise<boolean>;
/**
 * Delete orphaned Package rows that have the same content hash but never
 * completed the upload (destMessageId is null). Called before creating a
 * new complete record to avoid unique constraint violations.
 */
export declare function deleteOrphanedPackageByHash(contentHash: string): Promise<void>;
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
export declare function createPackageWithFiles(input: CreatePackageInput): Promise<{
    id: string;
    createdAt: Date;
    contentHash: string;
    fileName: string;
    fileSize: bigint;
    archiveType: import("@prisma/client").$Enums.ArchiveType;
    creator: string | null;
    sourceChannelId: string;
    sourceMessageId: bigint;
    sourceTopicId: bigint | null;
    destChannelId: string | null;
    destMessageId: bigint | null;
    isMultipart: boolean;
    partCount: number;
    fileCount: number;
    previewData: import("@prisma/client/runtime/client").Bytes | null;
    previewMsgId: bigint | null;
    indexedAt: Date;
    ingestionRunId: string | null;
}>;
export declare function createIngestionRun(accountId: string): Promise<{
    accountId: string;
    id: string;
    status: import("@prisma/client").$Enums.IngestionStatus;
    startedAt: Date;
    finishedAt: Date | null;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    errorMessage: string | null;
    currentActivity: string | null;
    currentStep: string | null;
    currentChannel: string | null;
    currentFile: string | null;
    currentFileNum: number | null;
    totalFiles: number | null;
    downloadedBytes: bigint | null;
    totalBytes: bigint | null;
    downloadPercent: number | null;
    lastActivityAt: Date | null;
}>;
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
export declare function updateRunActivity(runId: string, activity: ActivityUpdate): Promise<{
    accountId: string;
    id: string;
    status: import("@prisma/client").$Enums.IngestionStatus;
    startedAt: Date;
    finishedAt: Date | null;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    errorMessage: string | null;
    currentActivity: string | null;
    currentStep: string | null;
    currentChannel: string | null;
    currentFile: string | null;
    currentFileNum: number | null;
    totalFiles: number | null;
    downloadedBytes: bigint | null;
    totalBytes: bigint | null;
    downloadPercent: number | null;
    lastActivityAt: Date | null;
}>;
export declare function completeIngestionRun(runId: string, counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
}): Promise<{
    accountId: string;
    id: string;
    status: import("@prisma/client").$Enums.IngestionStatus;
    startedAt: Date;
    finishedAt: Date | null;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    errorMessage: string | null;
    currentActivity: string | null;
    currentStep: string | null;
    currentChannel: string | null;
    currentFile: string | null;
    currentFileNum: number | null;
    totalFiles: number | null;
    downloadedBytes: bigint | null;
    totalBytes: bigint | null;
    downloadPercent: number | null;
    lastActivityAt: Date | null;
}>;
export declare function failIngestionRun(runId: string, errorMessage: string): Promise<{
    accountId: string;
    id: string;
    status: import("@prisma/client").$Enums.IngestionStatus;
    startedAt: Date;
    finishedAt: Date | null;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    errorMessage: string | null;
    currentActivity: string | null;
    currentStep: string | null;
    currentChannel: string | null;
    currentFile: string | null;
    currentFileNum: number | null;
    totalFiles: number | null;
    downloadedBytes: bigint | null;
    totalBytes: bigint | null;
    downloadPercent: number | null;
    lastActivityAt: Date | null;
}>;
export declare function updateLastProcessedMessage(mappingId: string, messageId: bigint): Promise<{
    accountId: string;
    id: string;
    createdAt: Date;
    channelId: string;
    role: import("@prisma/client").$Enums.ChannelRole;
    lastProcessedMessageId: bigint | null;
}>;
export declare function markStaleRunsAsFailed(): Promise<import("@prisma/client").Prisma.BatchPayload>;
export declare function updateAccountAuthState(accountId: string, authState: "PENDING" | "AWAITING_CODE" | "AWAITING_PASSWORD" | "AUTHENTICATED" | "EXPIRED", authCode?: string | null): Promise<{
    id: string;
    phone: string;
    displayName: string | null;
    isActive: boolean;
    authState: import("@prisma/client").$Enums.AuthState;
    authCode: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}>;
export declare function getAccountAuthCode(accountId: string): Promise<{
    authState: import("@prisma/client").$Enums.AuthState;
    authCode: string | null;
} | null>;
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
export declare function upsertChannel(input: UpsertChannelInput): Promise<{
    id: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    telegramId: bigint;
    title: string;
    type: import("@prisma/client").$Enums.ChannelType;
    isForum: boolean;
}>;
/**
 * Link an account to a channel if not already linked.
 * Uses a try/catch on unique constraint to make it idempotent.
 */
export declare function ensureAccountChannelLink(accountId: string, channelId: string, role: "READER" | "WRITER"): Promise<{
    accountId: string;
    id: string;
    createdAt: Date;
    channelId: string;
    role: import("@prisma/client").$Enums.ChannelRole;
    lastProcessedMessageId: bigint | null;
} | null>;
export declare function setChannelForum(channelId: string, isForum: boolean): Promise<{
    id: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    telegramId: bigint;
    title: string;
    type: import("@prisma/client").$Enums.ChannelType;
    isForum: boolean;
}>;
export declare function getTopicProgress(mappingId: string): Promise<{
    id: string;
    lastProcessedMessageId: bigint | null;
    accountChannelMapId: string;
    topicId: bigint;
    topicName: string | null;
}[]>;
export declare function upsertTopicProgress(mappingId: string, topicId: bigint, topicName: string | null, lastProcessedMessageId: bigint): Promise<{
    id: string;
    lastProcessedMessageId: bigint | null;
    accountChannelMapId: string;
    topicId: bigint;
    topicName: string | null;
}>;
export declare function getChannelFetchRequest(requestId: string): Promise<({
    account: {
        id: string;
        phone: string;
        displayName: string | null;
        isActive: boolean;
        authState: import("@prisma/client").$Enums.AuthState;
        authCode: string | null;
        lastSeenAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
    };
} & {
    error: string | null;
    accountId: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    status: import("@prisma/client").$Enums.FetchStatus;
    resultJson: string | null;
}) | null>;
export declare function updateFetchRequestStatus(requestId: string, status: FetchStatus, extra?: {
    resultJson?: string;
    error?: string;
}): Promise<{
    error: string | null;
    accountId: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    status: import("@prisma/client").$Enums.FetchStatus;
    resultJson: string | null;
}>;
export declare function getAccountLinkedChannelIds(accountId: string): Promise<Set<string>>;
export declare function getExistingChannelsByTelegramId(): Promise<Map<string, string>>;
export declare function getAccountById(accountId: string): Promise<{
    id: string;
    phone: string;
    displayName: string | null;
    isActive: boolean;
    authState: import("@prisma/client").$Enums.AuthState;
    authCode: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
} | null>;
