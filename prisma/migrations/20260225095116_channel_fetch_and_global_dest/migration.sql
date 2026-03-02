-- CreateEnum
CREATE TYPE "FetchStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "global_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "channel_fetch_requests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "FetchStatus" NOT NULL DEFAULT 'PENDING',
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_fetch_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_fetch_requests_accountId_status_idx" ON "channel_fetch_requests"("accountId", "status");

-- AddForeignKey
ALTER TABLE "channel_fetch_requests" ADD CONSTRAINT "channel_fetch_requests_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
