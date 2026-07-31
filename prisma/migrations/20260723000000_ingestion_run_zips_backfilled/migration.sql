-- AlterTable: count of packages whose provenance was backfilled during a run
-- (opportunistic cross-channel provenance backfill). Additive, non-null with a
-- default of 0 — no data change for existing rows.
ALTER TABLE "ingestion_runs"
  ADD COLUMN "zipsBackfilled" INTEGER NOT NULL DEFAULT 0;
