-- AlterTable
ALTER TABLE "UsageLog" ADD COLUMN     "supplyId" TEXT,
ALTER COLUMN "unit" SET DATA TYPE VARCHAR(16);

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "brand" VARCHAR(64) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "color" VARCHAR(64),
    "colorHex" VARCHAR(7),
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "usedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" VARCHAR(16) NOT NULL,
    "purchaseDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnSupply" (
    "supplyId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TagOnSupply_pkey" PRIMARY KEY ("supplyId","tagId")
);

-- CreateIndex
CREATE INDEX "Supply_userId_idx" ON "Supply"("userId");

-- CreateIndex
CREATE INDEX "Supply_vendorId_idx" ON "Supply"("vendorId");

-- CreateIndex
CREATE INDEX "Supply_locationId_idx" ON "Supply"("locationId");

-- CreateIndex
CREATE INDEX "Supply_category_idx" ON "Supply"("category");

-- CreateIndex
CREATE INDEX "Supply_archived_idx" ON "Supply"("archived");

-- CreateIndex
CREATE INDEX "Supply_brand_idx" ON "Supply"("brand");

-- AddForeignKey
ALTER TABLE "Supply" ADD CONSTRAINT "Supply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supply" ADD CONSTRAINT "Supply_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supply" ADD CONSTRAINT "Supply_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnSupply" ADD CONSTRAINT "TagOnSupply_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnSupply" ADD CONSTRAINT "TagOnSupply_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;
