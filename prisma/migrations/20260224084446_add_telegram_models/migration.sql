-- CreateEnum
CREATE TYPE "AuthState" AS ENUM ('PENDING', 'AWAITING_CODE', 'AWAITING_PASSWORD', 'AUTHENTICATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('SOURCE', 'DESTINATION');

-- CreateEnum
CREATE TYPE "ChannelRole" AS ENUM ('READER', 'WRITER');

-- CreateEnum
CREATE TYPE "ArchiveType" AS ENUM ('ZIP', 'RAR');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "telegram_accounts" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "apiId" INTEGER NOT NULL,
    "apiHash" TEXT NOT NULL,
    "sessionPath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "authState" "AuthState" NOT NULL DEFAULT 'PENDING',
    "authCode" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_channels" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_channel_map" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "role" "ChannelRole" NOT NULL DEFAULT 'READER',
    "lastProcessedMessageId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_channel_map_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "archiveType" "ArchiveType" NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "sourceMessageId" BIGINT NOT NULL,
    "destChannelId" TEXT,
    "destMessageId" BIGINT,
    "isMultipart" BOOLEAN NOT NULL DEFAULT false,
    "partCount" INTEGER NOT NULL DEFAULT 1,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestionRunId" TEXT,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_files" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "extension" TEXT,
    "compressedSize" BIGINT NOT NULL DEFAULT 0,
    "uncompressedSize" BIGINT NOT NULL DEFAULT 0,
    "crc32" TEXT,

    CONSTRAINT "package_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "IngestionStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "messagesScanned" INTEGER NOT NULL DEFAULT 0,
    "zipsFound" INTEGER NOT NULL DEFAULT 0,
    "zipsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "zipsIngested" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_accounts_phone_key" ON "telegram_accounts"("phone");

-- CreateIndex
CREATE INDEX "telegram_accounts_isActive_idx" ON "telegram_accounts"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_channels_telegramId_key" ON "telegram_channels"("telegramId");

-- CreateIndex
CREATE INDEX "telegram_channels_type_isActive_idx" ON "telegram_channels"("type", "isActive");

-- CreateIndex
CREATE INDEX "account_channel_map_accountId_idx" ON "account_channel_map"("accountId");

-- CreateIndex
CREATE INDEX "account_channel_map_channelId_idx" ON "account_channel_map"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "account_channel_map_accountId_channelId_key" ON "account_channel_map"("accountId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "packages_contentHash_key" ON "packages"("contentHash");

-- CreateIndex
CREATE INDEX "packages_sourceChannelId_idx" ON "packages"("sourceChannelId");

-- CreateIndex
CREATE INDEX "packages_destChannelId_idx" ON "packages"("destChannelId");

-- CreateIndex
CREATE INDEX "packages_fileName_idx" ON "packages"("fileName");

-- CreateIndex
CREATE INDEX "packages_indexedAt_idx" ON "packages"("indexedAt");

-- CreateIndex
CREATE INDEX "packages_archiveType_idx" ON "packages"("archiveType");

-- CreateIndex
CREATE INDEX "package_files_packageId_idx" ON "package_files"("packageId");

-- CreateIndex
CREATE INDEX "package_files_extension_idx" ON "package_files"("extension");

-- CreateIndex
CREATE INDEX "package_files_fileName_idx" ON "package_files"("fileName");

-- CreateIndex
CREATE INDEX "ingestion_runs_accountId_idx" ON "ingestion_runs"("accountId");

-- CreateIndex
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs"("status");

-- CreateIndex
CREATE INDEX "ingestion_runs_startedAt_idx" ON "ingestion_runs"("startedAt");

-- AddForeignKey
ALTER TABLE "account_channel_map" ADD CONSTRAINT "account_channel_map_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_channel_map" ADD CONSTRAINT "account_channel_map_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "telegram_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "telegram_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_files" ADD CONSTRAINT "package_files_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "telegram_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
