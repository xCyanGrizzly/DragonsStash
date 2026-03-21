-- AlterTable
ALTER TABLE "telegram_channels" ADD COLUMN "category" VARCHAR(64);

-- CreateIndex
CREATE INDEX "telegram_channels_category_idx" ON "telegram_channels"("category");
