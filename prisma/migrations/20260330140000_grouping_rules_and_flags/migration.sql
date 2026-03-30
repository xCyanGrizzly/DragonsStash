-- AlterTable: add autoGroupEnabled to telegram_channels
ALTER TABLE "telegram_channels" ADD COLUMN "autoGroupEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: grouping_rules
CREATE TABLE "grouping_rules" (
    "id" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "signalType" "GroupingSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByGroupId" TEXT,

    CONSTRAINT "grouping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grouping_rules_sourceChannelId_idx" ON "grouping_rules"("sourceChannelId");

-- AddForeignKey
ALTER TABLE "grouping_rules" ADD CONSTRAINT "grouping_rules_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "telegram_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search: add tsvector column and GIN index
ALTER TABLE "packages" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

UPDATE "packages" SET "searchVector" = to_tsvector('english',
  coalesce("fileName", '') || ' ' || coalesce("creator", '') || ' ' || coalesce("sourceCaption", '')
) WHERE "searchVector" IS NULL;

CREATE INDEX IF NOT EXISTS "packages_search_vector_idx" ON "packages" USING GIN ("searchVector");

-- Trigger to auto-update searchVector on insert/update
CREATE OR REPLACE FUNCTION packages_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('english',
    coalesce(NEW."fileName", '') || ' ' || coalesce(NEW."creator", '') || ' ' || coalesce(NEW."sourceCaption", '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS packages_search_vector_trigger ON "packages";
CREATE TRIGGER packages_search_vector_trigger
  BEFORE INSERT OR UPDATE OF "fileName", "creator", "sourceCaption"
  ON "packages"
  FOR EACH ROW
  EXECUTE FUNCTION packages_search_vector_update();
