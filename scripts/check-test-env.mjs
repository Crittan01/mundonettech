import { assertSafeTestEnvironment } from "./lib/test-environment.mjs";

const env = {
  ...process.env,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
};
const database = assertSafeTestEnvironment(env);
console.log(
  `Safe test environment verified: PostgreSQL ${database.hostname}:${database.port}/${database.database}; outbound email disabled.`,
);
