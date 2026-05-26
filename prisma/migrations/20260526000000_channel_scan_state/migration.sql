-- AlterTable: per-channel scan-state columns
ALTER TABLE "account_channel_map"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: per-topic scan-state columns (forum channels)
ALTER TABLE "topic_progress"
  ADD COLUMN "lastScannedAt" TIMESTAMP(3),
  ADD COLUMN "lastScanFoundArchives" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutiveEmptyScans" INTEGER NOT NULL DEFAULT 0;
