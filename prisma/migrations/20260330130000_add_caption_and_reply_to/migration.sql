-- AlterTable: add sourceCaption and replyToMessageId to packages
ALTER TABLE "packages" ADD COLUMN "sourceCaption" TEXT;
ALTER TABLE "packages" ADD COLUMN "replyToMessageId" BIGINT;
