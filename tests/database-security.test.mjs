import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  acquireIdempotencyKey,
  claimDomainOutbox,
  completeDomainOutbox,
  completeIdempotencyKey,
  consumeAdminRecoveryCode,
  createDatabaseClient,
  IdempotencyStatus,
  IntegrationEnvironment,
  purgeExpiredIdempotencyKeys,
  retryDomainOutbox,
} from "../packages/db/dist/index.js";
import {
  constraintGuaranteesNonNegative,
  verifySecurityPosture,
} from "../packages/db/dist/verify-security-posture.js";
import {
  CredentialAlreadyExistsError,
  CredentialConflictError,
  CredentialCursorError,
  CredentialDecryptionError,
  CredentialForbiddenError,
  CredentialNotFoundError,
  CredentialRevokedError,
  createCredentialKeyRing,
  IntegrationCredentialVault,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const containerName = "a3-security-test_mundonettech";
const probeRole = "f03_rls_probe";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
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
  "OperationRateLimit",
];

let harness;
let databaseUrl;
let admin;
let prisma;
let keyRing;
let vault;

async function withProbe(callback) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SET ROLE ${probeRole}`);

  try {
    return await callback(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function expectSqlViolation(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function runPostureMutation(statements, assertion) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await assertion(await verifySecurityPosture(databaseUrl, client));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function expectPostureMutation(statements, expectedMessages) {
  const expectedList = Array.isArray(expectedMessages) ? expectedMessages : [expectedMessages];
  await runPostureMutation(statements, (errors) => {
    for (const expectedMessage of expectedList) {
      assert.ok(
        errors.some((message) => message.includes(expectedMessage)),
        `expected posture failure containing ${expectedMessage}; found ${JSON.stringify(errors)}`,
      );
    }
  });
}

async function expectPostureMutationAllowed(statements) {
  await runPostureMutation(statements, (errors) => assert.deepEqual(errors, []));
}

async function createAdmin(options = {}) {
  const id = options.id ?? randomUUID();
  const email = options.email ?? `${randomUUID()}@example.test`;
  await admin.query(
    `INSERT INTO "AdminUser" ("id", "authUserId", "email", "displayName", "role", "status")
     VALUES ($1, $2, $3, $4, 'SUPERADMIN', 'ACTIVE')`,
    [id, randomUUID(), email, options.displayName ?? "Security Test"],
  );
  return { id, email };
}

async function createCustomer(options = {}) {
  const id = randomUUID();
  const email = options.email ?? `${randomUUID()}@example.test`;
  await admin.query(
    `INSERT INTO "Customer" ("id", "authUserId", "email", "status")
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, randomUUID(), email],
  );
  return { id, email };
}

async function insertOutbox(key = randomUUID()) {
  const result = await admin.query(
    `INSERT INTO "DomainOutbox" (
       "eventType", "aggregateType", "aggregateId", "deduplicationKey", "payload"
     ) VALUES ('TestEvent', 'TestAggregate', $1, $2, '{"test":true}'::jsonb)
     RETURNING "id"`,
    [randomUUID(), key],
  );
  return result.rows[0].id;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({ containerName, port: 54428 });
    databaseUrl = harness.databaseUrl;

    try {
      admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
      await admin.query(`CREATE ROLE ${probeRole} NOLOGIN NOBYPASSRLS`);
      await admin.query(`GRANT ${probeRole} TO CURRENT_USER`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${probeRole}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${probeRole}`,
      );

      prisma = createDatabaseClient({ databaseUrl, maxConnections: 8 });
      keyRing = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 2,
        serializedKeys: JSON.stringify({
          1: randomBytes(32).toString("base64"),
          2: randomBytes(32).toString("base64"),
        }),
      });
      vault = new IntegrationCredentialVault(prisma, keyRing);
    } catch (error) {
      if (admin) {
        await admin.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
      await harness.stop();
      harness = undefined;
      throw error;
    }
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (prisma) await prisma.$disconnect();
    if (admin) {
      await admin
        .query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${probeRole}`)
        .catch(() => undefined);
      await admin.query(`REVOKE ALL ON SCHEMA public FROM ${probeRole}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => undefined);
      await admin.end();
    }
    if (harness) {
      await harness.stop();
    }
  },
  { timeout: 30_000 },
);

describe("F0.3 — PostgreSQL 17 migration and security posture", () => {
  it("applies the complete chain and passes independent posture verification", async () => {
    const version = await admin.query("SHOW server_version");
    assert.match(version.rows[0].server_version, /^17\./);
    assert.deepEqual(await verifySecurityPosture(databaseUrl), []);
    const migrations = await admin.query(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    assert.equal(migrations.rows.length, 44);
  });

  it("forces RLS on every application table and denies rows even with SQL grants", async () => {
    const protectedTables = await admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class cls JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND cls.relname = ANY($1::text[])`,
      [tables],
    );
    assert.equal(protectedTables.rows.length, tables.length);
    for (const row of protectedTables.rows) {
      assert.equal(row.relrowsecurity, true);
      assert.equal(row.relforcerowsecurity, true);
    }

    await createAdmin();
    for (const table of tables) {
      const rows = await withProbe((client) => client.query(`SELECT * FROM "${table}"`));
      assert.deepEqual(rows.rows, [], `${table} leaked rows through RLS`);
    }
    await assert.rejects(
      withProbe((client) =>
        client.query(
          `INSERT INTO "Customer" ("email") VALUES ('rls-denied@example.test') RETURNING "id"`,
        ),
      ),
      (error) => error.code === "42501",
    );
  });

  it("revokes schema, table, sequence, and function access from all Data API roles", async () => {
    const schema = await admin.query(
      `SELECT rolname, has_schema_privilege(oid, 'public', 'USAGE') AS usage,
              has_schema_privilege(oid, 'public', 'CREATE') AS create
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [["anon", "authenticated", "service_role"]],
    );
    assert.equal(schema.rows.length, 3);
    for (const row of schema.rows) {
      assert.equal(row.usage, false);
      assert.equal(row.create, false);
    }
    await assert.rejects(
      withProbe((client) => client.query("SELECT consume_admin_recovery_code(NULL, NULL)")),
      (error) => error.code === "42501",
    );
  });

  it("enforces RLS after CREATE TABLE, CREATE TABLE AS, and SELECT INTO", async () => {
    const ddlStatements = [
      'CREATE TABLE "RlsTriggerProbe" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "RlsTriggerProbe" AS SELECT 1 AS "id"',
      'SELECT 1 AS "id" INTO "RlsTriggerProbe"',
    ];

    for (const [index, statement] of ddlStatements.entries()) {
      try {
        await admin.query(statement);
        const flags = await admin.query(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
           WHERE relname = 'RlsTriggerProbe' AND relnamespace = 'public'::regnamespace`,
        );
        assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });

        const apiPrivileges = await admin.query(
          `SELECT has_table_privilege('anon', '"RlsTriggerProbe"', 'SELECT') AS anon_select,
                  has_table_privilege('authenticated', '"RlsTriggerProbe"', 'SELECT') AS auth_select,
                  has_table_privilege('service_role', '"RlsTriggerProbe"', 'SELECT') AS service_select`,
        );
        assert.deepEqual(apiPrivileges.rows[0], {
          anon_select: false,
          auth_select: false,
          service_select: false,
        });

        await admin.query(`GRANT SELECT, INSERT ON "RlsTriggerProbe" TO ${probeRole}`);
        const visible = await withProbe((client) =>
          client.query('SELECT * FROM "RlsTriggerProbe"'),
        );
        assert.deepEqual(visible.rows, []);

        if (index === 0) {
          await admin.query(
            'CREATE POLICY "leak_probe" ON "RlsTriggerProbe" FOR SELECT TO anon USING (true)',
          );
          const policyErrors = await verifySecurityPosture(databaseUrl);
          assert.ok(policyErrors.some((msg) => msg.includes("leak_probe")));
        }
      } finally {
        await admin.query('DROP TABLE IF EXISTS "RlsTriggerProbe"');
      }
    }
  });

  it("revokes future functions while rejecting them in the exact inventory", async () => {
    try {
      await admin.query(
        `CREATE FUNCTION "future_revoked_probe"() RETURNS integer
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
         AS 'SELECT 1'`,
      );
      const privileges = await admin.query(
        `SELECT NOT EXISTS (
           SELECT 1 FROM aclexplode(proc.proacl) AS acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS public_revoked,
         has_function_privilege('anon', proc.oid, 'EXECUTE') AS anon_execute,
         has_function_privilege('authenticated', proc.oid, 'EXECUTE') AS auth_execute,
         has_function_privilege('service_role', proc.oid, 'EXECUTE') AS service_execute
         FROM pg_proc proc
         WHERE proc.oid = '"future_revoked_probe"()'::regprocedure`,
      );
      assert.deepEqual(privileges.rows[0], {
        public_revoked: true,
        anon_execute: false,
        auth_execute: false,
        service_execute: false,
      });
      const errors = await verifySecurityPosture(databaseUrl);
      assert.ok(
        errors.some((message) =>
          message.includes("Unexpected public function future_revoked_probe()"),
        ),
      );
      assert.ok(!errors.some((message) => message.includes("can execute future_revoked_probe")));
    } finally {
      await admin.query('DROP FUNCTION IF EXISTS "future_revoked_probe"()');
    }
  });

  it("accepts extension functions in public or extensions without changing the app inventory", async () => {
    assert.deepEqual(await verifySecurityPosture(databaseUrl), []);
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS extensions");
      await client.query("ALTER EXTENSION pgcrypto SET SCHEMA extensions");
      const locations = await client.query(
        `SELECT ns.nspname AS schema, count(*)::int AS functions
         FROM pg_proc proc
         JOIN pg_namespace ns ON ns.oid = proc.pronamespace
         WHERE EXISTS (
           SELECT 1 FROM pg_depend dependency
           WHERE dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = proc.oid AND dependency.deptype = 'e'
             AND dependency.refclassid = 'pg_extension'::regclass
             AND dependency.refobjid = (SELECT oid FROM pg_extension WHERE extname = 'pgcrypto')
         ) AND ns.nspname IN ('public', 'extensions')
         GROUP BY ns.nspname ORDER BY ns.nspname`,
      );
      assert.deepEqual(locations.rows, [{ schema: "extensions", functions: 36 }]);
      assert.deepEqual(await verifySecurityPosture(databaseUrl, client), []);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });

  it("rejects -1 for every accepted guard family and exposes unsafe OR branches", async () => {
    await admin.query("CREATE TEMP TABLE a3_nonnegative_probe (value integer, other boolean)");
    try {
      const accepted = [
        { name: "probe_ge", definition: "CHECK (value >= 0)", valid: 0 },
        { name: "probe_gt", definition: "CHECK (value > 0)", valid: 1 },
        {
          name: "probe_nullable",
          definition: "CHECK (value IS NULL OR value >= 0)",
          valid: null,
        },
        {
          name: "probe_conjunction",
          definition: "CHECK (value >= 0 AND other)",
          valid: 0,
        },
      ];
      for (const testCase of accepted) {
        assert.equal(constraintGuaranteesNonNegative(testCase.definition, "value"), true);
        await admin.query(
          `ALTER TABLE a3_nonnegative_probe ADD CONSTRAINT "${testCase.name}" ${testCase.definition}`,
        );
        await expectSqlViolation(
          admin.query("INSERT INTO a3_nonnegative_probe VALUES (-1, true)"),
          "23514",
        );
        await admin.query("INSERT INTO a3_nonnegative_probe VALUES ($1, true)", [testCase.valid]);
        await admin.query("DELETE FROM a3_nonnegative_probe");
        await admin.query(`ALTER TABLE a3_nonnegative_probe DROP CONSTRAINT "${testCase.name}"`);
      }

      for (const definition of ["CHECK (value >= 0 OR true)", "CHECK (value >= 0 OR other)"]) {
        const name = definition.includes("true") ? "probe_or_true" : "probe_or_other";
        assert.equal(constraintGuaranteesNonNegative(definition, "value"), false);
        await admin.query(
          `ALTER TABLE a3_nonnegative_probe ADD CONSTRAINT "${name}" ${definition}`,
        );
        const inserted = await admin.query("INSERT INTO a3_nonnegative_probe VALUES (-1, true)");
        assert.equal(inserted.rowCount, 1);
        await admin.query("DELETE FROM a3_nonnegative_probe");
        await admin.query(`ALTER TABLE a3_nonnegative_probe DROP CONSTRAINT "${name}"`);
      }
    } finally {
      await admin.query("DROP TABLE IF EXISTS a3_nonnegative_probe");
    }
  });

  it("allows service_role BYPASSRLS only when supautils explicitly reserves it", async () => {
    await expectPostureMutationAllowed([
      "SET LOCAL supautils.reserved_roles = 'supabase_admin, service_role*, authenticated*, anon*'",
      "ALTER ROLE service_role BYPASSRLS",
    ]);
  });

  it("accepts closed rollbacks and historical timestamps without accepting unfinished migrations", async () => {
    await expectPostureMutationAllowed([
      `INSERT INTO "_prisma_migrations" (
         "id", "checksum", "migration_name", "started_at", "rolled_back_at", "applied_steps_count"
       ) VALUES (
         '${randomUUID()}', '${randomBytes(32).toString("hex")}',
         '20261124160000_a3_db_constraints_locks', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0
       )`,
      `UPDATE "_prisma_migrations" SET "started_at" = '2030-01-01'
       WHERE "migration_name" = '20261123123000_f6_1_meli_oauth_channel_accounts'`,
      `UPDATE "_prisma_migrations" SET "started_at" = '2020-01-01'
       WHERE "migration_name" = '20261123130000_f5_2_completion_acceptance'`,
    ]);
  });

  it("fails closed on isolated catalog and privilege mutations", async () => {
    const mutants = [
      {
        statements: [
          'ALTER TABLE "Customer" DROP CONSTRAINT "Customer_loyaltyPoints_nonnegative"',
          'ALTER TABLE "Customer" ADD CONSTRAINT "Customer_loyaltyPoints_nonnegative" CHECK (true)',
        ],
        expected: [
          "constraint Customer.Customer_loyaltyPoints_nonnegative differs",
          "Monetary/stock column Customer.loyaltyPoints has no semantic non-negative CHECK coverage",
        ],
      },
      {
        statements: [
          'ALTER TABLE "ProductMedia" DROP CONSTRAINT "ProductMedia_variantId_productId_fkey"',
          `ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_variantId_productId_fkey"
           FOREIGN KEY ("variantId", "productId") REFERENCES "ProductVariant"("id", "productId")
           ON UPDATE CASCADE ON DELETE RESTRICT`,
        ],
        expected: "constraint ProductMedia.ProductMedia_variantId_productId_fkey differs",
      },
      {
        statements: [
          'DROP INDEX "Brand_slug_active_key"',
          `CREATE UNIQUE INDEX "Brand_slug_active_key" ON "Brand"("slug")
           WHERE "deletedAt" IS NOT NULL`,
        ],
        expected: "index Brand_slug_active_key differs",
      },
      {
        statements: [
          'DROP TRIGGER "AdminActionLog_append_only" ON "AdminActionLog"',
          `CREATE TRIGGER "AdminActionLog_append_only" BEFORE DELETE OR UPDATE ON "AdminUser"
           FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()`,
        ],
        expected: "Unexpected row trigger AdminUser.AdminActionLog_append_only",
      },
      {
        statements: ['ALTER TABLE "AdminActionLog" DISABLE TRIGGER "AdminActionLog_append_only"'],
        expected: [
          "Trigger AdminActionLog.AdminActionLog_append_only is not enabled in origin mode",
          "row trigger AdminActionLog.AdminActionLog_append_only differs",
        ],
      },
      {
        statements: ["ALTER EVENT TRIGGER enforce_rls_on_new_table DISABLE"],
        expected: [
          "Event trigger enforce_rls_on_new_table is not enabled in origin mode",
          "event trigger enforce_rls_on_new_table differs",
        ],
      },
      {
        statements: ['ALTER TABLE "Customer" DISABLE ROW LEVEL SECURITY'],
        expected: "Public table Customer is not deny-by-default.",
      },
      {
        statements: ['ALTER TABLE "Customer" NO FORCE ROW LEVEL SECURITY'],
        expected: "Public table Customer is not deny-by-default.",
      },
      {
        statements: ["GRANT USAGE ON SCHEMA public TO anon"],
        expected: "PostgREST role anon retains public schema privileges.",
      },
      {
        statements: [
          'CREATE SEQUENCE "PostureSeqProbe"',
          'GRANT USAGE ON SEQUENCE "PostureSeqProbe" TO anon',
        ],
        expected: "PostgREST role anon retains USAGE on sequence PostureSeqProbe.",
      },
      {
        statements: [
          'GRANT EXECUTE ON FUNCTION "consume_admin_recovery_code"(uuid, bytea, timestamp with time zone) TO anon',
        ],
        expected: "PostgREST role anon can execute consume_admin_recovery_code.",
      },
      {
        statements: ['GRANT SELECT ("ciphertext") ON "IntegrationCredential" TO service_role'],
        expected: [
          "PostgREST role service_role retains column-level SELECT on IntegrationCredential.",
          "Role service_role retains column privilege SELECT on IntegrationCredential.ciphertext.",
        ],
      },
      {
        statements: ["GRANT USAGE ON SCHEMA public TO PUBLIC"],
        expected: "PUBLIC retains schema privileges on public.",
      },
      {
        statements: ["GRANT service_role TO anon"],
        expected: "Role anon must not hold membership in role service_role.",
      },
      {
        statements: ["CREATE SCHEMA bad_ext", "ALTER EXTENSION pgcrypto SET SCHEMA bad_ext"],
        expected: "Extension pgcrypto must be installed in public or extensions; found bad_ext.",
      },
      {
        statements: ['ALTER FUNCTION "enforce_blocked_identity_state"() SECURITY INVOKER'],
        expected: "public function enforce_blocked_identity_state() differs",
      },
      {
        statements: ['ALTER FUNCTION "set_updated_at"() RESET search_path'],
        expected: [
          "Public function set_updated_at() must have a fixed search_path of pg_catalog,public.",
          "public function set_updated_at() differs",
        ],
      },
      {
        statements: [
          'ALTER TABLE "Customer" ADD CONSTRAINT "Customer_not_valid_probe" CHECK ("loyaltyPoints" >= 0) NOT VALID',
        ],
        expected: [
          "Constraint Customer.Customer_not_valid_probe is not validated.",
          "Unexpected constraint Customer.Customer_not_valid_probe.",
        ],
      },
      {
        statements: [
          `UPDATE "_prisma_migrations" SET "rolled_back_at" = CURRENT_TIMESTAMP
           WHERE "migration_name" = '20261124160000_a3_db_constraints_locks'`,
        ],
        expected: [
          "The Prisma migration chain contains an applied migration marked rolled back.",
          "Prisma migration sequence differs",
        ],
      },
      {
        statements: [
          'CREATE POLICY "probe_non_api_policy" ON "Customer" FOR SELECT TO CURRENT_USER USING (true)',
        ],
        expected:
          "Policy probe_non_api_policy on Customer violates deny-by-default zero-policy posture on schema public.",
      },
      {
        statements: ['CREATE TABLE "UnexpectedProtectedProbe" ("id" integer PRIMARY KEY)'],
        expected: "Protected table set differs",
      },
      {
        statements: [
          `INSERT INTO "_prisma_migrations" (
             "id", "checksum", "migration_name", "finished_at", "started_at", "applied_steps_count"
           ) VALUES (
             '${randomUUID()}', '${randomBytes(32).toString("hex")}',
             '29990101000000_unexpected_migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
           )`,
        ],
        expected: "Prisma migration sequence differs",
      },
      {
        statements: [
          `INSERT INTO "_prisma_migrations" (
             "id", "checksum", "migration_name", "started_at", "applied_steps_count"
           ) VALUES (
             '${randomUUID()}', '${randomBytes(32).toString("hex")}',
             '29990101000000_unfinished_migration', CURRENT_TIMESTAMP, 0
           )`,
        ],
        expected: "unfinished migration",
      },
      {
        statements: ['GRANT MAINTAIN ON "Customer" TO anon'],
        expected: "retains MAINTAIN on Customer",
      },
      {
        statements: ['ALTER FUNCTION "enforce_blocked_identity_state"() RESET search_path'],
        expected: "must have a fixed search_path of pg_catalog,public",
      },
      {
        statements: [
          "SET LOCAL supautils.reserved_roles = 'service_role*, authenticated*, anon*'",
          "ALTER ROLE anon BYPASSRLS",
        ],
        expected: "Role anon must exist without SUPERUSER or BYPASSRLS",
      },
      {
        statements: [
          "SET LOCAL supautils.reserved_roles = 'service_role*, authenticated*, anon*'",
          "ALTER ROLE authenticated BYPASSRLS",
        ],
        expected: "Role authenticated must exist without SUPERUSER or BYPASSRLS",
      },
      {
        statements: [
          "SET LOCAL supautils.reserved_roles = 'supabase_admin, authenticated*, anon*'",
          "ALTER ROLE service_role BYPASSRLS",
        ],
        expected: "Role service_role must exist without SUPERUSER or BYPASSRLS",
      },
      {
        statements: [
          "SET LOCAL supautils.reserved_roles = 'service_role*'",
          "ALTER ROLE service_role SUPERUSER",
        ],
        expected: "Role service_role must exist without SUPERUSER or BYPASSRLS",
      },
      {
        statements: [
          "SET LOCAL supautils.reserved_roles = 'service_role*'",
          "ALTER ROLE service_role BYPASSRLS",
          'GRANT MAINTAIN ON "Customer" TO service_role',
        ],
        expected: "retains MAINTAIN on Customer",
      },
      {
        statements: ["ALTER ROLE service_role BYPASSRLS"],
        expected: "Role service_role must exist without SUPERUSER or BYPASSRLS",
      },
      {
        statements: ["ALTER ROLE service_role SUPERUSER"],
        expected: "Role service_role must exist without SUPERUSER or BYPASSRLS",
      },
    ];

    for (const mutant of mutants) {
      await expectPostureMutation(mutant.statements, mutant.expected);
    }
  });
});

describe("F0.3 — relational integrity and immutable security records", () => {
  it("supports soft-delete recreation without allowing duplicate active identities", async () => {
    const email = `${randomUUID()}@example.test`;
    const first = await createAdmin({ email });
    await expectSqlViolation(createAdmin({ email }), "23505");
    await admin.query('UPDATE "AdminUser" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [
      first.id,
    ]);
    const second = await createAdmin({ email });
    assert.notEqual(second.id, first.id);
    await expectSqlViolation(createAdmin({ email }), "23505");

    // Guest customer (authUserId = null) upgrades cleanly to ACTIVE without P2002 collision
    const guestEmail = `guest-${randomUUID()}@example.test`;
    const guest = await prisma.customer.create({
      data: { email: guestEmail, status: "GUEST" },
    });
    assert.equal(guest.authUserId, null);
    const linkedAuthId = randomUUID();
    const upgraded = await prisma.$transaction(async (tx) => {
      const found = await tx.customer.findFirst({ where: { email: guestEmail, deletedAt: null } });
      return tx.customer.update({
        where: { id: found.id },
        data: { authUserId: linkedAuthId, status: "ACTIVE" },
      });
    });
    assert.equal(upgraded.id, guest.id);
    assert.equal(upgraded.authUserId, linkedAuthId);
    assert.equal(upgraded.status, "ACTIVE");
  });

  it("validates emails, E.164 phones, names, timestamps, and non-negative loyalty points", async () => {
    await expectSqlViolation(
      admin.query('INSERT INTO "Customer" ("email", "loyaltyPoints") VALUES ($1, -1)', [
        `${randomUUID()}@example.test`,
      ]),
      "23514",
    );
    await expectSqlViolation(
      admin.query('INSERT INTO "Customer" ("email") VALUES ($1)', ["INVALID@EXAMPLE.TEST"]),
      "23514",
    );
    await expectSqlViolation(
      admin.query('INSERT INTO "Customer" ("email", "phoneE164") VALUES ($1, $2)', [
        `${randomUUID()}@example.test`,
        "3011234567",
      ]),
      "23514",
    );
    await expectSqlViolation(
      admin.query(
        'INSERT INTO "AdminUser" ("authUserId", "email", "displayName", "role") VALUES ($1, $2, $3, $4)',
        [randomUUID(), `${randomUUID()}@example.test`, "   ", "SUPERADMIN"],
      ),
      "23514",
    );
  });

  it("consumes each recovery code atomically once and rejects expiry or malformed hashes", async () => {
    const actor = await createAdmin();
    const codeHash = randomBytes(32);
    await admin.query(
      `INSERT INTO "AdminRecoveryCode" ("adminUserId", "codeHash", "expiresAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
      [actor.id, codeHash],
    );
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "AdminRecoveryCode" ("adminUserId", "codeHash", "expiresAt")
         VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
        [actor.id, Buffer.alloc(31)],
      ),
      "23514",
    );

    const first = new pg.Client({ connectionString: databaseUrl });
    const second = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    try {
      const results = await Promise.all([
        first.query("SELECT consume_admin_recovery_code($1, $2) AS consumed", [actor.id, codeHash]),
        second.query("SELECT consume_admin_recovery_code($1, $2) AS consumed", [
          actor.id,
          codeHash,
        ]),
      ]);
      assert.deepEqual(results.map((result) => result.rows[0].consumed).sort(), [false, true]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
    const repeated = await admin.query("SELECT consume_admin_recovery_code($1, $2) AS consumed", [
      actor.id,
      codeHash,
    ]);
    assert.equal(repeated.rows[0].consumed, false);
    await expectSqlViolation(
      admin.query(
        'UPDATE "AdminRecoveryCode" SET "consumedAt" = NULL WHERE "adminUserId" = $1 AND "codeHash" = $2',
        [actor.id, codeHash],
      ),
      "55000",
    );

    const typedCodeHash = randomBytes(32);
    await admin.query(
      `INSERT INTO "AdminRecoveryCode" ("adminUserId", "codeHash", "expiresAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
      [actor.id, typedCodeHash],
    );
    assert.equal(
      await prisma.$transaction((tx) =>
        consumeAdminRecoveryCode(tx, { adminUserId: actor.id, codeHash: typedCodeHash }),
      ),
      true,
    );
    assert.equal(
      await consumeAdminRecoveryCode(prisma, { adminUserId: actor.id, codeHash: typedCodeHash }),
      false,
    );

    await admin.query(
      `INSERT INTO "AdminRecoveryCode" ("adminUserId", "codeHash", "createdAt", "expiresAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
      [actor.id, randomBytes(32)],
    );
    assert.equal(
      (
        await admin.query("SELECT consume_admin_recovery_code($1, $2) AS consumed", [
          actor.id,
          codeHash,
        ])
      ).rows[0].consumed,
      false,
    );
  });

  it("derives selfDealing and makes admin audit logs append-only", async () => {
    const actor = await createAdmin();
    const inserted = await admin.query(
      `INSERT INTO "AdminActionLog" (
         "actorAdminUserId", "targetAdminUserId", "action", "targetType", "metadata", "selfDealing"
       ) VALUES ($1, $1, 'ROLE_CHANGED', 'AdminUser', '{"test":true}'::jsonb, false)
       RETURNING "id", "selfDealing"`,
      [actor.id],
    );
    assert.equal(inserted.rows[0].selfDealing, true);
    const implicitSelfTarget = await admin.query(
      `INSERT INTO "AdminActionLog" (
         "actorAdminUserId", "action", "targetType", "targetId", "metadata"
       ) VALUES ($1, 'PROFILE_EDITED', 'AdminUser', $2, '{}'::jsonb)
       RETURNING "selfDealing", "targetAdminUserId"`,
      [actor.id, actor.id],
    );
    assert.equal(implicitSelfTarget.rows[0].selfDealing, true);
    assert.equal(implicitSelfTarget.rows[0].targetAdminUserId, actor.id);
    await expectSqlViolation(
      admin.query('UPDATE "AdminActionLog" SET "selfDealing" = false WHERE "id" = $1', [
        inserted.rows[0].id,
      ]),
      "55000",
    );
    await expectSqlViolation(
      admin.query('DELETE FROM "AdminActionLog" WHERE "id" = $1', [inserted.rows[0].id]),
      "55000",
    );
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "AdminActionLog" ("actorAdminUserId", "action", "targetType", "metadata")
         VALUES ($1, 'INVALID_METADATA', 'AdminUser', '[]'::jsonb)`,
        [actor.id],
      ),
      "23514",
    );
  });

  it("deduplicates security events by type, IP hash, and actual event minute", async () => {
    const ipHash = randomBytes(32);
    const occurredAt = new Date("2026-01-15T13:14:59.999Z");
    const inserted = await admin.query(
      `INSERT INTO "SecurityEvent" ("eventType", "ipHash", "occurredAt")
       VALUES ('LOGIN_FAILED', $1, $2) RETURNING "id", "dedupMinute"`,
      [ipHash, occurredAt],
    );
    assert.equal(inserted.rows[0].dedupMinute.toISOString(), "2026-01-15T13:14:00.000Z");
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "SecurityEvent" ("eventType", "ipHash", "occurredAt")
         VALUES ('LOGIN_FAILED', $1, $2)`,
        [ipHash, new Date("2026-01-15T13:14:01.000Z")],
      ),
      "23505",
    );
    await expectSqlViolation(
      admin.query('DELETE FROM "SecurityEvent" WHERE "id" = $1', [inserted.rows[0].id]),
      "55000",
    );
  });

  it("stores consent grants and revocations as an append-only chain", async () => {
    const customer = await createCustomer();
    const granted = await admin.query(
      `INSERT INTO "Consent" ("customerId", "purpose", "status", "source", "policyVersion", "proofHash")
       VALUES ($1, 'MARKETING_EMAIL', 'GRANTED', 'checkout', 'v1', $2)
       RETURNING "id"`,
      [customer.id, randomBytes(32)],
    );
    const revoked = await admin.query(
      `INSERT INTO "Consent" (
         "customerId", "purpose", "status", "source", "policyVersion", "proofHash", "revokesId"
       ) VALUES ($1, 'MARKETING_EMAIL', 'REVOKED', 'account', 'v1', $2, $3)
       RETURNING "id"`,
      [customer.id, randomBytes(32), granted.rows[0].id],
    );
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "Consent" (
           "customerId", "purpose", "status", "source", "policyVersion", "proofHash", "revokesId"
         ) VALUES ($1, 'MARKETING_EMAIL', 'REVOKED', 'account', 'v1', $2, $3)`,
        [customer.id, randomBytes(32), granted.rows[0].id],
      ),
      "23505",
    );
    const otherCustomer = await createCustomer();
    for (const [customerId, purpose] of [
      [otherCustomer.id, "MARKETING_EMAIL"],
      [customer.id, "MARKETING_SMS"],
    ]) {
      await expectSqlViolation(
        admin.query(
          `INSERT INTO "Consent" (
             "customerId", "purpose", "status", "source", "policyVersion", "proofHash", "revokesId"
           ) VALUES ($1, $2::"ConsentPurpose", 'REVOKED', 'account', 'v1', $3, $4)`,
          [customerId, purpose, randomBytes(32), granted.rows[0].id],
        ),
        "23514",
      );
    }
    await expectSqlViolation(
      admin.query('UPDATE "Consent" SET "source" = $1 WHERE "id" = $2', [
        "changed",
        revoked.rows[0].id,
      ]),
      "55000",
    );
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "Consent" (
           "customerId", "purpose", "status", "source", "policyVersion", "proofHash", "revokesId"
         ) VALUES ($1, 'MARKETING_EMAIL', 'GRANTED', 'checkout', 'v1', $2, $3)`,
        [customer.id, randomBytes(32), granted.rows[0].id],
      ),
      "23514",
    );
  });
});

describe("F0.3 — idempotency and outbox concurrency", () => {
  before(async () => {
    for (;;) {
      const preexisting = await admin.query(
        "SELECT * FROM claim_domain_outbox('preexisting-suite-drain', 100)",
      );
      if (preexisting.rows.length === 0) break;
      for (const row of preexisting.rows) {
        await admin.query("SELECT complete_domain_outbox($1, 'preexisting-suite-drain')", [row.id]);
      }
    }
  });

  it("acquires one idempotency record across races and rejects payload reuse", async () => {
    const scope = `test-${randomUUID()}`;
    const keyHash = randomBytes(32);
    const subjectHash = randomBytes(32);
    const requestHash = randomBytes(32);
    const expiresAt = new Date(Date.now() + 60_000);
    const first = new pg.Client({ connectionString: databaseUrl });
    const second = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([first.connect(), second.connect()]);

    try {
      const acquired = await Promise.all([
        first.query("SELECT * FROM acquire_idempotency_key($1, $2, $3, $4, $5)", [
          scope,
          keyHash,
          subjectHash,
          requestHash,
          expiresAt,
        ]),
        second.query("SELECT * FROM acquire_idempotency_key($1, $2, $3, $4, $5)", [
          scope,
          keyHash,
          subjectHash,
          requestHash,
          expiresAt,
        ]),
      ]);
      assert.equal(acquired[0].rows[0].id, acquired[1].rows[0].id);
      assert.equal(acquired[0].rows[0].status, "PROCESSING");
      assert.deepEqual([acquired[0].rows[0].acquired, acquired[1].rows[0].acquired].sort(), [
        false,
        true,
      ]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }

    await expectSqlViolation(
      admin.query("SELECT * FROM acquire_idempotency_key($1, $2, $3, $4, $5)", [
        scope,
        keyHash,
        subjectHash,
        randomBytes(32),
        expiresAt,
      ]),
      "23505",
    );
    await assert.rejects(
      admin.query(
        "SELECT complete_idempotency_key($1, $2, $3, $4, 'SUCCEEDED', 500, 'Order', $5) AS completed",
        [scope, keyHash, subjectHash, requestHash, randomUUID()],
      ),
    );
    const wrongSubject = await admin.query(
      "SELECT complete_idempotency_key($1, $2, $3, $4, 'SUCCEEDED', 200, 'Order', $5) AS completed",
      [scope, keyHash, randomBytes(32), requestHash, randomUUID()],
    );
    assert.equal(wrongSubject.rows[0].completed, false);
    const completed = await admin.query(
      "SELECT complete_idempotency_key($1, $2, $3, $4, 'SUCCEEDED', 200, 'Order', $5) AS completed",
      [scope, keyHash, subjectHash, requestHash, randomUUID()],
    );
    assert.equal(completed.rows[0].completed, true);
    const duplicateCompletion = await admin.query(
      "SELECT complete_idempotency_key($1, $2, $3, $4, 'SUCCEEDED', 200, 'Order', $5) AS completed",
      [scope, keyHash, subjectHash, requestHash, randomUUID()],
    );
    assert.equal(duplicateCompletion.rows[0].completed, false);
    const replay = await admin.query("SELECT * FROM acquire_idempotency_key($1, $2, $3, $4, $5)", [
      scope,
      keyHash,
      subjectHash,
      requestHash,
      new Date(Date.now() + 60_000),
    ]);
    assert.equal(replay.rows[0].status, "SUCCEEDED");
    assert.equal(replay.rows[0].responseStatus, 200);
    assert.equal(replay.rows[0].acquired, false);

    const typedScope = `typed-${randomUUID()}`;
    const typedKey = randomBytes(32);
    const typedSubject = randomBytes(32);
    const typedReq = randomBytes(32);
    const winner = await acquireIdempotencyKey(prisma, {
      scope: typedScope,
      keyHash: typedKey,
      subjectHash: typedSubject,
      requestHash: typedReq,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(winner.acquired, true);
    const duplicate = await acquireIdempotencyKey(prisma, {
      scope: typedScope,
      keyHash: typedKey,
      subjectHash: typedSubject,
      requestHash: typedReq,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(duplicate.acquired, false);
    assert.equal(duplicate.status, IdempotencyStatus.PROCESSING);
    assert.equal(
      await completeIdempotencyKey(prisma, {
        scope: typedScope,
        keyHash: typedKey,
        subjectHash: typedSubject,
        requestHash: typedReq,
        status: IdempotencyStatus.SUCCEEDED,
        responseStatus: 201,
        resultType: "Order",
        resultId: randomUUID(),
      }),
      true,
    );
  });

  it("rejects expired idempotency keys and purges expired entries safely", async () => {
    const scope = `expired-${randomUUID()}`;
    const keyHash = randomBytes(32);
    const subjectHash = randomBytes(32);
    const requestHash = randomBytes(32);
    await admin.query(
      `INSERT INTO "IdempotencyKey" (
         "scope", "keyHash", "subjectHash", "requestHash", "createdAt", "expiresAt"
       ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
      [scope, keyHash, subjectHash, requestHash],
    );
    await expectSqlViolation(
      admin.query("SELECT * FROM acquire_idempotency_key($1, $2, $3, $4, $5)", [
        scope,
        keyHash,
        subjectHash,
        requestHash,
        new Date(Date.now() + 60_000),
      ]),
      "23505",
    );
    const purged = await purgeExpiredIdempotencyKeys(prisma, { limit: 100 });
    assert.ok(purged >= 1);
    const reacquired = await acquireIdempotencyKey(prisma, {
      scope,
      keyHash,
      subjectHash,
      requestHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(reacquired.acquired, true);
  });

  it("claims disjoint outbox batches under concurrency and completes only with the owner", async () => {
    const ids = [];
    for (let index = 0; index < 8; index += 1) ids.push(await insertOutbox());
    assert.equal(new Set(ids).size, 8);
    const first = new pg.Client({ connectionString: databaseUrl });
    const second = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([first.connect(), second.connect()]);
    let claimed;

    try {
      claimed = await Promise.all([
        first.query("SELECT * FROM claim_domain_outbox('worker-a', 4)"),
        second.query("SELECT * FROM claim_domain_outbox('worker-b', 4)"),
      ]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }

    const rows = [...claimed[0].rows, ...claimed[1].rows];
    assert.equal(rows.length, 8);
    assert.equal(new Set(rows.map((row) => row.id)).size, 8);
    assert.ok(rows.every((row) => row.attempts === 1));
    const firstClaim = claimed[0].rows[0];
    assert.equal(
      (
        await admin.query("SELECT complete_domain_outbox($1, 'worker-b') AS completed", [
          firstClaim.id,
        ])
      ).rows[0].completed,
      false,
    );

    for (const row of rows) {
      const result = await admin.query("SELECT complete_domain_outbox($1, $2) AS completed", [
        row.id,
        row.claimedBy,
      ]);
      assert.equal(result.rows[0].completed, true);
    }
    assert.equal(
      (await admin.query("SELECT * FROM claim_domain_outbox('worker-c', 100)")).rows.length,
      0,
    );
    await assert.rejects(admin.query("SELECT * FROM claim_domain_outbox('worker-c', 0)"));
    await assert.rejects(admin.query("SELECT * FROM claim_domain_outbox('worker-c', 101)"));
  });

  it("supports bounded retries and reclaiming expired leases without double processing", async () => {
    const baseNow = new Date((await admin.query("SELECT CURRENT_TIMESTAMP AS now")).rows[0].now);
    const retryId = await insertOutbox();
    const claimed = await admin.query("SELECT * FROM claim_domain_outbox('retry-worker', 1)");
    assert.equal(claimed.rows[0].id, retryId);
    await assert.rejects(
      admin.query("SELECT retry_domain_outbox($1, 'retry-worker', $2, 'failed') AS retried", [
        retryId,
        new Date(baseNow.getTime() + 25 * 60 * 60 * 1000),
      ]),
    );
    const availableAt = new Date(baseNow.getTime() + 60 * 60 * 1000);
    assert.equal(
      (
        await admin.query(
          "SELECT retry_domain_outbox($1, 'retry-worker', $2, 'failed') AS retried",
          [retryId, availableAt],
        )
      ).rows[0].retried,
      true,
    );
    assert.equal(
      (await admin.query("SELECT * FROM claim_domain_outbox('other-worker', 10)")).rows.length,
      0,
    );

    const future = new Date(baseNow.getTime() + 2 * 60 * 60 * 1000);
    const reclaimedRetry = await admin.query(
      "SELECT * FROM claim_domain_outbox('other-worker', 10, $1)",
      [future],
    );
    assert.equal(reclaimedRetry.rows.length, 1);
    assert.equal(reclaimedRetry.rows[0].attempts, 2);
    assert.equal(
      (
        await admin.query("SELECT complete_domain_outbox($1, 'other-worker', $2) AS completed", [
          retryId,
          future,
        ])
      ).rows[0].completed,
      true,
    );

    const leaseBase = new Date((await admin.query("SELECT CURRENT_TIMESTAMP AS now")).rows[0].now);
    const expiringId = await insertOutbox();
    const now = new Date(leaseBase.getTime() + 1_000);
    await admin.query("SELECT * FROM claim_domain_outbox('lease-a', 1, $1)", [now]);
    assert.equal(
      (await admin.query("SELECT * FROM claim_domain_outbox('lease-b', 1, $1)", [now])).rows.length,
      0,
    );
    const afterLease = new Date(now.getTime() + 6 * 60 * 1000);
    const reclaimed = await admin.query("SELECT * FROM claim_domain_outbox('lease-b', 1, $1)", [
      afterLease,
    ]);
    assert.equal(reclaimed.rows[0].id, expiringId);
    assert.equal(reclaimed.rows[0].attempts, 2);
    await admin.query("SELECT complete_domain_outbox($1, 'lease-b', $2)", [expiringId, afterLease]);

    const typedBase = new Date((await admin.query("SELECT CURRENT_TIMESTAMP AS now")).rows[0].now);
    const typedOutboxId = await insertOutbox();
    const typedClaimed = await claimDomainOutbox(prisma, { workerId: "typed-worker", limit: 10 });
    assert.ok(typedClaimed.some((item) => item.id === typedOutboxId));
    assert.equal(
      await retryDomainOutbox(prisma, {
        id: typedOutboxId,
        workerId: "typed-worker",
        availableAt: new Date(typedBase.getTime() + 30_000),
        error: "transient timeout",
      }),
      true,
    );
    const retryReady = new Date(typedBase.getTime() + 60_000);
    const reclaimedTyped = await claimDomainOutbox(prisma, {
      workerId: "typed-worker",
      limit: 10,
      now: retryReady,
    });
    assert.ok(reclaimedTyped.some((item) => item.id === typedOutboxId));
    assert.equal(
      await completeDomainOutbox(prisma, {
        id: typedOutboxId,
        workerId: "typed-worker",
        now: retryReady,
      }),
      true,
    );
  });

  it("enforces outbox payload, claim, and attempt invariants", async () => {
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "DomainOutbox" (
           "eventType", "aggregateType", "aggregateId", "deduplicationKey", "payload"
         ) VALUES ('Invalid', 'Test', $1, $2, '[]'::jsonb)`,
        [randomUUID(), randomUUID()],
      ),
      "23514",
    );
    await expectSqlViolation(
      admin.query(
        `INSERT INTO "DomainOutbox" (
           "eventType", "aggregateType", "aggregateId", "deduplicationKey", "payload", "attempts"
         ) VALUES ('Invalid', 'Test', $1, $2, '{}'::jsonb, -1)`,
        [randomUUID(), randomUUID()],
      ),
      "23514",
    );
  });
});

describe("F0.3 — persisted integration credential vault", () => {
  it("persists only sealed data, returns safe descriptors, and supports the full lifecycle", async () => {
    const actor = await createAdmin();
    const provider = `provider-${randomUUID()}`;
    const plaintext = encoder.encode('{"token":"persisted-test-secret"}');
    const requestId = randomUUID();
    const ipHash = randomBytes(32);
    const userAgentHash = randomBytes(32);
    const created = await vault.create({
      provider,
      accountName: "primary",
      plaintext,
      actorAdminUserId: actor.id,
      audit: { requestId, ipHash, userAgentHash },
    });

    for (const secretField of ["nonce", "ciphertext", "authTag"]) {
      assert.equal(Object.hasOwn(created, secretField), false);
    }
    assert.equal(decoder.decode(await vault.reveal(created.id)), decoder.decode(plaintext));
    const scoped = vault.forSystemProvider(provider);
    assert.deepEqual(
      (await scoped.list({ limit: 100 })).items.map((item) => item.id),
      [created.id],
    );
    assert.equal(decoder.decode(await scoped.reveal(created.id)), decoder.decode(plaintext));
    await assert.rejects(
      scoped.list({ limit: 100, includeRevoked: true }),
      CredentialForbiddenError,
    );
    await assert.rejects(
      vault.forSystemProvider(`other-${randomUUID()}`).reveal(created.id),
      CredentialNotFoundError,
    );
    const stored = await admin.query('SELECT * FROM "IntegrationCredential" WHERE "id" = $1', [
      created.id,
    ]);
    assert.equal(stored.rows[0].nonce.length, 12);
    assert.equal(stored.rows[0].authTag.length, 16);
    assert.equal(Buffer.from(stored.rows[0].ciphertext).includes(plaintext), false);

    await assert.rejects(
      vault.create({ provider, accountName: "primary", plaintext, actorAdminUserId: actor.id }),
      CredentialAlreadyExistsError,
    );
    const oldCiphertext = stored.rows[0].ciphertext;
    const rotated = await vault.rotate({
      credentialId: created.id,
      plaintext: encoder.encode("rotated-secret"),
      actorAdminUserId: actor.id,
    });
    assert.equal(rotated.keyVersion, 2);
    assert.equal(decoder.decode(await vault.reveal(created.id)), "rotated-secret");
    const afterRotation = await admin.query(
      'SELECT "ciphertext" FROM "IntegrationCredential" WHERE "id" = $1',
      [created.id],
    );
    assert.notDeepEqual(afterRotation.rows[0].ciphertext, oldCiphertext);

    const revoked = await vault.revoke(created.id, actor.id);
    assert.ok(revoked.revokedAt instanceof Date);
    await expectSqlViolation(
      admin.query('UPDATE "IntegrationCredential" SET "revokedAt" = NULL WHERE "id" = $1', [
        created.id,
      ]),
      "55000",
    );
    const audit = await admin.query(
      `SELECT "actorAdminUserId", "action", "requestId", "ipHash", "userAgentHash", "metadata"
       FROM "AdminActionLog"
       WHERE "targetType" = 'IntegrationCredential' AND "targetId" = $1`,
      [created.id],
    );
    assert.equal(audit.rows.length, 3);
    const createdAudit = audit.rows.find((row) => row.action === "INTEGRATION_CREDENTIAL_CREATED");
    assert.equal(createdAudit.requestId, requestId);
    assert.deepEqual(Buffer.from(createdAudit.ipHash), ipHash);
    assert.deepEqual(Buffer.from(createdAudit.userAgentHash), userAgentHash);
    assert.deepEqual(audit.rows.map((row) => row.action).sort(), [
      "INTEGRATION_CREDENTIAL_CREATED",
      "INTEGRATION_CREDENTIAL_REVOKED",
      "INTEGRATION_CREDENTIAL_ROTATED",
    ]);
    assert.ok(audit.rows.every((row) => row.actorAdminUserId === actor.id));
    assert.equal(JSON.stringify(audit.rows).includes("persisted-test-secret"), false);
    assert.equal(JSON.stringify(audit.rows).includes("rotated-secret"), false);
    await assert.rejects(vault.reveal(created.id), CredentialRevokedError);
    await assert.rejects(vault.revoke(created.id, actor.id), CredentialRevokedError);
    await assert.rejects(
      vault.rotate({ credentialId: created.id, plaintext, actorAdminUserId: actor.id }),
      CredentialRevokedError,
    );

    const recreated = await vault.create({
      provider,
      accountName: "primary",
      plaintext,
      actorAdminUserId: actor.id,
    });
    await expectSqlViolation(
      admin.query('UPDATE "IntegrationCredential" SET "provider" = $1 WHERE "id" = $2', [
        "tampered-provider",
        recreated.id,
      ]),
      "55000",
    );
    // Even if triggers were bypassed by superuser session_replication_role, AAD rejects provider mismatch:
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    await admin.query('UPDATE "IntegrationCredential" SET "provider" = $1 WHERE "id" = $2', [
      "tampered-provider",
      recreated.id,
    ]);
    await admin.query("COMMIT");
    await assert.rejects(vault.reveal(recreated.id), CredentialDecryptionError);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    await admin.query('UPDATE "IntegrationCredential" SET "provider" = $1 WHERE "id" = $2', [
      provider,
      recreated.id,
    ]);
    await admin.query("COMMIT");
    assert.notEqual(recreated.id, created.id);
    const listed = await vault.list(actor.id, { limit: 100 });
    assert.equal(
      listed.items.some((item) => item.id === created.id),
      false,
    );
    assert.equal(
      listed.items.some((item) => item.id === recreated.id),
      true,
    );
    const withRevoked = await vault.list(actor.id, { limit: 100, includeRevoked: true });
    assert.equal(
      withRevoked.items.some((item) => item.id === created.id),
      true,
    );
  });

  it("reencrypts old key versions and prevents cross-environment reads", async () => {
    const actor = await createAdmin();
    const oldRing = createCredentialKeyRing({
      environment: IntegrationEnvironment.LOCAL,
      activeVersion: 1,
      serializedKeys: JSON.stringify(
        Object.fromEntries(
          [...keyRing.keys].map(([version, key]) => [version, Buffer.from(key).toString("base64")]),
        ),
      ),
    });
    const oldVault = new IntegrationCredentialVault(prisma, oldRing);
    const plaintext = encoder.encode("key-rotation-secret");
    const created = await oldVault.create({
      provider: `rotation-${randomUUID()}`,
      accountName: "primary",
      plaintext,
      actorAdminUserId: actor.id,
    });
    assert.equal(created.keyVersion, 1);

    const reencrypted = await vault.reencryptWithActiveKey(created.id, actor.id);
    assert.equal(reencrypted.keyVersion, 2);
    assert.deepEqual(Buffer.from(await vault.reveal(created.id)), Buffer.from(plaintext));

    const stagingVault = new IntegrationCredentialVault(
      prisma,
      createCredentialKeyRing({
        environment: IntegrationEnvironment.STG,
        activeVersion: 2,
        serializedKeys: JSON.stringify(
          Object.fromEntries(
            [...keyRing.keys].map(([version, key]) => [
              version,
              Buffer.from(key).toString("base64"),
            ]),
          ),
        ),
      }),
    );
    await assert.rejects(stagingVault.reveal(created.id), CredentialNotFoundError);
    assert.deepEqual((await stagingVault.list(actor.id)).items, []);
  });

  it("keeps concurrent rotations valid and detects conflicting writes when applicable", async () => {
    const actor = await createAdmin();
    const created = await vault.create({
      provider: `concurrent-${randomUUID()}`,
      accountName: "primary",
      plaintext: encoder.encode("initial"),
      actorAdminUserId: actor.id,
    });
    const otherPrisma = createDatabaseClient({ databaseUrl, maxConnections: 4 });
    const otherVault = new IntegrationCredentialVault(otherPrisma, keyRing);

    try {
      const results = await Promise.allSettled([
        vault.rotate({
          credentialId: created.id,
          plaintext: encoder.encode("writer-a"),
          actorAdminUserId: actor.id,
        }),
        otherVault.rotate({
          credentialId: created.id,
          plaintext: encoder.encode("writer-b"),
          actorAdminUserId: actor.id,
        }),
      ]);
      assert.ok(results.some((result) => result.status === "fulfilled"));
      for (const result of results) {
        if (result.status === "rejected")
          assert.ok(result.reason instanceof CredentialConflictError);
      }
      const finalSecret = decoder.decode(await vault.reveal(created.id));
      assert.ok(["writer-a", "writer-b"].includes(finalSecret));
    } finally {
      await otherPrisma.$disconnect();
    }
  });

  it("paginates safe descriptors and validates all public input boundaries", async () => {
    const actor = await createAdmin();
    await vault.create({
      provider: `page-${randomUUID()}`,
      accountName: "primary",
      plaintext: encoder.encode("page-secret"),
      actorAdminUserId: actor.id,
    });
    const page = await vault.list(actor.id, { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = await vault.list(actor.id, { limit: 1, cursor: page.nextCursor });
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal(Object.hasOwn(next.items[0], "ciphertext"), false);

    await assert.rejects(vault.list(actor.id, { limit: 0 }), RangeError);
    await assert.rejects(vault.list(actor.id, { limit: 101 }), RangeError);
    await assert.rejects(vault.list(actor.id, { cursor: randomUUID() }), CredentialCursorError);
    await assert.rejects(vault.reveal("invalid"), TypeError);
    await assert.rejects(
      vault.rotate({
        credentialId: "invalid",
        plaintext: encoder.encode("x"),
        actorAdminUserId: actor.id,
      }),
      TypeError,
    );
    await assert.rejects(
      vault.create({
        provider: "INVALID",
        accountName: "primary",
        plaintext: encoder.encode("x"),
        actorAdminUserId: actor.id,
      }),
      TypeError,
    );
    await assert.rejects(
      vault.create({
        provider: "valid",
        accountName: "  ",
        plaintext: encoder.encode("x"),
        actorAdminUserId: actor.id,
      }),
      TypeError,
    );
  });
});

describe("F0.5 — complete RLS and Data API matrix over persisted fixtures", () => {
  it("denies all 2309 RLS SQL-grant and PostgREST role operations across tables and RPCs", async () => {
    const { runRlsMatrix } = await import("../scripts/rls-matrix.mjs");
    const summary = await runRlsMatrix(databaseUrl);
    assert.equal(summary.tables, 133);
    assert.equal(summary.functions, 16);
    assert.equal(summary.rlsOperations, 665);
    assert.equal(summary.dataApiOperations, 1644);
    assert.equal(summary.operations, 2309);
    assert.ok(summary.results.every((result) => result.passed));
  });
});
