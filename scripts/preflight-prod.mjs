// One-time baseline for a database created before the account migration.
// Reads APP_USERNAME/APP_PASSWORD (the bootstrap credentials) and emits
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

const username = process.env.APP_USERNAME ?? "";
const password = process.env.APP_PASSWORD ?? "";
if (!username || !password) {
  console.error("preflight-prod: APP_USERNAME and APP_PASSWORD must be set.");
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
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_key" ON "users"("username");

INSERT INTO "accounts" ("id", "name", "inviteCode", "createdAt")
VALUES ('${accountId}', '${username}', '${inviteCode}', '${createdAt}')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "users" ("id", "accountId", "username", "passwordHash", "name", "createdAt")
VALUES ('${userId}', '${accountId}', '${username}', '${passwordHash}', '${username}', '${createdAt}')
ON CONFLICT ("username") DO NOTHING;
`);
