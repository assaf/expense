-- AlterTable: user email verification (login gate).
-- emailVerifiedAt null = must click the emailed verification link before
-- signing in; verificationTokenHash/verificationSentAt hold the current
-- single-use token (sha256 of the raw token) and when it was emailed.
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TEXT;
ALTER TABLE "users" ADD COLUMN "verificationTokenHash" TEXT;
ALTER TABLE "users" ADD COLUMN "verificationSentAt" TEXT;

-- Grandfather existing rows: every user created before this migration is
-- treated as verified (email verification was not required then). New
-- signups leave emailVerifiedAt null and must verify.
UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;
