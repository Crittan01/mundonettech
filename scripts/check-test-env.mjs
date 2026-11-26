import { assertSafeTestEnvironment } from "./lib/test-environment.mjs";

const databaseUrl =
  process.env.TEST_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const database = assertSafeTestEnvironment(process.env, databaseUrl);
console.log(
  `Safe test environment verified: PostgreSQL ${database.hostname}:${database.port}/${database.database}; outbound email disabled.`,
);
