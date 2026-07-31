import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";

dotenv.configDotenv({ quiet: true });

// @see https://www.prisma.io/docs/orm/prisma-client/deployment/database-drivers
export default defineConfig({
  datasource: {
    get url() {
      return env("DATABASE_URL");
    },
  },
  migrations: {
    path: "prisma/migrations",
  },
  schema: "prisma/schema.prisma",
});
