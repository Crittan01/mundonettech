import { defineConfig } from "prisma/config";

const localDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? localDatabaseUrl,
  },
});
