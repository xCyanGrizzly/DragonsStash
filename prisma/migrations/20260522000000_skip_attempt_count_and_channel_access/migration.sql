-- AlterTable: track how many times the worker has tried each skipped source message.
-- Existing rows default to 1 (they represent a single past attempt that the worker
-- chose to record). Future failures increment via upsertSkippedPackage.
ALTER TABLE "skipped_packages" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1;

-- AlterEnum: add CHANNEL_ACCESS_LOST so the worker can surface a notification
-- when a source channel becomes inaccessible (account removed, channel deleted, etc.)
ALTER TYPE "NotificationType" ADD VALUE 'CHANNEL_ACCESS_LOST';
