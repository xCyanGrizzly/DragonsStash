-- AlterTable: forward-priority ingestion support.
-- allowsForwarding is nullable — null means "not yet checked", treated the
-- same as false until confirmed true (safe default: download+reupload path).
ALTER TABLE "telegram_channels"
  ADD COLUMN "allowsForwarding" BOOLEAN;

-- AlterTable: count of packages forwarded (no download) during a run.
-- Additive, non-null with a default of 0 — no data change for existing rows.
ALTER TABLE "ingestion_runs"
  ADD COLUMN "zipsForwarded" INTEGER NOT NULL DEFAULT 0;
