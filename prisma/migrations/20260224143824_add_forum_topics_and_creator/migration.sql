-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "creator" TEXT,
ADD COLUMN     "sourceTopicId" BIGINT;

-- AlterTable
ALTER TABLE "telegram_channels" ADD COLUMN     "isForum" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "topic_progress" (
    "id" TEXT NOT NULL,
    "accountChannelMapId" TEXT NOT NULL,
    "topicId" BIGINT NOT NULL,
    "topicName" TEXT,
    "lastProcessedMessageId" BIGINT,

    CONSTRAINT "topic_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "topic_progress_accountChannelMapId_idx" ON "topic_progress"("accountChannelMapId");

-- CreateIndex
CREATE UNIQUE INDEX "topic_progress_accountChannelMapId_topicId_key" ON "topic_progress"("accountChannelMapId", "topicId");

-- CreateIndex
CREATE INDEX "packages_creator_idx" ON "packages"("creator");

-- AddForeignKey
ALTER TABLE "topic_progress" ADD CONSTRAINT "topic_progress_accountChannelMapId_fkey" FOREIGN KEY ("accountChannelMapId") REFERENCES "account_channel_map"("id") ON DELETE CASCADE ON UPDATE CASCADE;
