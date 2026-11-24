import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AdminOperationRateLimitError,
  OperationRateLimitError,
  consumeAdminOperationRateLimit,
  consumeOperationRateLimit,
  createDatabaseClient,
  purgeExpiredOperationRateLimits,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

let harness;
let sql;
let first;
let second;
const actorId = randomUUID();
const ipHash = randomBytes(32);

function options(overrides = {}) {
  return {
    operation: "crm.duplicates.detect",
    actorAdminUserId: actorId,
    ipHash,
    limit: 20,
    windowSeconds: 60,
    throwOnLimit: false,
    ...overrides,
  };
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "a2-admin-rate-limit-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    first = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 5 });
    second = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 5 });
  },
  { timeout: 240_000 },
);

after(async () => {
  if (first) await first.$disconnect();
  if (second) await second.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("A2 — cuota administrativa persistente y distribuida", () => {
  it("serializa dos instancias concurrentes y devuelve Retry-After exacto", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        consumeAdminOperationRateLimit(index % 2 === 0 ? first : second, options()),
      ),
    );
    assert.equal(results.filter((result) => result.allowed).length, 20);
    const rejected = results.filter((result) => !result.allowed);
    assert.equal(rejected.length, 20);
    assert.ok(rejected.every((result) => result.retryAfterSeconds >= 1));
    assert.ok(rejected.every((result) => result.retryAfterSeconds <= 60));
    assert.ok(rejected.every((result) => result.remaining === 0));
    const stored = await sql.query(
      `SELECT "count", "subjectType", "subjectHash", "ipHash" FROM "OperationRateLimit"
       WHERE "operation" = 'crm.duplicates.detect'`,
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].count, 40);
    assert.equal(stored.rows[0].subjectType, "ADMIN_USER");
    assert.equal(stored.rows[0].subjectHash.length, 32);
    assert.equal(stored.rows[0].ipHash.length, 32);
    assert.notEqual(stored.rows[0].subjectHash.toString("utf8"), actorId);
  });

  it("separa operación, actor e IP y lanza un error fail-closed", async () => {
    const base = { limit: 1, windowSeconds: 60, actorAdminUserId: randomUUID() };
    assert.equal((await consumeAdminOperationRateLimit(first, options(base))).allowed, true);
    assert.equal(
      (await consumeAdminOperationRateLimit(second, options({ ...base, ipHash: randomBytes(32) })))
        .allowed,
      true,
    );
    assert.equal(
      (
        await consumeAdminOperationRateLimit(
          second,
          options({ ...base, actorAdminUserId: randomUUID() }),
        )
      ).allowed,
      true,
    );
    assert.equal(
      (
        await consumeAdminOperationRateLimit(
          second,
          options({ ...base, operation: "lifecycle.segment.refresh" }),
        )
      ).allowed,
      true,
    );
    await assert.rejects(
      consumeAdminOperationRateLimit(first, { ...options(base), throwOnLimit: true }),
      (error) =>
        error instanceof AdminOperationRateLimitError &&
        error.retryAfterSeconds >= 1 &&
        error.remaining === 0,
    );
    await assert.rejects(
      consumeAdminOperationRateLimit(first, options({ ipHash: randomBytes(31) })),
      TypeError,
    );
    await assert.rejects(
      consumeAdminOperationRateLimit(
        {
          $queryRaw: async () => {
            throw new Error("database unavailable");
          },
        },
        options(),
      ),
      /database unavailable/,
    );
  });

  it("comparte buckets ORDER entre instancias y frena rotación de pedidos con sujeto IP", async () => {
    const orderId = randomUUID();
    const orderOptions = {
      operation: "payments.wompi.verify.order",
      subject: { type: "ORDER", orderId },
      ipHash,
      limit: 3,
      windowSeconds: 60,
      throwOnLimit: false,
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        consumeOperationRateLimit(index % 2 === 0 ? first : second, orderOptions),
      ),
    );
    assert.equal(concurrent.filter((result) => result.allowed).length, 3);
    assert.equal(concurrent.filter((result) => !result.allowed).length, 5);
    assert.ok(
      concurrent
        .filter((result) => !result.allowed)
        .every((result) => result.retryAfterSeconds > 0),
    );
    assert.equal(
      (
        await consumeOperationRateLimit(first, {
          ...orderOptions,
          subject: { type: "ORDER", orderId: randomUUID() },
        })
      ).allowed,
      true,
    );
    assert.equal(
      (await consumeOperationRateLimit(first, { ...orderOptions, ipHash: randomBytes(32) }))
        .allowed,
      true,
    );

    const globalResults = [];
    for (let index = 0; index < 6; index += 1) {
      const perOrder = await consumeOperationRateLimit(first, {
        ...orderOptions,
        subject: { type: "ORDER", orderId: randomUUID() },
        limit: 1,
      });
      assert.equal(perOrder.allowed, true);
      globalResults.push(
        await consumeOperationRateLimit(second, {
          operation: "payments.wompi.verify.ip",
          subject: { type: "IP" },
          ipHash,
          limit: 3,
          windowSeconds: 60,
          throwOnLimit: false,
        }),
      );
    }
    assert.equal(globalResults.filter((result) => result.allowed).length, 3);
    assert.equal(globalResults.filter((result) => !result.allowed).length, 3);
    await assert.rejects(
      consumeOperationRateLimit(first, {
        operation: "payments.wompi.verify.ip",
        subject: { type: "IP" },
        ipHash,
        limit: 3,
        windowSeconds: 60,
      }),
      (error) => error instanceof OperationRateLimitError && error.retryAfterSeconds > 0,
    );
    await assert.rejects(
      consumeOperationRateLimit(first, {
        operation: "payments.wompi.verify.ip",
        subject: { type: "IP" },
        ipHash: randomBytes(31),
        limit: 3,
        windowSeconds: 60,
      }),
      TypeError,
    );
  });

  it("purga expirados por lotes y mantiene RLS/Data API deny-by-default", async () => {
    await sql.query(
      `UPDATE "OperationRateLimit" SET
        "windowStartedAt" = "windowStartedAt" - INTERVAL '2 hours',
        "expiresAt" = "expiresAt" - INTERVAL '2 hours'`,
    );
    const purged = await purgeExpiredOperationRateLimits(first, 1000);
    assert.ok(purged >= 5);
    const remaining = await sql.query(
      `SELECT count(*)::int AS count FROM "OperationRateLimit" WHERE "expiresAt" <= CURRENT_TIMESTAMP`,
    );
    assert.equal(remaining.rows[0].count, 0);
    const posture = await sql.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"OperationRateLimit"'::regclass`,
    );
    assert.deepEqual(posture.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const privileges = await sql.query(
        `SELECT has_table_privilege($1, '"OperationRateLimit"', 'SELECT') AS allowed`,
        [role],
      );
      assert.equal(privileges.rows[0].allowed, false);
    }
  });
});
