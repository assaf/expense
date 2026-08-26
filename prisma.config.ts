import "dotenv/config";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";

// Prisma 8 (contract-first). The contract lives at prisma/contract.prisma;
// `prisma contract emit` writes contract.json + contract.d.ts next to it.
// Runtime connection for the app is owned by app/lib/prisma.server.ts
// (own pg.Pool: Supabase transaction pooler needs max: 2, see
// docs/operations.md). The `connection` here serves CLI commands
// (db update / db sign / db migrate) — DDL flows use
// DATABASE_URL_UNPOOLED (session pooler) per docs/operations.md.
export default definePrismaConfig({
  orm: ormConfig({
    contract: "./prisma/contract.prisma",
    db: {
      get connection() {
        // The app's DATABASE_URL may carry `?sslmode=no-verify` for
        // Vercel ↔ Supabase transaction pooler (port 6543). The v8
        // driver interprets that as "no SSL" (unlike pg which encrypts
        // but skips cert verification), causing ESSLREQUIRED on the
        // session pooler (port 5432). CLI DDL commands always use the
        // session pooler, so rewrite to `sslmode=require`.
        const url =
          process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";
        const sep = url.includes("?") ? "&" : "?";
        if (url.includes("sslmode=")) {
          return url.replace(/sslmode=[^&]*/, "sslmode=require");
        }
        return `${url}${sep}sslmode=require`;
      },
    },
    migrations: {
      dir: "migrations",
    },
  }),
});
