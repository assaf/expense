import { existsSync } from "node:fs";
import "node:process";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";

// Prisma 8 (contract-first). The contract lives at prisma/contract.prisma;
// `prisma contract emit` writes contract.json + contract.d.ts next to it.
// Runtime connection for the app is owned by app/lib/prisma.server.ts
// (own pg.Pool: Supabase transaction pooler needs max: 2, see
// docs/operations.md). The `connection` here serves CLI commands
// (db update / db sign / db migrate) — DDL flows use
// DATABASE_URL_UNPOOLED (session pooler) per docs/operations.md.
// Load the local .env for CLI commands (existing vars win, dotenv-style).
// Vercel and CI inject env vars directly and ship no .env file; skip when
// absent, since loadEnvFile throws if the file is missing. Mirrors
// app/lib/env.ts, so the CLI and the app read the same file the same way.
if (existsSync(".env")) process.loadEnvFile(".env");

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./prisma/contract.prisma",
    db: {
      get connection() {
        // The app's connection URLs carry `?sslmode=no-verify` for
        // Supabase poolers. Pass through as-is; the Prisma 8 CLI
        // driver handles it directly (no pg wrapping for DDL
        // commands). Local/CI URLs have no sslmode and need none.
        return (
          process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? ""
        );
      },
    },
    migrations: {
      dir: "migrations",
    },
  }),
});
