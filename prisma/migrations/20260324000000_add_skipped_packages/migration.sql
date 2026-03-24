-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('SIZE_LIMIT', 'DOWNLOAD_FAILED', 'EXTRACT_FAILED', 'UPLOAD_FAILED');

-- CreateTable
CREATE TABLE "skipped_packages" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "reason" "SkipReason" NOT NULL,
    "errorMessage" TEXT,
    "sourceChannelId" TEXT NOT NULL,
    "sourceMessageId" BIGINT NOT NULL,
    "sourceTopicId" BIGINT,
    "isMultipart" BOOLEAN NOT NULL DEFAULT false,
    "partCount" INTEGER NOT NULL DEFAULT 1,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skipped_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skipped_packages_sourceChannelId_sourceMessageId_key" ON "skipped_packages"("sourceChannelId", "sourceMessageId");

-- CreateIndex
CREATE INDEX "skipped_packages_reason_idx" ON "skipped_packages"("reason");

-- CreateIndex
CREATE INDEX "skipped_packages_accountId_idx" ON "skipped_packages"("accountId");

-- AddForeignKey
ALTER TABLE "skipped_packages" ADD CONSTRAINT "skipped_packages_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "telegram_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skipped_packages" ADD CONSTRAINT "skipped_packages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
