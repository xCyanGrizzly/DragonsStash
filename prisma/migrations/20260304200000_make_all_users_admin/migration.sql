-- Promote all existing users to ADMIN (self-hosted: every user is an admin)
UPDATE "User" SET "role" = 'ADMIN' WHERE "role" = 'USER';

-- Change the default role for new users to ADMIN
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'ADMIN';
