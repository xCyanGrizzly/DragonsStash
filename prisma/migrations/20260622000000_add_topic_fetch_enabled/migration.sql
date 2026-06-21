-- AlterTable: per-topic user-controlled fetch toggle (forum channels)
-- Additive, safe default (true) so existing rows backfill to "enabled" and
-- current behaviour is unchanged. Disabling is non-destructive.
ALTER TABLE "topic_progress"
  ADD COLUMN "fetchEnabled" BOOLEAN NOT NULL DEFAULT true;
