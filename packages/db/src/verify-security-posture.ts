import { pathToFileURL } from "node:url";

import pg from "pg";

import { securityPostureManifest } from "./security-posture-manifest.js";

const dataApiRoles = ["anon", "authenticated", "service_role"] as const;
const postgrestRoles = [...dataApiRoles, "authenticator"] as const;
const requiredSearchPath = ["search_path=pg_catalog,public"] as const;
const monetaryColumnPattern =
  /(?:Cents$|^(?:price|cost|subtotal|total|discount|tax|fee|amount|balance|credit|revenue|proceeds|charge)$|(?:^|[a-z0-9])(?:Price|Cost|Subtotal|Total|Discount|Tax|Fee|Amount|Balance|Credit|Revenue|Proceeds|Charge)$)/;
const guardedNumericColumnPattern = /^.+$/u;

type ConstraintRow = {
  table: string;
  name: string;
  kind: string;
  columns: readonly string[];
  referencedTable: string | null;
  referencedColumns: readonly string[];
  deleteAction: string | null;
  validated: boolean;
  definition: string;
};

type FunctionRow = {
  identity: string;
  kind: string;
  securityDefiner: boolean;
  owner: string;
  searchPath: readonly string[];
};

type IndexRow = {
  name: string;
  table: string;
  method: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  columns: readonly string[];
  predicate: string | null;
  definition: string;
};

type TriggerRow = {
  table: string;
  name: string;
  function: string;
  timing: string;
  level: string;
  events: readonly string[];
  enabled: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  definition: string;
};

type EventTriggerRow = {
  name: string;
  event: string;
  function: string;
  enabled: string;
  platform: boolean;
};

function normalizeSql(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

type NonNegativeProof = "none" | "null" | "bound";

function stripOuterParentheses(expression: string): string {
  let result = expression.trim();
  for (;;) {
    if (!result.startsWith("(") || !result.endsWith(")")) return result;
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let wraps = true;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (quote) {
        if (character === quote) {
          if (result[index + 1] === quote) index += 1;
          else quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0 && index !== result.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps || depth !== 0) return result;
    result = result.slice(1, -1).trim();
  }
}

function splitTopLevelBoolean(expression: string, keyword: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  const boundary = (character: string | undefined): boolean =>
    character === undefined || !/[A-Za-z0-9_$]/u.test(character);

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === quote) {
        if (expression[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (
      depth === 0 &&
      expression.slice(index, index + keyword.length).toUpperCase() === keyword &&
      boundary(expression[index - 1]) &&
      boundary(expression[index + keyword.length])
    ) {
      parts.push(expression.slice(start, index));
      start = index + keyword.length;
      index = start - 1;
    }
  }
  if (parts.length === 0) return [expression];
  parts.push(expression.slice(start));
  return parts;
}

const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

function identifierName(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}

function numericLiteral(value: string): number | null {
  const withoutCast = stripOuterParentheses(value)
    .replace(/::\s*"?[A-Za-z_][A-Za-z0-9_ ."]*"?(?:\([0-9, ]+\))?\s*$/u, "")
    .trim();
  const normalized = stripOuterParentheses(withoutCast);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(normalized)) return null;
  return Number(normalized);
}

function nonNegativeAtom(expression: string, column: string): NonNegativeProof {
  const atom = stripOuterParentheses(expression);
  const nullMatch = new RegExp(`^(${sqlIdentifier})\\s+IS\\s+NULL$`, "iu").exec(atom);
  if (nullMatch?.[1] && identifierName(nullMatch[1]) === column) return "null";

  const anyArray = new RegExp(
    `^(${sqlIdentifier})\\s*=\\s*ANY\\s*\\(\\s*ARRAY\\s*\\[([\\s\\S]+)\\](?:::[A-Za-z_][A-Za-z0-9_ \\[\\]]*)?\\s*\\)$`,
    "iu",
  ).exec(atom);
  if (anyArray?.[1] && identifierName(anyArray[1]) === column) {
    const items = (anyArray[2] ?? "").split(",");
    if (
      items.length > 0 &&
      items.every((item) => {
        const literal = numericLiteral(item);
        return literal !== null && literal >= 0;
      })
    ) {
      return "bound";
    }
    return "none";
  }

  const direct = new RegExp(`^(${sqlIdentifier})\\s*(>=|>|<=|<|=)\\s*([\\s\\S]+)$`, "iu").exec(
    atom,
  );
  if (direct?.[1] && identifierName(direct[1]) === column) {
    const literal = numericLiteral(direct[3] ?? "");
    if (
      literal !== null &&
      literal >= 0 &&
      (direct[2] === ">=" || direct[2] === ">" || direct[2] === "=")
    ) {
      return "bound";
    }
    return "none";
  }

  const reversed = new RegExp(`^([\\s\\S]+?)\\s*(<=|<|>=|>|=)\\s*(${sqlIdentifier})$`, "iu").exec(
    atom,
  );
  if (reversed?.[3] && identifierName(reversed[3]) === column) {
    const literal = numericLiteral(reversed[1] ?? "");
    if (
      literal !== null &&
      literal >= 0 &&
      (reversed[2] === "<=" || reversed[2] === "<" || reversed[2] === "=")
    ) {
      return "bound";
    }
  }
  return "none";
}

function nonNegativeProof(expression: string, column: string): NonNegativeProof {
  const normalized = stripOuterParentheses(expression);
  const alternatives = splitTopLevelBoolean(normalized, "OR");
  if (alternatives.length > 1) {
    let proof: NonNegativeProof = "null";
    for (const alternative of alternatives) {
      const alternativeProof = nonNegativeProof(alternative, column);
      if (alternativeProof === "none") return "none";
      if (alternativeProof === "bound") proof = "bound";
    }
    return proof;
  }

  const conjunctions = splitTopLevelBoolean(normalized, "AND");
  if (conjunctions.length > 1) {
    let proof: NonNegativeProof = "none";
    for (const conjunction of conjunctions) {
      const conjunctionProof = nonNegativeProof(conjunction, column);
      if (conjunctionProof === "bound") return "bound";
      if (conjunctionProof === "null") proof = "null";
    }
    return proof;
  }
  return nonNegativeAtom(normalized, column);
}

export function constraintGuaranteesNonNegative(definition: string, column: string): boolean {
  const expression = definition.replace(/^\s*CHECK\s*/iu, "");
  return nonNegativeProof(expression, column) === "bound";
}

function canonicalConstraint(row: ConstraintRow): unknown {
  return { ...row, definition: normalizeSql(row.definition) };
}

function canonicalIndex(row: IndexRow): unknown {
  return {
    ...row,
    predicate: normalizeSql(row.predicate),
    definition: normalizeSql(row.definition),
  };
}

function canonicalTrigger(row: TriggerRow): unknown {
  return { ...row, definition: normalizeSql(row.definition) };
}

function compareExact<Row>(
  errors: string[],
  label: string,
  expectedRows: readonly Row[],
  actualRows: readonly Row[],
  key: (row: Row) => string,
  canonical: (row: Row) => unknown = (row) => row,
): void {
  const expected = new Map<string, Row>();
  const actual = new Map<string, Row>();

  for (const row of expectedRows) {
    const rowKey = key(row);
    if (expected.has(rowKey)) errors.push(`Duplicate ${label} manifest entry ${rowKey}.`);
    expected.set(rowKey, row);
  }
  for (const row of actualRows) {
    const rowKey = key(row);
    if (actual.has(rowKey)) errors.push(`Duplicate ${label} found: ${rowKey}.`);
    actual.set(rowKey, row);
  }

  for (const [rowKey, expectedRow] of expected) {
    const actualRow = actual.get(rowKey);
    if (!actualRow) {
      errors.push(`Missing ${label} ${rowKey}.`);
    } else if (JSON.stringify(canonical(expectedRow)) !== JSON.stringify(canonical(actualRow))) {
      errors.push(
        `${label} ${rowKey} differs: expected ${JSON.stringify(canonical(expectedRow))}; found ${JSON.stringify(canonical(actualRow))}.`,
      );
    }
  }
  for (const rowKey of actual.keys()) {
    if (!expected.has(rowKey)) errors.push(`Unexpected ${label} ${rowKey}.`);
  }
}

function compareSequence(
  errors: string[],
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  if (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  ) {
    return;
  }
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  errors.push(
    `${label} differs from its exact manifest (missing: ${JSON.stringify(missing)}; unexpected: ${JSON.stringify(extra)}; expected order: ${JSON.stringify(expected)}; actual order: ${JSON.stringify(actual)}).`,
  );
}

export async function verifySecurityPosture(
  databaseUrl: string,
  existingClient?: pg.Client,
): Promise<string[]> {
  const ownsClient = existingClient === undefined;
  const client =
    existingClient ??
    new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const errors: string[] = [];

  try {
    if (ownsClient) await client.connect();
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
      rolinherit: boolean;
    }>(
      `SELECT rolname AS role_name, rolsuper, rolbypassrls, rolinherit
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [postgrestRoles],
    );
    const platformRoles = await client.query<{ reserved_roles: string | null }>(
      "SELECT current_setting('supautils.reserved_roles', true) AS reserved_roles",
    );
    const reservedRoles = new Set(
      (platformRoles.rows[0]?.reserved_roles ?? "")
        .split(",")
        .map((entry) => entry.trim().replace(/\*$/u, ""))
        .filter(Boolean),
    );
    for (const role of dataApiRoles) {
      const row = roleFlags.rows.find((item) => item.role_name === role);
      const reservedBypass = role === "service_role" && reservedRoles.has(role);
      if (!row || row.rolsuper || (row.rolbypassrls && !reservedBypass)) {
        errors.push(
          `Role ${role} must exist without SUPERUSER or BYPASSRLS${role === "service_role" ? " unless BYPASSRLS is explicitly reserved by supautils for service_role" : ""}.`,
        );
      }
    }
    const authenticatorRole = roleFlags.rows.find((item) => item.role_name === "authenticator");
    if (
      authenticatorRole &&
      (authenticatorRole.rolsuper || authenticatorRole.rolbypassrls || authenticatorRole.rolinherit)
    ) {
      errors.push("Role authenticator must not have SUPERUSER, BYPASSRLS, or INHERIT.");
    }

    const dataApiMemberships = await client.query<{ member_name: string; role_name: string }>(
      `SELECT member_role.rolname AS member_name, granted_role.rolname AS role_name
       FROM pg_auth_members membership
       JOIN pg_roles member_role ON member_role.oid = membership.member
       JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
       WHERE member_role.rolname = ANY($1::text[])
       ORDER BY member_role.rolname, granted_role.rolname`,
      [dataApiRoles],
    );
    for (const row of dataApiMemberships.rows) {
      errors.push(`Role ${row.member_name} must not hold membership in role ${row.role_name}.`);
    }

    if (authenticatorRole) {
      const authenticatorMemberships = await client.query<{ role_name: string }>(
        `SELECT granted_role.rolname AS role_name
         FROM pg_auth_members membership
         JOIN pg_roles member_role ON member_role.oid = membership.member
         JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
         WHERE member_role.rolname = 'authenticator'
           AND NOT (granted_role.rolname = ANY($1::text[]))
         ORDER BY granted_role.rolname`,
        [dataApiRoles],
      );
      for (const row of authenticatorMemberships.rows) {
        errors.push(`Role authenticator holds unexpected membership in role ${row.role_name}.`);
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
    compareSequence(
      errors,
      "Protected table set",
      securityPostureManifest.tables,
      tables.rows.map((row) => row.table_name),
    );
    for (const table of tables.rows) {
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
       ORDER BY cls.relname, pol.polname`,
    );
    for (const row of exposedPolicies.rows) {
      errors.push(
        `Policy ${row.policy_name} on ${row.table_name} violates deny-by-default zero-policy posture on schema public.`,
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
      [postgrestRoles],
    );
    for (const role of dataApiRoles) {
      const row = schemaPrivileges.rows.find((item) => item.role_name === role);
      if (!row || row.has_usage || row.has_create) {
        errors.push(`PostgREST role ${role} retains public schema privileges.`);
      }
    }
    if (authenticatorRole) {
      const authSchema = schemaPrivileges.rows.find((item) => item.role_name === "authenticator");
      if (authSchema && (authSchema.has_usage || authSchema.has_create)) {
        errors.push("PostgREST role authenticator retains public schema privileges.");
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
         'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
       ]) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege(role.oid, cls.oid, privilege)
       ORDER BY role.rolname, cls.relname, privilege`,
      [postgrestRoles],
    );
    for (const row of relationPrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on ${row.relation_name}.`,
      );
    }

    const anyColumnPrivileges = await client.query<{
      role_name: string;
      relation_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS relation_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_any_column_privilege(role.oid, cls.oid, privilege)
       ORDER BY role.rolname, cls.relname, privilege`,
      [postgrestRoles],
    );
    for (const row of anyColumnPrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains column-level ${row.privilege} on ${row.relation_name}.`,
      );
    }

    const explicitColumnPrivileges = await client.query<{
      relation_name: string;
      column_name: string;
      grantee_name: string;
      privilege: string;
    }>(
      `SELECT cls.relname AS relation_name, att.attname AS column_name,
              COALESCE(grantee.rolname, 'PUBLIC') AS grantee_name, acl.privilege_type AS privilege
       FROM pg_attribute att
       JOIN pg_class cls ON cls.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL aclexplode(att.attacl) AS acl
       LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE ns.nspname = 'public'
         AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND att.attnum > 0 AND NOT att.attisdropped
         AND att.attacl IS NOT NULL
         AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))
       ORDER BY cls.relname, att.attname, grantee_name, acl.privilege_type`,
      [postgrestRoles],
    );
    for (const row of explicitColumnPrivileges.rows) {
      errors.push(
        `Role ${row.grantee_name} retains column privilege ${row.privilege} on ${row.relation_name}.${row.column_name}.`,
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
         AND has_sequence_privilege(role.oid, cls.oid, privilege)
       ORDER BY role.rolname, cls.relname, privilege`,
      [postgrestRoles],
    );
    for (const row of sequencePrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on sequence ${row.sequence_name}.`,
      );
    }

    const defaultAclExposure = await client.query<{
      grantor_name: string;
      object_type: string;
      grantee_name: string;
      privilege: string;
    }>(
      `SELECT grantor.rolname AS grantor_name, default_acl.defaclobjtype AS object_type,
              COALESCE(grantee.rolname, 'PUBLIC') AS grantee_name, acl.privilege_type AS privilege
       FROM pg_default_acl default_acl
       JOIN pg_namespace ns ON ns.oid = default_acl.defaclnamespace
       JOIN pg_roles grantor ON grantor.oid = default_acl.defaclrole
       CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
       LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE ns.nspname = 'public'
         AND grantor.rolname <> 'supabase_admin'
         AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))
       ORDER BY grantor.rolname, default_acl.defaclobjtype, grantee_name, acl.privilege_type`,
      [postgrestRoles],
    );
    for (const row of defaultAclExposure.rows) {
      errors.push(
        `Default privilege in public from ${row.grantor_name} exposes ${row.object_type} (${row.privilege}) to ${row.grantee_name}.`,
      );
    }

    const allowedExtensionNames = securityPostureManifest.requiredExtensions.map(
      (extension) => extension.name,
    );
    const installedExtensions = await client.query<{ name: string; schema: string }>(
      `SELECT extension.extname AS name, ns.nspname AS schema
       FROM pg_extension extension
       JOIN pg_namespace ns ON ns.oid = extension.extnamespace
       WHERE extension.extname = ANY($1::text[])`,
      [allowedExtensionNames],
    );
    for (const required of securityPostureManifest.requiredExtensions) {
      const installed = installedExtensions.rows.find(
        (extension) => extension.name === required.name,
      );
      if (!installed) {
        errors.push(`Required PostgreSQL extension ${required.name} is not installed.`);
      } else if (!required.allowedSchemas.some((schema) => schema === installed.schema)) {
        errors.push(
          `Extension ${required.name} must be installed in public or extensions; found ${installed.schema}.`,
        );
      }
    }

    const unexpectedPublicExtensions = await client.query<{ name: string }>(
      `SELECT extension.extname AS name
       FROM pg_extension extension
       JOIN pg_namespace ns ON ns.oid = extension.extnamespace
       WHERE ns.nspname = 'public'
         AND NOT (extension.extname = ANY($1::text[]))
       ORDER BY extension.extname`,
      [allowedExtensionNames],
    );
    for (const row of unexpectedPublicExtensions.rows) {
      errors.push(`Unexpected PostgreSQL extension ${row.name} is installed in schema public.`);
    }

    const functions = await client.query<FunctionRow>(
      `SELECT proc.oid::regprocedure::text AS identity, proc.prokind AS kind,
              proc.prosecdef AS "securityDefiner", role.rolname AS owner,
              COALESCE((
                SELECT array_agg('search_path=' || regexp_replace(split_part(config, '=', 2), '\\s+', '', 'g'))
                FROM unnest(proc.proconfig) AS config
                WHERE config LIKE 'search_path=%'
              ), '{}'::text[]) AS "searchPath"
       FROM pg_proc proc
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       JOIN pg_roles role ON role.oid = proc.proowner
       WHERE ns.nspname = 'public'
         AND NOT EXISTS (
           SELECT 1
           FROM pg_depend dependency
           JOIN pg_extension extension ON extension.oid = dependency.refobjid
           WHERE dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = proc.oid
             AND dependency.deptype = 'e'
             AND dependency.refclassid = 'pg_extension'::regclass
             AND extension.extname = ANY($1::text[])
         )
       ORDER BY identity`,
      [allowedExtensionNames],
    );
    compareExact(
      errors,
      "public function",
      securityPostureManifest.functions,
      functions.rows,
      (row) => row.identity,
    );
    for (const row of functions.rows) {
      if (
        row.searchPath.length !== requiredSearchPath.length ||
        row.searchPath.some((value, index) => value !== requiredSearchPath[index])
      ) {
        errors.push(
          `Public function ${row.identity} must have a fixed search_path of pg_catalog,public.`,
        );
      }
    }

    const functionPrivileges = await client.query<{ role_name: string; function_name: string }>(
      `SELECT role.rolname AS role_name, proc.proname AS function_name
       FROM pg_roles role
       CROSS JOIN pg_proc proc
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public'
         AND has_function_privilege(role.oid, proc.oid, 'EXECUTE')
       ORDER BY role.rolname, proc.proname`,
      [postgrestRoles],
    );
    for (const row of functionPrivileges.rows) {
      errors.push(`PostgREST role ${row.role_name} can execute ${row.function_name}.`);
    }

    const publicSchemaPrivileges = await client.query<{
      has_usage: boolean;
      has_create: boolean;
    }>(
      `SELECT has_schema_privilege('public', 'public', 'USAGE') AS has_usage,
              has_schema_privilege('public', 'public', 'CREATE') AS has_create`,
    );
    const publicSchemaRow = publicSchemaPrivileges.rows[0];
    if (publicSchemaRow && (publicSchemaRow.has_usage || publicSchemaRow.has_create)) {
      errors.push("PUBLIC retains schema privileges on public.");
    }

    const publicRelationPrivileges = await client.query<{
      relation_name: string;
      privilege: string;
    }>(
      `SELECT cls.relname AS relation_name, acl.privilege_type AS privilege
       FROM pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL aclexplode(cls.relacl) AS acl
       WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND acl.grantee = 0
       ORDER BY cls.relname, acl.privilege_type`,
    );
    for (const row of publicRelationPrivileges.rows) {
      errors.push(`PUBLIC retains ${row.privilege} on relation ${row.relation_name}.`);
    }

    const publicFunctionPrivileges = await client.query<{ function_name: string }>(
      `SELECT proc.oid::regprocedure::text AS function_name
       FROM pg_proc proc
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       WHERE ns.nspname = 'public'
         AND (
           proc.proacl IS NULL OR EXISTS (
             SELECT 1 FROM aclexplode(proc.proacl) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           )
         )
       ORDER BY function_name`,
    );
    for (const row of publicFunctionPrivileges.rows) {
      errors.push(`PUBLIC retains EXECUTE on routine ${row.function_name}.`);
    }

    const eventTriggers = await client.query<EventTriggerRow>(
      `SELECT evt.evtname AS name, evt.evtevent AS event,
              ns.nspname || '.' || regexp_replace(
                evt.evtfoid::regprocedure::text, '^' || ns.nspname || '\\.', ''
              ) AS function,
              evt.evtenabled AS enabled,
              ns.nspname <> 'public' AS platform
       FROM pg_event_trigger evt
       JOIN pg_proc proc ON proc.oid = evt.evtfoid
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       ORDER BY evt.evtname`,
    );
    const supabasePlatform = await client.query<{ present: boolean }>(
      "SELECT to_regrole('supabase_admin') IS NOT NULL AND to_regprocedure('extensions.pgrst_ddl_watch()') IS NOT NULL AS present",
    );
    const expectedEventTriggers = securityPostureManifest.eventTriggers.filter(
      (trigger) => supabasePlatform.rows[0]?.present === true || !trigger.platform,
    );
    compareExact(
      errors,
      "event trigger",
      expectedEventTriggers,
      eventTriggers.rows,
      (row) => row.name,
    );
    for (const eventTrigger of eventTriggers.rows) {
      if (eventTrigger.enabled !== "O") {
        errors.push(
          `Event trigger ${eventTrigger.name} is not enabled in origin mode (found ${eventTrigger.enabled}).`,
        );
      }
    }

    const triggers = await client.query<TriggerRow>(
      `SELECT cls.relname AS table, tg.tgname AS name,
              tg.tgfoid::regprocedure::text AS function,
              CASE WHEN tg.tgtype & 64 <> 0 THEN 'INSTEAD OF'
                   WHEN tg.tgtype & 2 <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
              CASE WHEN tg.tgtype & 1 <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS level,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN tg.tgtype & 4 <> 0 THEN 'INSERT' END,
                CASE WHEN tg.tgtype & 8 <> 0 THEN 'DELETE' END,
                CASE WHEN tg.tgtype & 16 <> 0 THEN 'UPDATE' END,
                CASE WHEN tg.tgtype & 32 <> 0 THEN 'TRUNCATE' END
              ], NULL) AS events,
              tg.tgenabled AS enabled, tg.tgdeferrable AS deferrable,
              tg.tginitdeferred AS "initiallyDeferred",
              pg_get_triggerdef(tg.oid, true) AS definition
       FROM pg_trigger tg
       JOIN pg_class cls ON cls.oid = tg.tgrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND NOT tg.tgisinternal
       ORDER BY cls.relname, tg.tgname`,
    );
    compareExact(
      errors,
      "row trigger",
      securityPostureManifest.triggers,
      triggers.rows,
      (row) => `${row.table}.${row.name}`,
      canonicalTrigger,
    );
    for (const trigger of triggers.rows) {
      if (trigger.enabled !== "O") {
        errors.push(
          `Trigger ${trigger.table}.${trigger.name} is not enabled in origin mode (found ${trigger.enabled}).`,
        );
      }
    }

    const constraints = await client.query<ConstraintRow>(
      `SELECT cls.relname AS table, con.conname AS name, con.contype AS kind,
              COALESCE((
                SELECT array_agg(att.attname::text ORDER BY keys.ordinality)
                FROM unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ordinality)
                JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = keys.attnum
              ), '{}'::text[]) AS columns,
              refcls.relname AS "referencedTable",
              COALESCE((
                SELECT array_agg(att.attname::text ORDER BY keys.ordinality)
                FROM unnest(con.confkey) WITH ORDINALITY AS keys(attnum, ordinality)
                JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = keys.attnum
              ), '{}'::text[]) AS "referencedColumns",
              CASE con.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
              END AS "deleteAction",
              con.convalidated AS validated,
              pg_get_constraintdef(con.oid, true) AS definition
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       LEFT JOIN pg_class refcls ON refcls.oid = con.confrelid
       WHERE ns.nspname = 'public' AND con.contype IN ('c', 'f')
       ORDER BY cls.relname, con.conname`,
    );
    compareExact(
      errors,
      "constraint",
      securityPostureManifest.constraints,
      constraints.rows,
      (row) => `${row.table}.${row.name}`,
      canonicalConstraint,
    );
    for (const constraint of constraints.rows) {
      if (!constraint.validated) {
        errors.push(`Constraint ${constraint.table}.${constraint.name} is not validated.`);
      }
    }

    const numericColumns = await client.query<{ table: string; column: string; type: string }>(
      `SELECT cls.relname AS table, att.attname AS column, typ.typname AS type
       FROM pg_attribute att
       JOIN pg_class cls ON cls.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       JOIN pg_type typ ON typ.oid = att.atttypid
       WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p')
         AND cls.relname <> '_prisma_migrations'
         AND att.attnum > 0 AND NOT att.attisdropped
         AND typ.typname IN ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8')
       ORDER BY cls.relname, att.attname`,
    );
    const signedColumns = new Set(
      securityPostureManifest.signedColumns.map((row) => `${row.table}.${row.column}`),
    );
    const guardedColumns = new Set<string>();
    for (const row of numericColumns.rows) {
      const key = `${row.table}.${row.column}`;
      if (monetaryColumnPattern.test(row.column) && row.type !== "int8") {
        errors.push(
          `Monetary column ${key} must use int8 (BIGINT) COP cents instead of ${row.type}.`,
        );
      }
      if (!guardedNumericColumnPattern.test(row.column)) continue;
      guardedColumns.add(key);
      if (signedColumns.has(key)) continue;
      const hasNonNegativeCheck = constraints.rows.some(
        (constraint) =>
          constraint.kind === "c" &&
          constraint.validated === true &&
          constraint.table === row.table &&
          constraintGuaranteesNonNegative(constraint.definition, row.column),
      );
      if (!hasNonNegativeCheck) {
        errors.push(`Monetary/stock column ${key} has no semantic non-negative CHECK coverage.`);
      }
    }
    for (const key of signedColumns) {
      if (!guardedColumns.has(key)) {
        errors.push(`Signed numeric exception ${key} no longer exists.`);
      }
    }

    const indexes = await client.query<IndexRow>(
      `SELECT idx.relname AS name, cls.relname AS table, am.amname AS method,
              indexdef.indisunique AS unique, indexdef.indisvalid AS valid,
              indexdef.indisready AS ready,
              ARRAY(
                SELECT pg_get_indexdef(indexdef.indexrelid, keys.position, true)
                FROM generate_series(1, indexdef.indnkeyatts) AS keys(position)
              ) AS columns,
              pg_get_expr(indexdef.indpred, indexdef.indrelid, true) AS predicate,
              pg_get_indexdef(indexdef.indexrelid) AS definition
       FROM pg_index indexdef
       JOIN pg_class idx ON idx.oid = indexdef.indexrelid
       JOIN pg_class cls ON cls.oid = indexdef.indrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       JOIN pg_am am ON am.oid = idx.relam
       WHERE ns.nspname = 'public'
       ORDER BY idx.relname`,
    );
    compareExact(
      errors,
      "index",
      securityPostureManifest.indexes,
      indexes.rows,
      (row) => row.name,
      canonicalIndex,
    );
    for (const row of indexes.rows) {
      if (!row.valid || !row.ready) {
        errors.push(`Index ${row.name} on ${row.table} is not valid and ready.`);
      }
    }

    const migrations = await client.query<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(
      `SELECT migration_name, finished_at, rolled_back_at
       FROM _prisma_migrations ORDER BY migration_name`,
    );
    const appliedMigrations = migrations.rows.filter(
      (row) => row.finished_at !== null && row.rolled_back_at === null,
    );
    compareSequence(
      errors,
      "Prisma migration sequence",
      securityPostureManifest.migrations,
      appliedMigrations.map((row) => row.migration_name),
    );
    if (migrations.rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) {
      errors.push("The Prisma migration chain contains an unfinished migration.");
    }
    if (migrations.rows.some((row) => row.finished_at !== null && row.rolled_back_at !== null)) {
      errors.push("The Prisma migration chain contains an applied migration marked rolled back.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Unknown database verification error.");
  } finally {
    if (ownsClient) await client.end().catch(() => undefined);
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
      `Database security posture verified on PostgreSQL 17: ${securityPostureManifest.tables.length} protected tables.`,
    );
  }
}
