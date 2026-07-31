import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

dotenv.configDotenv({ quiet: true });

// @see https://www.prisma.io/docs/orm/prisma-client/deployment/database-drivers
export default defineConfig({
  datasource: {
    get url() {
      return env("DATABASE_URL");
    },
    // Scratch database for `migrate diff --from-migrations` / `migrate dev`.
    get shadowDatabaseUrl() {
      return (
        process.env.SHADOW_DATABASE_URL ??
        "postgres://assaf@localhost/expensify_shadow"
      );
    },
  },
  migrations: {
    path: "prisma/migrations",
  },
  schema: "prisma/schema.prisma",
});
