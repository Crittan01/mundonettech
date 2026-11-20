import { pathToFileURL } from "node:url";

import pg from "pg";

const requiredTables = [
  "AdminUser",
  "AdminRecoveryCode",
  "AdminActionLog",
  "SecurityEvent",
  "Customer",
  "Consent",
  "IntegrationCredential",
  "DomainOutbox",
  "IdempotencyKey",
] as const;
const dataApiRoles = ["anon", "authenticated", "service_role"] as const;
const requiredConstraints = [
  "AdminRecoveryCode_codeHash_length",
  "AdminActionLog_metadata_object",
  "Customer_loyaltyPoints_nonnegative",
  "Consent_revocation_consistent",
  "IntegrationCredential_nonce_length",
  "IntegrationCredential_ciphertext_length",
  "IntegrationCredential_authTag_length",
  "DomainOutbox_claim_consistent",
  "IdempotencyKey_requestHash_length",
] as const;
const requiredPartialIndexes = [
  "AdminUser_email_active_key",
  "AdminUser_authUserId_active_key",
  "Customer_email_active_key",
  "Customer_authUserId_active_key",
  "IntegrationCredential_provider_environment_accountName_key",
] as const;

export async function verifySecurityPosture(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const errors: string[] = [];

  try {
    await client.connect();
    const version = await client.query<{ server_version: string; server_version_num: string }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    const versionRow = version.rows[0];
    if (
      !versionRow ||
      Number(versionRow.server_version_num) < 170000 ||
      Number(versionRow.server_version_num) >= 180000
    ) {
      errors.push(`PostgreSQL 17 is required; found ${versionRow?.server_version ?? "unknown"}.`);
    }

    const tables = await client.query<{
      table_name: string;
      row_security: boolean;
      force_row_security: boolean;
    }>(
      `SELECT cls.relname AS table_name, cls.relrowsecurity AS row_security,
              cls.relforcerowsecurity AS force_row_security
       FROM pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p')
         AND cls.relname <> '_prisma_migrations'
       ORDER BY cls.relname`,
    );
    const tableRows = tables.rows;

    for (const requiredTable of requiredTables) {
      const table = tableRows.find((row) => row.table_name === requiredTable);
      if (!table) {
        errors.push(`Missing required table ${requiredTable}.`);
      } else if (!table.row_security || !table.force_row_security) {
        errors.push(`${requiredTable} must have RLS enabled and forced.`);
      }
    }
    for (const table of tableRows) {
      if (!table.row_security || !table.force_row_security) {
        errors.push(`Public table ${table.table_name} is not deny-by-default.`);
      }
    }

    const schemaPrivileges = await client.query<{
      role_name: string;
      has_usage: boolean;
      has_create: boolean;
    }>(
      `SELECT role.rolname AS role_name,
              has_schema_privilege(role.oid, 'public', 'USAGE') AS has_usage,
              has_schema_privilege(role.oid, 'public', 'CREATE') AS has_create
       FROM pg_roles role WHERE role.rolname = ANY($1::text[])`,
      [dataApiRoles],
    );
    for (const role of dataApiRoles) {
      const row = schemaPrivileges.rows.find((item) => item.role_name === role);
      if (!row || row.has_usage || row.has_create) {
        errors.push(`PostgREST role ${role} retains public schema privileges.`);
      }
    }

    const tablePrivileges = await client.query<{
      role_name: string;
      table_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS table_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY[
         'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       ]) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind IN ('r', 'p')
         AND has_table_privilege(role.oid, cls.oid, privilege)`,
      [dataApiRoles],
    );
    for (const row of tablePrivileges.rows) {
      errors.push(`PostgREST role ${row.role_name} retains ${row.privilege} on ${row.table_name}.`);
    }

    const functionPrivileges = await client.query<{ role_name: string; function_name: string }>(
      `SELECT role.rolname AS role_name, proc.proname AS function_name
       FROM pg_roles role
       CROSS JOIN pg_proc proc
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public'
         AND has_function_privilege(role.oid, proc.oid, 'EXECUTE')`,
      [dataApiRoles],
    );
    for (const row of functionPrivileges.rows) {
      errors.push(`PostgREST role ${row.role_name} can execute ${row.function_name}.`);
    }

    const publicPrivileges = await client.query<{
      schema_usage: boolean;
      function_name: string | null;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace ns
         CROSS JOIN LATERAL aclexplode(ns.nspacl) AS acl
         WHERE ns.nspname = 'public' AND acl.grantee = 0
           AND acl.privilege_type IN ('USAGE', 'CREATE')
       ) AS schema_usage,
       (SELECT proc.proname FROM pg_proc proc
        JOIN pg_namespace ns ON ns.oid = proc.pronamespace
        WHERE ns.nspname = 'public' AND (
          proc.proacl IS NULL OR EXISTS (
            SELECT 1 FROM aclexplode(proc.proacl) AS acl
            WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          )
        ) LIMIT 1) AS function_name`,
    );
    const publicRow = publicPrivileges.rows[0];
    if (publicRow?.schema_usage || publicRow?.function_name) {
      errors.push(
        `PUBLIC retains schema usage or function execution${publicRow.function_name ? ` (${publicRow.function_name})` : ""}.`,
      );
    }

    const trigger = await client.query<{ enabled: string }>(
      "SELECT evtenabled AS enabled FROM pg_event_trigger WHERE evtname = 'enforce_rls_on_new_table'",
    );
    if (trigger.rows[0]?.enabled !== "O") {
      errors.push("The enforce_rls_on_new_table event trigger is missing or disabled.");
    }

    const constraints = await client.query<{ constraint_name: string }>(
      `SELECT conname AS constraint_name FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[])`,
      [requiredConstraints],
    );
    for (const required of requiredConstraints) {
      if (!constraints.rows.some((row) => row.constraint_name === required)) {
        errors.push(`Missing integrity constraint ${required}.`);
      }
    }

    const indexes = await client.query<{ index_name: string; index_definition: string }>(
      `SELECT indexname AS index_name, indexdef AS index_definition
       FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [requiredPartialIndexes],
    );
    for (const required of requiredPartialIndexes) {
      const index = indexes.rows.find((row) => row.index_name === required);
      if (
        !index ||
        !index.index_definition.startsWith("CREATE UNIQUE INDEX") ||
        !index.index_definition.includes(" WHERE ")
      ) {
        errors.push(`Missing partial unique index ${required}.`);
      }
    }

    const migrations = await client.query<{ total: number; healthy: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS healthy
       FROM _prisma_migrations`,
    );
    const migration = migrations.rows[0];
    if (!migration || migration.total === 0 || migration.total !== migration.healthy) {
      errors.push("The Prisma migration chain contains missing, failed, or rolled-back entries.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Unknown database verification error.");
  } finally {
    await client.end().catch(() => undefined);
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
  const errors = await verifySecurityPosture(databaseUrl);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      `Database security posture verified on PostgreSQL 17: ${requiredTables.length} protected tables.`,
    );
  }
}
