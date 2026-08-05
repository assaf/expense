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
 * node-postgres reads `sslmode` from the connection string (Supabase
 * pooler URLs carry `?sslmode=require`); local dev/test URLs omit it → no TLS.
 *
 * Pool sizing matters here: prod connects through Supabase's session-mode
 * pooler, which caps total sessions (default pool_size 15). Every Vercel
 * serverless instance gets its own pool, so a burst of concurrent requests
 * (e.g. the image-heavy list page) can exhaust the cap with `(EMAXCONNSESSION)
 * max clients reached` 500s. Keep the per-instance pool small and release
 * idle sessions fast so slots recycle between requests; if you raise the
 * pooler's pool_size in the Supabase dashboard you can loosen `max` again.
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
