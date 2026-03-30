-- CreateEnum
CREATE TYPE "ManualUploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "manual_uploads" (
    "id" TEXT NOT NULL,
    "status" "ManualUploadStatus" NOT NULL DEFAULT 'PENDING',
    "groupName" TEXT,
    "userId" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "manual_uploads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "manual_upload_files" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "packageId" TEXT,
    CONSTRAINT "manual_upload_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "manual_uploads_status_idx" ON "manual_uploads"("status");
CREATE INDEX "manual_upload_files_uploadId_idx" ON "manual_upload_files"("uploadId");

ALTER TABLE "manual_uploads" ADD CONSTRAINT "manual_uploads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_upload_files" ADD CONSTRAINT "manual_upload_files_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "manual_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
