-- CreateEnum GroupingSource
CREATE TYPE "GroupingSource" AS ENUM ('ALBUM', 'MANUAL', 'AUTO_TIME', 'AUTO_PATTERN', 'AUTO_REPLY', 'AUTO_ZIP', 'AUTO_CAPTION');

-- CreateEnum NotificationType
CREATE TYPE "NotificationType" AS ENUM ('HASH_MISMATCH', 'MISSING_PART', 'UPLOAD_FAILED', 'DOWNLOAD_FAILED', 'GROUPING_CONFLICT', 'INTEGRITY_AUDIT');

-- CreateEnum NotificationSeverity
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- AlterTable: add groupingSource to package_groups
ALTER TABLE "package_groups" ADD COLUMN "groupingSource" "GroupingSource" NOT NULL DEFAULT 'MANUAL';

-- Backfill: mark album-based groups
UPDATE "package_groups" SET "groupingSource" = 'ALBUM' WHERE "mediaAlbumId" IS NOT NULL;

-- CreateTable: system_notifications
CREATE TABLE "system_notifications" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_notifications_isRead_createdAt_idx" ON "system_notifications"("isRead", "createdAt");
CREATE INDEX "system_notifications_type_idx" ON "system_notifications"("type");
