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
 * node-postgres reads `sslmode` from the connection string (Neon/Vercel
 * prod URLs carry `?sslmode=require`); local dev/test URLs omit it → no TLS.
 */
const adapter = new PrismaPg({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: true,
});

export default new PrismaClient({
  adapter,
  errorFormat: "pretty",
  log: ["error"],
});
