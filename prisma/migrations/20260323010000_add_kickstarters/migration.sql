-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('NOT_DELIVERED', 'PARTIAL', 'DELIVERED');
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'UNPAID');

-- CreateTable
CREATE TABLE "kickstarter_hosts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kickstarter_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kickstarters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "link" TEXT,
    "filesUrl" TEXT,
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'NOT_DELIVERED',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "notes" TEXT,
    "hostId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kickstarters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kickstarter_packages" (
    "kickstarterId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,

    CONSTRAINT "kickstarter_packages_pkey" PRIMARY KEY ("kickstarterId","packageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "kickstarter_hosts_name_key" ON "kickstarter_hosts"("name");
CREATE INDEX "kickstarters_hostId_idx" ON "kickstarters"("hostId");
CREATE INDEX "kickstarters_userId_idx" ON "kickstarters"("userId");
CREATE INDEX "kickstarters_deliveryStatus_idx" ON "kickstarters"("deliveryStatus");
CREATE INDEX "kickstarters_paymentStatus_idx" ON "kickstarters"("paymentStatus");

-- AddForeignKey
ALTER TABLE "kickstarters" ADD CONSTRAINT "kickstarters_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "kickstarter_hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "kickstarters" ADD CONSTRAINT "kickstarters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kickstarter_packages" ADD CONSTRAINT "kickstarter_packages_kickstarterId_fkey" FOREIGN KEY ("kickstarterId") REFERENCES "kickstarters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kickstarter_packages" ADD CONSTRAINT "kickstarter_packages_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
