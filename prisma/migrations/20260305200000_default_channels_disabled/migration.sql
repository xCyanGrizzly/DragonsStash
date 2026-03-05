-- Change the default for new channels to disabled (isActive = false).
-- Existing channels are not affected — admins can manually enable/disable them.
ALTER TABLE "telegram_channels" ALTER COLUMN "isActive" SET DEFAULT false;
