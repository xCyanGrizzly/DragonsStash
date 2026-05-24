-- AlterTable: capture TDLib's stable per-content identifier for new packages.
-- Existing rows are NULL; they fall through to the other dedup checks until
-- they're re-encountered organically.
ALTER TABLE "packages" ADD COLUMN "remoteUniqueId" TEXT;

-- CreateIndex: scoped to source channel because we want to dedup
-- per-channel (the same file appearing in two different channels is still
-- worth indexing twice — they're different ingestion sources).
CREATE INDEX "packages_sourceChannelId_remoteUniqueId_idx"
  ON "packages"("sourceChannelId", "remoteUniqueId");
