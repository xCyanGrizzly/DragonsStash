-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "hashedPassword" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "website" VARCHAR(256),
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(256),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Filament" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "brand" VARCHAR(64) NOT NULL,
    "material" VARCHAR(32) NOT NULL,
    "color" VARCHAR(64) NOT NULL,
    "colorHex" VARCHAR(7) NOT NULL,
    "diameter" DOUBLE PRECISION NOT NULL DEFAULT 1.75,
    "spoolWeight" DOUBLE PRECISION NOT NULL,
    "usedWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "emptySpoolWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "Filament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resin" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "brand" VARCHAR(64) NOT NULL,
    "resinType" VARCHAR(32) NOT NULL,
    "color" VARCHAR(64) NOT NULL,
    "colorHex" VARCHAR(7) NOT NULL,
    "bottleSize" DOUBLE PRECISION NOT NULL,
    "usedML" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "Resin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paint" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "brand" VARCHAR(64) NOT NULL,
    "line" VARCHAR(64),
    "color" VARCHAR(64) NOT NULL,
    "colorHex" VARCHAR(7) NOT NULL,
    "finish" VARCHAR(32) NOT NULL,
    "volumeML" DOUBLE PRECISION NOT NULL,
    "usedML" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "vendorId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "Paint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnFilament" (
    "filamentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TagOnFilament_pkey" PRIMARY KEY ("filamentId","tagId")
);

-- CreateTable
CREATE TABLE "TagOnResin" (
    "resinId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TagOnResin_pkey" PRIMARY KEY ("resinId","tagId")
);

-- CreateTable
CREATE TABLE "TagOnPaint" (
    "paintId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "TagOnPaint_pkey" PRIMARY KEY ("paintId","tagId")
);

-- CreateTable
CREATE TABLE "UsageLog" (
    "id" TEXT NOT NULL,
    "itemType" VARCHAR(16) NOT NULL,
    "itemId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "unit" VARCHAR(4) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "filamentId" TEXT,
    "resinId" TEXT,
    "paintId" TEXT,

    CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lowStockThreshold" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "theme" VARCHAR(8) NOT NULL DEFAULT 'dark',
    "units" VARCHAR(8) NOT NULL DEFAULT 'metric',

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "Vendor_userId_idx" ON "Vendor"("userId");

-- CreateIndex
CREATE INDEX "Vendor_archived_idx" ON "Vendor"("archived");

-- CreateIndex
CREATE INDEX "Location_userId_idx" ON "Location"("userId");

-- CreateIndex
CREATE INDEX "Location_archived_idx" ON "Location"("archived");

-- CreateIndex
CREATE INDEX "Filament_userId_idx" ON "Filament"("userId");

-- CreateIndex
CREATE INDEX "Filament_vendorId_idx" ON "Filament"("vendorId");

-- CreateIndex
CREATE INDEX "Filament_locationId_idx" ON "Filament"("locationId");

-- CreateIndex
CREATE INDEX "Filament_material_idx" ON "Filament"("material");

-- CreateIndex
CREATE INDEX "Filament_archived_idx" ON "Filament"("archived");

-- CreateIndex
CREATE INDEX "Filament_brand_idx" ON "Filament"("brand");

-- CreateIndex
CREATE INDEX "Resin_userId_idx" ON "Resin"("userId");

-- CreateIndex
CREATE INDEX "Resin_vendorId_idx" ON "Resin"("vendorId");

-- CreateIndex
CREATE INDEX "Resin_locationId_idx" ON "Resin"("locationId");

-- CreateIndex
CREATE INDEX "Resin_resinType_idx" ON "Resin"("resinType");

-- CreateIndex
CREATE INDEX "Resin_archived_idx" ON "Resin"("archived");

-- CreateIndex
CREATE INDEX "Resin_brand_idx" ON "Resin"("brand");

-- CreateIndex
CREATE INDEX "Paint_userId_idx" ON "Paint"("userId");

-- CreateIndex
CREATE INDEX "Paint_vendorId_idx" ON "Paint"("vendorId");

-- CreateIndex
CREATE INDEX "Paint_locationId_idx" ON "Paint"("locationId");

-- CreateIndex
CREATE INDEX "Paint_finish_idx" ON "Paint"("finish");

-- CreateIndex
CREATE INDEX "Paint_archived_idx" ON "Paint"("archived");

-- CreateIndex
CREATE INDEX "Paint_brand_idx" ON "Paint"("brand");

-- CreateIndex
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_userId_key" ON "Tag"("name", "userId");

-- CreateIndex
CREATE INDEX "UsageLog_userId_idx" ON "UsageLog"("userId");

-- CreateIndex
CREATE INDEX "UsageLog_itemType_itemId_idx" ON "UsageLog"("itemType", "itemId");

-- CreateIndex
CREATE INDEX "UsageLog_createdAt_idx" ON "UsageLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Filament" ADD CONSTRAINT "Filament_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Filament" ADD CONSTRAINT "Filament_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Filament" ADD CONSTRAINT "Filament_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resin" ADD CONSTRAINT "Resin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resin" ADD CONSTRAINT "Resin_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resin" ADD CONSTRAINT "Resin_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paint" ADD CONSTRAINT "Paint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paint" ADD CONSTRAINT "Paint_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paint" ADD CONSTRAINT "Paint_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnFilament" ADD CONSTRAINT "TagOnFilament_filamentId_fkey" FOREIGN KEY ("filamentId") REFERENCES "Filament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnFilament" ADD CONSTRAINT "TagOnFilament_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnResin" ADD CONSTRAINT "TagOnResin_resinId_fkey" FOREIGN KEY ("resinId") REFERENCES "Resin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnResin" ADD CONSTRAINT "TagOnResin_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnPaint" ADD CONSTRAINT "TagOnPaint_paintId_fkey" FOREIGN KEY ("paintId") REFERENCES "Paint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnPaint" ADD CONSTRAINT "TagOnPaint_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_filamentId_fkey" FOREIGN KEY ("filamentId") REFERENCES "Filament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_resinId_fkey" FOREIGN KEY ("resinId") REFERENCES "Resin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_paintId_fkey" FOREIGN KEY ("paintId") REFERENCES "Paint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
