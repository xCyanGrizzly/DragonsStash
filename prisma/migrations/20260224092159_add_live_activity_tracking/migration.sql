-- AlterTable
ALTER TABLE "ingestion_runs" ADD COLUMN     "currentActivity" TEXT,
ADD COLUMN     "currentChannel" TEXT,
ADD COLUMN     "currentFile" TEXT,
ADD COLUMN     "currentFileNum" INTEGER,
ADD COLUMN     "currentStep" TEXT,
ADD COLUMN     "downloadPercent" INTEGER,
ADD COLUMN     "downloadedBytes" BIGINT,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "totalBytes" BIGINT,
ADD COLUMN     "totalFiles" INTEGER;
