-- AlterTable: track the forum topic currently being processed on the live run
-- so the worker status panel can offer a "skip & disable topic" action.
-- Additive, nullable — no data change for existing rows.
ALTER TABLE "ingestion_runs"
  ADD COLUMN "currentTopicId" BIGINT,
  ADD COLUMN "currentAccountChannelMapId" TEXT;
