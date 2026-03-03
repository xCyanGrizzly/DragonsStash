-- CreateEnum
CREATE TYPE "BotSendStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "telegram_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "telegramName" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_send_requests" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "telegramLinkId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "BotSendStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "bot_send_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_subscriptions" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "pattern" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_userId_key" ON "telegram_links"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_telegramUserId_key" ON "telegram_links"("telegramUserId");

-- CreateIndex
CREATE INDEX "bot_send_requests_status_idx" ON "bot_send_requests"("status");

-- CreateIndex
CREATE INDEX "bot_send_requests_telegramLinkId_idx" ON "bot_send_requests"("telegramLinkId");

-- CreateIndex
CREATE INDEX "bot_send_requests_createdAt_idx" ON "bot_send_requests"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bot_subscriptions_telegramUserId_pattern_key" ON "bot_subscriptions"("telegramUserId", "pattern");

-- CreateIndex
CREATE INDEX "bot_subscriptions_telegramUserId_idx" ON "bot_subscriptions"("telegramUserId");

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_send_requests" ADD CONSTRAINT "bot_send_requests_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_send_requests" ADD CONSTRAINT "bot_send_requests_telegramLinkId_fkey" FOREIGN KEY ("telegramLinkId") REFERENCES "telegram_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
