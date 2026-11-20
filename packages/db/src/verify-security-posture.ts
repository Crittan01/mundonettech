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
  "TaxGroup",
  "Brand",
  "Category",
  "Collection",
  "CollectionProduct",
  "Product",
  "OptionDefinition",
  "OptionValue",
  "ProductVariant",
  "ProductVariantOption",
  "ProductMedia",
  "AttributeDefinition",
  "CategoryAttribute",
  "ProductAttributeValue",
  "CompatibilityDevice",
  "ProductCompatibility",
  "Bundle",
  "BundleItem",
  "WishlistItem",
  "BackInStockSubscription",
  "UrlRedirect",
] as const;
const dataApiRoles = ["anon", "authenticated", "service_role"] as const;
const nonBypassRoles = ["anon", "authenticated"] as const;
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
  "SecurityEvent_dedupMinute_matches",
  "TaxGroup_rateBps_valid",
  "TaxGroup_uvt_treatment_valid",
  "ProductVariant_price_nonnegative",
  "ProductVariant_cost_nonnegative",
  "ProductVariant_compare_order",
  "ProductMedia_variant_product_fkey",
  "ProductMedia_focal_valid",
  "ProductMedia_frames_valid",
  "ProductAttributeValue_exactly_one",
  "Bundle_price_nonnegative",
  "Bundle_discount_nonnegative",
  "Bundle_discount_valid",
  "BackInStockSubscription_status_timestamps",
  "UrlRedirect_status_valid",
] as const;
const requiredPartialIndexes = [
  "AdminUser_email_active_key",
  "AdminUser_authUserId_active_key",
  "Customer_email_active_key",
  "Customer_authUserId_active_key",
  "IntegrationCredential_provider_environment_accountName_key",
  "Brand_slug_active_key",
  "Category_slug_active_key",
  "Collection_slug_active_key",
  "Product_slug_active_key",
  "ProductVariant_sku_active_key",
  "ProductVariant_gtin_active_key",
  "ProductVariant_ean_active_key",
  "ProductVariant_one_default_active_key",
  "ProductMedia_storageKey_active_key",
  "AttributeDefinition_key_active_key",
  "CompatibilityDevice_slug_active_key",
  "Bundle_slug_active_key",
  "BackInStockSubscription_variantId_email_active_key",
  "UrlRedirect_fromPath_active_key",
] as const;
const requiredSecurityTriggers = [
  "AdminActionLog_append_only",
  "AdminActionLog_self_dealing",
  "AdminRecoveryCode_immutable_consumption",
  "Consent_append_only",
  "Consent_validate_revocation",
  "IntegrationCredential_immutable_identity",
  "SecurityEvent_append_only",
  "SecurityEvent_dedup_minute",
  "Category_maintain_tree",
  "ProductVariant_validate_identity",
  "ProductVariantOption_validate",
  "ProductAttributeValue_normalize",
  "UrlRedirect_validate",
  "Product_search_after_write",
  "Brand_search_after_write",
  "ProductVariant_search_after_write",
  "ProductAttributeValue_search_after_write",
  "AttributeDefinition_search_after_write",
] as const;
const requiredEventTriggers = [
  "enforce_rls_on_new_table",
  "revoke_postgrest_on_new_function",
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

    const roleFlags = await client.query<{
      role_name: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname AS role_name, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [nonBypassRoles],
    );
    for (const role of nonBypassRoles) {
      const row = roleFlags.rows.find((item) => item.role_name === role);
      if (!row || row.rolsuper || row.rolbypassrls) {
        errors.push(`Role ${role} must exist without SUPERUSER or BYPASSRLS.`);
      }
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

    const exposedPolicies = await client.query<{
      table_name: string;
      policy_name: string;
    }>(
      `SELECT cls.relname AS table_name, pol.polname AS policy_name
       FROM pg_policy pol
       JOIN pg_class cls ON cls.oid = pol.polrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public'
         AND (
           pol.polroles = '{0}'::oid[] OR
           EXISTS (
             SELECT 1 FROM pg_roles r
             WHERE r.oid = ANY(pol.polroles)
               AND r.rolname = ANY($1::text[])
           )
         )`,
      [dataApiRoles],
    );
    for (const row of exposedPolicies.rows) {
      errors.push(
        `Policy ${row.policy_name} on ${row.table_name} exposes public schema data to PUBLIC or Data API roles.`,
      );
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

    const relationPrivileges = await client.query<{
      role_name: string;
      relation_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS relation_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY[
         'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       ]) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege(role.oid, cls.oid, privilege)`,
      [dataApiRoles],
    );
    for (const row of relationPrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on ${row.relation_name}.`,
      );
    }

    const sequencePrivileges = await client.query<{
      role_name: string;
      sequence_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS sequence_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind = 'S'
         AND has_sequence_privilege(role.oid, cls.oid, privilege)`,
      [dataApiRoles],
    );
    for (const row of sequencePrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on sequence ${row.sequence_name}.`,
      );
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
      relation_name: string | null;
      function_name: string | null;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace ns
         CROSS JOIN LATERAL aclexplode(ns.nspacl) AS acl
         WHERE ns.nspname = 'public' AND acl.grantee = 0
           AND acl.privilege_type IN ('USAGE', 'CREATE')
       ) AS schema_usage,
       (SELECT cls.relname FROM pg_class cls
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND EXISTS (
            SELECT 1 FROM aclexplode(cls.relacl) AS acl
            WHERE acl.grantee = 0
          ) LIMIT 1) AS relation_name,
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
    if (publicRow?.schema_usage || publicRow?.relation_name || publicRow?.function_name) {
      const target = publicRow.relation_name ?? publicRow.function_name;
      errors.push(
        `PUBLIC retains schema, relation, or function privileges${target ? ` (${target})` : ""}.`,
      );
    }

    const eventTriggers = await client.query<{ name: string; enabled: string }>(
      "SELECT evtname AS name, evtenabled AS enabled FROM pg_event_trigger WHERE evtname = ANY($1::text[])",
      [requiredEventTriggers],
    );
    for (const requiredTrigger of requiredEventTriggers) {
      const trigger = eventTriggers.rows.find((item) => item.name === requiredTrigger);
      if (!trigger || trigger.enabled !== "O") {
        errors.push(`Event trigger ${requiredTrigger} is missing or disabled.`);
      }
    }

    const rowTriggers = await client.query<{ trigger_name: string; enabled: string }>(
      `SELECT tg.tgname AS trigger_name, tg.tgenabled AS enabled
       FROM pg_trigger tg
       JOIN pg_class cls ON cls.oid = tg.tgrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND NOT tg.tgisinternal
         AND tg.tgname = ANY($1::text[])`,
      [requiredSecurityTriggers],
    );
    for (const requiredTrigger of requiredSecurityTriggers) {
      const row = rowTriggers.rows.find((item) => item.trigger_name === requiredTrigger);
      if (!row || row.enabled !== "O") {
        errors.push(`Security trigger ${requiredTrigger} is missing or disabled.`);
      }
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
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])`,
      [[...requiredPartialIndexes, "Product_searchVector_idx"]],
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
    const searchGinIndex = indexes.rows.find(
      (row) => row.index_name === "Product_searchVector_idx",
    );
    if (!searchGinIndex || !/USING gin/i.test(searchGinIndex.index_definition)) {
      errors.push("Missing GIN full-text index Product_searchVector_idx.");
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
