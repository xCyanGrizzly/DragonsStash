-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "packageGroupId" TEXT;

-- CreateTable
CREATE TABLE "package_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaAlbumId" TEXT,
    "sourceChannelId" TEXT NOT NULL,
    "previewData" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "package_groups_sourceChannelId_idx" ON "package_groups"("sourceChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "package_groups_mediaAlbumId_sourceChannelId_key" ON "package_groups"("mediaAlbumId", "sourceChannelId");

-- CreateIndex
CREATE INDEX "packages_packageGroupId_idx" ON "packages"("packageGroupId");

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_packageGroupId_fkey" FOREIGN KEY ("packageGroupId") REFERENCES "package_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_groups" ADD CONSTRAINT "package_groups_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "telegram_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
