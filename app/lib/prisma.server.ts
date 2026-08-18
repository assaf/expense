import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "prisma/generated";
import { DATABASE_URL } from "~/lib/env";

/**
 * Prisma client (driver adapter over node-postgres). The single database
 * connection for the app — schema comes from prisma/schema.prisma
 * (see `pnpm db:push` / `prisma migrate`), so there is no runtime DDL.
 */

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not configured — set it in .env / the deployment dashboard.",
  );
}

/**
 * node-postgres reads `sslmode` from the connection string. The Supabase
 * pooler REQUIRES TLS (ESSLREQUIRED without it) but its cert is signed by
 * Supabase's private CA (`Supabase Intermediate 2021 CA`), so
 * `sslmode=require`/`verify-full` FAIL with "self-signed certificate" on
 * pg >= 8.13 (sslmode=require no longer skips verification). Prod URLs
 * therefore carry `?sslmode=no-verify` (encrypt-only — matches the pooler's
 * long-standing behavior); local dev/test URLs omit it → no TLS.
 *
 * Serverless: every Vercel instance opens its own node-postgres pool, so a
 * burst of concurrent requests multiplies connections per request. Prod
 * connects through Supabase's TRANSACTION-mode pooler (port 6543), which
 * shares ONE small backend pool across all clients — connections are
 * checked out only for the duration of a query/transaction, so serverless
 * instances stop holding dedicated slots. Keep the per-instance pool small
 * and release idle connections fast; the pooler's `pool_size` in the
 * Supabase dashboard must stay ≤ 80% of the DB's `max_connections` (see
 * AGENTS.md "Database connections") or bursts fail with `(EMAXCONN)`.
 */
const adapter = new PrismaPg({
  connectionString: DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 4_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

export default new PrismaClient({
  adapter,
  errorFormat: "pretty",
  log: ["error"],
});
