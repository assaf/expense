import { Pool } from "pg";
import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "../../prisma/contract.d";
import contractJson from "../../prisma/contract.json" with { type: "json" };
import { DATABASE_URL } from "~/lib/env";

/**
 * Prisma 8 client (contract-first runtime). The contract lives at
 * prisma/contract.prisma; `prisma contract emit` writes contract.json +
 * contract.d.ts, and this module binds the runtime to a pg pool.
 * Queries go through `db.orm.<Model>` (typed ORM lane) or `db.sql.<table>`
 * (SQL builder lane); `db.transaction(fn)` replaces `$transaction`.
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
 * therefore carry `?sslmode=no-verify` (encrypt-only, matching the pooler's
 * long-standing behavior); local dev/test URLs omit it → no TLS.
 *
 * Serverless: every Vercel instance opens its own pg pool, so a burst of
 * concurrent requests multiplies connections per request. Prod connects
 * through Supabase's TRANSACTION-mode pooler (port 6543), which shares ONE
 * small backend pool across all clients. Keep the per-instance pool small
 * and release idle connections fast; the pooler's `pool_size` in the
 * Supabase dashboard must stay ≤ 80% of the DB's `max_connections`
 * (see docs/operations.md) or bursts fail with `(EMAXCONN)`.
 *
 * The pool is passed to the runtime via `pg:` (the façade's own `url` +
 * `poolOptions` shape only tunes timeouts, not `max`); db.close() does NOT
 * own this pool, so server code can rely on it living for the process.
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 4_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

const db = postgres<Contract>({
  contractJson,
  pg: pool,
  // Only log errors; match the old client's `log: ["error"]`.
  // (Prisma 8 surfaces middleware/telemetry separately; keep it off.)
});
export { db };
export default db;
