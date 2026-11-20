import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { acquireIsolatedTestDatabase } from "./lib/postgres-test-harness.mjs";
import { assertSafeTestDatabase } from "./lib/test-environment.mjs";
import { catalogTables, seedCatalogFixture } from "./lib/catalog-test-fixture.mjs";

const expectedTables = [
  "AdminUser",
  "AdminRecoveryCode",
  "AdminActionLog",
  "SecurityEvent",
  "Customer",
  "Consent",
  "IntegrationCredential",
  "DomainOutbox",
  "IdempotencyKey",
  ...catalogTables,
];

const dataApiRoles = ["anon", "authenticated", "service_role"];

const rpcProbes = [
  {
    name: "consume_admin_recovery_code",
    sql: "SELECT public.consume_admin_recovery_code(NULL, NULL)",
  },
  {
    name: "claim_domain_outbox",
    sql: "SELECT * FROM public.claim_domain_outbox('rls-probe', 1)",
  },
  {
    name: "complete_domain_outbox",
    sql: "SELECT public.complete_domain_outbox(NULL, 'rls-probe')",
  },
  {
    name: "retry_domain_outbox",
    sql: "SELECT public.retry_domain_outbox(NULL, 'rls-probe', CURRENT_TIMESTAMP + INTERVAL '1 minute', 'err')",
  },
  {
    name: "acquire_idempotency_key",
    sql: "SELECT * FROM public.acquire_idempotency_key('probe', NULL, NULL, NULL, CURRENT_TIMESTAMP + INTERVAL '1 minute')",
  },
  {
    name: "complete_idempotency_key",
    sql: "SELECT public.complete_idempotency_key('probe', NULL, NULL, NULL, 'FAILED', 500, NULL, NULL)",
  },
  {
    name: "purge_expired_idempotency_keys",
    sql: "SELECT public.purge_expired_idempotency_keys(1)",
  },
  {
    name: "validate_gs1_check_digit",
    sql: "SELECT public.validate_gs1_check_digit('5901234123457')",
  },
  {
    name: "normalize_redirect_path",
    sql: "SELECT public.normalize_redirect_path('/origen')",
  },
  {
    name: "immutable_unaccent",
    sql: "SELECT public.immutable_unaccent('táctil')",
  },
  {
    name: "refresh_product_search_vector",
    sql: "SELECT public.refresh_product_search_vector(NULL)",
  },
];

async function verifySchemaCoverage(client) {
  const publicTables = await client.query(
    `SELECT cls.relname AS table_name
     FROM pg_class cls
     JOIN pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE ns.nspname = 'public'
       AND cls.relkind IN ('r', 'p')
       AND cls.relname <> '_prisma_migrations'
     ORDER BY cls.relname`,
  );
  const discovered = publicTables.rows.map((row) => row.table_name);
  const expectedSorted = [...expectedTables].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `RLS matrix table coverage mismatch. Expected [${expectedSorted.join(", ")}], found [${discovered.join(", ")}].`,
    );
  }
}

async function ensureMatrixFixtures(client) {
  const adminId = randomUUID();
  await client.query(
    `INSERT INTO public."AdminUser" ("id", "authUserId", "email", "displayName", "role", "status")
     VALUES ($1, $2, $3, 'RLS Matrix Probe', 'SUPERADMIN', 'ACTIVE')`,
    [adminId, randomUUID(), `rls-admin-${randomUUID()}@example.test`],
  );

  await client.query(
    `INSERT INTO public."AdminRecoveryCode" ("adminUserId", "codeHash", "expiresAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
    [adminId, randomBytes(32)],
  );

  await client.query(
    `INSERT INTO public."AdminActionLog" ("actorAdminUserId", "targetAdminUserId", "action", "targetType", "metadata")
     VALUES ($1, $1, 'RLS_MATRIX_SEED', 'AdminUser', '{"matrix":true}'::jsonb)`,
    [adminId],
  );

  await client.query(
    `INSERT INTO public."SecurityEvent" ("adminUserId", "eventType", "ipHash", "metadata")
     VALUES ($1, 'RLS_MATRIX_SEED', $2, '{"matrix":true}'::jsonb)`,
    [adminId, randomBytes(32)],
  );

  const customerId = randomUUID();
  await client.query(
    `INSERT INTO public."Customer" ("id", "authUserId", "email", "status")
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [customerId, randomUUID(), `rls-customer-${randomUUID()}@example.test`],
  );

  await client.query(
    `INSERT INTO public."Consent" ("customerId", "purpose", "status", "source", "policyVersion", "proofHash")
     VALUES ($1, 'DATA_PROCESSING', 'GRANTED', 'rls-matrix', 'v1', $2)`,
    [customerId, randomBytes(32)],
  );

  await client.query(
    `INSERT INTO public."IntegrationCredential" (
       "provider", "environment", "accountName", "keyVersion", "nonce", "ciphertext", "authTag", "createdByAdminUserId"
     ) VALUES ($1, 'LOCAL', 'matrix', 1, $2, $3, $4, $5)`,
    [
      `matrix-${randomUUID().slice(0, 8)}`,
      randomBytes(12),
      randomBytes(32),
      randomBytes(16),
      adminId,
    ],
  );

  await client.query(
    `INSERT INTO public."DomainOutbox" ("eventType", "aggregateType", "aggregateId", "deduplicationKey", "payload")
     VALUES ('RlsMatrixProbe', 'Matrix', $1, $2, '{"matrix":true}'::jsonb)`,
    [randomUUID(), `matrix-${randomUUID()}`],
  );

  await client.query(
    `INSERT INTO public."IdempotencyKey" ("scope", "keyHash", "subjectHash", "requestHash", "expiresAt")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
    [`matrix-${randomUUID()}`, randomBytes(32), randomBytes(32), randomBytes(32)],
  );

  await seedCatalogFixture(client);

  for (const table of expectedTables) {
    const count = await client.query(`SELECT count(*)::int AS count FROM public."${table}"`);
    if ((count.rows[0]?.count ?? 0) < 1) {
      throw new Error(`RLS matrix requires at least one row in ${table}.`);
    }
  }
}

export async function runRlsMatrix(databaseUrl) {
  assertSafeTestDatabase(databaseUrl, { ci: process.env.CI === "true" });
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const grantedRole = `matrix_${randomBytes(5).toString("hex")}`;
  const results = [];
  await client.connect();

  async function inSavepoint(entry, callback) {
    await client.query("SAVEPOINT rls_case");
    try {
      await callback();
      results.push({ ...entry, passed: true });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT rls_case");
      await client.query("RELEASE SAVEPOINT rls_case");
    }
  }

  async function expectPermissionDenied(promise, description) {
    let denied = false;
    try {
      await promise;
    } catch (error) {
      denied = error?.code === "42501";
    }
    if (!denied) {
      throw new Error(`${description} was not denied with SQLSTATE 42501.`);
    }
  }

  try {
    await verifySchemaCoverage(client);
    await client.query("SET createrole_self_grant = 'set'");
    await client.query(`CREATE ROLE ${grantedRole} NOLOGIN NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${grantedRole}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${grantedRole}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.validate_gs1_check_digit(TEXT), public.normalize_redirect_path(TEXT) TO ${grantedRole}`,
    );

    await client.query("BEGIN");
    try {
      await ensureMatrixFixtures(client);

      for (const table of expectedTables) {
        await inSavepoint({ role: grantedRole, table, operation: "SELECT" }, async () => {
          await client.query(`SET ROLE ${grantedRole}`);
          const selected = await client.query(`SELECT * FROM public."${table}"`);
          if (selected.rows.length !== 0) throw new Error(`${table}: SELECT leaked rows.`);
        });

        await inSavepoint(
          { role: grantedRole, table, operation: "SELECT_FOR_UPDATE" },
          async () => {
            await client.query(`SET ROLE ${grantedRole}`);
            const locked = await client.query(`SELECT * FROM public."${table}" FOR UPDATE`);
            if (locked.rows.length !== 0)
              throw new Error(`${table}: SELECT FOR UPDATE leaked rows.`);
          },
        );

        await inSavepoint({ role: grantedRole, table, operation: "UPDATE" }, async () => {
          await client.query(`SET ROLE ${grantedRole}`);
          const updated = await client.query(`UPDATE public."${table}" SET "id" = "id"`);
          if (updated.rowCount !== 0) throw new Error(`${table}: UPDATE modified rows.`);
        });

        await inSavepoint({ role: grantedRole, table, operation: "DELETE" }, async () => {
          await client.query(`SET ROLE ${grantedRole}`);
          const deleted = await client.query(`DELETE FROM public."${table}"`);
          if (deleted.rowCount !== 0) throw new Error(`${table}: DELETE removed rows.`);
        });

        await inSavepoint({ role: grantedRole, table, operation: "INSERT" }, async () => {
          await client.query(
            `CREATE TEMP TABLE matrix_source ON COMMIT DROP AS SELECT * FROM public."${table}" LIMIT 1`,
          );
          await client.query(`GRANT SELECT ON pg_temp.matrix_source TO ${grantedRole}`);
          await client.query(`SET ROLE ${grantedRole}`);
          let rlsDenied = false;
          let denialError;
          try {
            await client.query(`INSERT INTO public."${table}" SELECT * FROM pg_temp.matrix_source`);
          } catch (error) {
            denialError = error;
            rlsDenied = error?.code === "42501" && /row-level security/i.test(error?.message ?? "");
          }
          if (!rlsDenied)
            throw new Error(
              `${table}: INSERT was not denied by RLS. ${denialError?.code ?? "no-error"}: ${denialError?.message ?? "insert succeeded"}`,
            );
        });

        for (const apiRole of dataApiRoles) {
          for (const [operation, sql] of [
            ["SELECT", `SELECT * FROM public."${table}"`],
            ["UPDATE", `UPDATE public."${table}" SET "id" = "id"`],
            ["DELETE", `DELETE FROM public."${table}"`],
            ["INSERT", `INSERT INTO public."${table}" SELECT * FROM pg_temp.matrix_source`],
          ]) {
            await inSavepoint({ role: apiRole, table, operation }, async () => {
              if (operation === "INSERT") {
                await client.query(
                  `CREATE TEMP TABLE matrix_source ON COMMIT DROP AS SELECT * FROM public."${table}" LIMIT 1`,
                );
                await client.query(`GRANT SELECT ON pg_temp.matrix_source TO ${apiRole}`);
              }
              await client.query(`SET ROLE ${apiRole}`);
              await expectPermissionDenied(client.query(sql), `${apiRole} ${operation} ${table}`);
            });
          }
        }
      }

      for (const apiRole of dataApiRoles) {
        for (const rpc of rpcProbes) {
          await inSavepoint({ role: apiRole, table: rpc.name, operation: "EXECUTE" }, async () => {
            await client.query(`SET ROLE ${apiRole}`);
            await expectPermissionDenied(client.query(rpc.sql), `${apiRole} EXECUTE ${rpc.name}`);
          });
        }
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    await client
      .query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${grantedRole}`)
      .catch(() => undefined);
    await client
      .query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${grantedRole}`)
      .catch(() => undefined);
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${grantedRole}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${grantedRole}`).catch(() => undefined);
    await client.end();
  }

  const rlsOperations = results.filter((item) => item.role === grantedRole).length;
  const dataApiOperations = results.length - rlsOperations;
  return {
    tables: expectedTables.length,
    functions: rpcProbes.length,
    rlsOperations,
    dataApiOperations,
    operations: results.length,
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const harness = await acquireIsolatedTestDatabase({
    containerName: "rls-matrix-test_mundonettech",
    port: 54428,
    allowDatabaseUrlFallback: true,
    migrate: !process.env.DATABASE_URL || Boolean(process.env.TEST_DATABASE_URL),
  });
  try {
    const summary = await runRlsMatrix(harness.databaseUrl);
    console.log(
      `RLS matrix passed: ${summary.tables} tables, ${summary.rlsOperations} forced-RLS SQL-grant denials + ${summary.dataApiOperations} Data API role denials = ${summary.operations} verified cases.`,
    );
  } finally {
    await harness.stop();
  }
}
