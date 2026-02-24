/*
  Warnings:

  - You are about to drop the column `apiHash` on the `telegram_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `apiId` on the `telegram_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `sessionPath` on the `telegram_accounts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "telegram_accounts" DROP COLUMN "apiHash",
DROP COLUMN "apiId",
DROP COLUMN "sessionPath";
