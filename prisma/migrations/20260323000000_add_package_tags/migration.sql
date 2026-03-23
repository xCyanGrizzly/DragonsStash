-- Add tags array column to packages
ALTER TABLE "packages" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: inherit source channel category as initial tag
UPDATE "packages" p
SET "tags" = ARRAY[c."category"]
FROM "telegram_channels" c
WHERE p."sourceChannelId" = c."id"
  AND c."category" IS NOT NULL
  AND c."category" != '';
