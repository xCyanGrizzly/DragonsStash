-- CreateEnum
CREATE TYPE "ExtractStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "usedInviteId" TEXT;

-- CreateTable
CREATE TABLE "archive_extract_requests" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "filePath" VARCHAR(1024) NOT NULL,
    "status" "ExtractStatus" NOT NULL DEFAULT 'PENDING',
    "imageData" BYTEA,
    "contentType" VARCHAR(64),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_extract_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "archive_extract_requests_packageId_filePath_idx" ON "archive_extract_requests"("packageId", "filePath");

-- CreateIndex
CREATE INDEX "archive_extract_requests_status_idx" ON "archive_extract_requests"("status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_usedInviteId_fkey" FOREIGN KEY ("usedInviteId") REFERENCES "invite_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_extract_requests" ADD CONSTRAINT "archive_extract_requests_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
