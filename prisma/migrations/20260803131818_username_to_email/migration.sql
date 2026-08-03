-- AlterTable: the login name is now the email address (stored lowercase).
-- Existing rows keep their old username value; the bootstrap email backfill
-- (initStore, see app/lib/database.ts) rewrites the legacy value from
-- APP_EMAIL when configured.
ALTER TABLE "users" RENAME COLUMN "username" TO "email";

-- Rename the unique index to match Prisma's <table>_<field>_key convention.
ALTER INDEX "users_username_key" RENAME TO "users_email_key";
