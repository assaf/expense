// One-time baseline for a database created before the account migration.
// Reads APP_EMAIL/APP_PASSWORD (the bootstrap credentials) and emits
// idempotent SQL that:
//   1. adds accountId to every pre-account table (defaulting to a freshly
//      created bootstrap account, so NOT NULL + FK constraints validate),
//   2. drops the old single-account unique constraints (the old app created
//      constraint-backed indexes, which `prisma db push` cannot DROP INDEX),
//   3. creates the accounts/users tables and the bootstrap account + user.
//
// Pipe the output into psql against the production DATABASE_URL *before*
// `prisma db push` when baselining a pre-account schema (this is what the
// July 2026 prod rollout did). Idempotent: every statement is IF NOT EXISTS /
// ON CONFLICT DO NOTHING guarded, so re-runs are no-ops.
import { hashPassword, generateInviteCode } from "../app/lib/passwords.ts";
import { ulid } from "ulid";

const email = (process.env.APP_EMAIL ?? "").trim().toLowerCase();
const password = process.env.APP_PASSWORD ?? "";
if (!email || !password) {
  console.error("preflight-prod: APP_EMAIL and APP_PASSWORD must be set.");
  process.exit(1);
}

const accountId = ulid();
const userId = ulid();
const inviteCode = generateInviteCode();
const createdAt = new Date().toISOString();
const passwordHash = await hashPassword(password);

const tables = ["expenses", "reports", "categories", "settings", "mileage"];
const alters = tables
  .map(
    (t) =>
      `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "accountId" TEXT NOT NULL DEFAULT '${accountId}';`,
  )
  .join("\n");

process.stdout.write(`
-- Pre-flight for the Prisma baseline on a pre-account schema (idempotent).
${alters}

-- Drop the single-account unique constraints; db push recreates them as
-- (accountId, name). Must drop the CONSTRAINT (not just the index).
ALTER TABLE "reports"    DROP CONSTRAINT IF EXISTS "reports_name_key";
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_name_key";

-- Bootstrap account + user (matching prisma/migrations/0_init shape).
CREATE TABLE IF NOT EXISTS "accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_name_key" ON "accounts"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_inviteCode_key" ON "accounts"("inviteCode");

CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
-- The unique index below only makes sense once the username→email rename
-- (Step 4c in scripts/deploy) has happened. On a pre-email database
-- (username-era users table), the CREATE TABLE IF NOT EXISTS above is a
-- no-op and the column is still named "username" — creating the index would
-- fail. Guard it on the email column existing; Step 4c + db push create
-- users_email_key as part of the rename.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
  END IF;
END $$;

INSERT INTO "accounts" ("id", "name", "inviteCode", "createdAt")
VALUES ('${accountId}', '${email}', '${inviteCode}', '${createdAt}')
ON CONFLICT ("name") DO NOTHING;

-- Bootstrap the app's first user only when the users table is the email-era
-- shape (the pre-email username table is migrated by Step 4c + db push,
-- and initStore backfills the login from APP_EMAIL).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) THEN
    INSERT INTO "users" ("id", "accountId", "email", "passwordHash", "createdAt")
    VALUES ('${userId}', '${accountId}', '${email}', '${passwordHash}', '${createdAt}')
    ON CONFLICT ("email") DO NOTHING;
  END IF;
END $$;
`);
