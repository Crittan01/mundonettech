import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { assertSafeTestEnvironment } from "./lib/test-environment.mjs";

const tables = [
  "AdminUser",
  "AdminRecoveryCode",
  "AdminActionLog",
  "SecurityEvent",
  "Customer",
  "Consent",
  "IntegrationCredential",
  "DomainOutbox",
  "IdempotencyKey",
];

export async function runRlsMatrix(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const role = `matrix_${randomBytes(5).toString("hex")}`;
  const results = [];
  await client.connect();

  async function transaction(table, operation, callback) {
    await client.query("BEGIN");
    try {
      await client.query(
        `CREATE LOCAL TEMP TABLE matrix_source AS SELECT * FROM public."${table}" LIMIT 1`,
      );
      await client.query(`GRANT SELECT ON pg_temp.matrix_source TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      await callback();
      results.push({ table, operation, passed: true });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  }

  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );

    for (const table of tables) {
      const count = await client.query(`SELECT count(*)::int AS count FROM public."${table}"`);
      if ((count.rows[0]?.count ?? 0) < 1)
        throw new Error(`RLS matrix requires a persisted row in ${table}.`);

      await transaction(table, "SELECT", async () => {
        const selected = await client.query(`SELECT * FROM public."${table}"`);
        if (selected.rows.length !== 0) throw new Error(`${table}: SELECT leaked rows.`);
      });
      await transaction(table, "UPDATE", async () => {
        const updated = await client.query(`UPDATE public."${table}" SET "id" = "id"`);
        if (updated.rowCount !== 0) throw new Error(`${table}: UPDATE modified rows.`);
      });
      await transaction(table, "DELETE", async () => {
        const deleted = await client.query(`DELETE FROM public."${table}"`);
        if (deleted.rowCount !== 0) throw new Error(`${table}: DELETE removed rows.`);
      });
      await transaction(table, "INSERT", async () => {
        let denied = false;
        try {
          await client.query(`INSERT INTO public."${table}" SELECT * FROM pg_temp.matrix_source`);
        } catch (error) {
          denied = error?.code === "42501" && /row-level security/i.test(error?.message ?? "");
        }
        if (!denied) throw new Error(`${table}: INSERT was not denied by RLS.`);
      });
    }
  } finally {
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end();
  }

  return { tables: tables.length, operations: results.length, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl =
    assertSafeTestEnvironment() && (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
  const summary = await runRlsMatrix(databaseUrl);
  console.log(
    `RLS matrix passed: ${summary.tables} tables × 4 operations = ${summary.operations} denied cases.`,
  );
}
