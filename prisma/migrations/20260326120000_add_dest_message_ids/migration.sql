-- AlterTable
ALTER TABLE "packages" ADD COLUMN "destMessageIds" BIGINT[] DEFAULT ARRAY[]::BIGINT[];

-- Backfill: copy existing destMessageId into the array
UPDATE "packages"
SET "destMessageIds" = ARRAY["destMessageId"]
WHERE "destMessageId" IS NOT NULL;
