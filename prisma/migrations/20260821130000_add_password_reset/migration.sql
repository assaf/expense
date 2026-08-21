-- AlterTable: password reset (emailed single-use link, mirroring the
-- account-verification token columns).
-- passwordResetTokenHash = sha256 of the raw token in the emailed link;
-- passwordResetSentAt = when it was emailed (once-a-day resend guard).
-- Both null = no reset in flight. A successful reset clears both.
ALTER TABLE "users" ADD COLUMN "passwordResetTokenHash" TEXT;
ALTER TABLE "users" ADD COLUMN "passwordResetSentAt" TEXT;
