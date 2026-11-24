import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  CachedUrlRedirectResolver,
  createDatabaseClient,
  UrlRedirectConflictError,
  UrlRedirectNotFoundError,
  UrlRedirectService,
  UrlRedirectValidationError,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

const cacheStateId = "00000000-0000-0000-0000-000000000001";

let harness;
let db;
let dbB;
let service;
let cacheB;
let actor;
let audit;

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function currentGeneration() {
  const state = await db.urlRedirectCacheState.findUnique({
    where: { id: cacheStateId },
    select: { version: true },
  });
  return state?.version ?? null;
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f23-url-redirects-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    dbB = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    service = new UrlRedirectService(db);
    cacheB = new CachedUrlRedirectResolver(dbB);
    actor = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `redirects-${randomUUID()}@example.test`,
        displayName: "Redirect Test Admin",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    });
    audit = {
      actorAdminUserId: actor.id,
      ipHash: randomBytes(32),
      userAgentHash: randomBytes(32),
    };
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (dbB) await dbB.$disconnect();
    if (db) await db.$disconnect();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F2.3 — persistent redirect graph, concurrency and audit", () => {
  it("creates, resolves, updates, disables, archives and recreates safe redirect chains", async () => {
    const suffix = randomUUID();
    const start = `/legacy-${suffix}`;
    const middle = `/campaign-${suffix}`;
    const end = `/productos`;
    const first = await service.create({ fromPath: start, toPath: middle, statusCode: 301 }, audit);
    const second = await service.create({ fromPath: middle, toPath: end, statusCode: 308 }, audit);
    assert.deepEqual(await service.resolve(start), {
      fromPath: start,
      toPath: end,
      statusCode: 301,
      hops: 2,
    });
    assert.equal((await service.get(first.id)).fromPath, start);
    assert.equal(await service.get("invalid"), null);
    assert.equal(await service.resolve("/sin-redireccion"), null);
    await assert.rejects(
      service.create({ fromPath: start, toPath: "/otro", statusCode: 308 }, audit),
      UrlRedirectConflictError,
    );
    await assert.rejects(
      service.update(second.id, { fromPath: middle, toPath: start, statusCode: 308 }, audit),
      UrlRedirectValidationError,
    );
    await assert.rejects(
      service.create({ fromPath: "/mismo", toPath: "/mismo" }, audit),
      UrlRedirectValidationError,
    );
    for (const unsafe of [
      { fromPath: "/", toPath: "/productos" },
      { fromPath: "/legal", toPath: "/productos" },
      { fromPath: "/legal/pqrs", toPath: "/productos" },
      { fromPath: "/ingresar", toPath: "/productos" },
      { fromPath: "/robots.txt", toPath: "/productos" },
      { fromPath: "/sitemap.xml", toPath: "/productos" },
      { fromPath: "/carrito", toPath: "/productos" },
      { fromPath: "/pagar/token-ejemplo", toPath: "/productos" },
      { fromPath: "/email/baja/token-ejemplo", toPath: "/productos" },
      { fromPath: "/origen", toPath: "/email/baja/token-ejemplo" },
      { fromPath: "/checkout", toPath: "/productos" },
      { fromPath: "https://evil.example", toPath: "/destino" },
      { fromPath: "/origen", toPath: "https://evil.example" },
      { fromPath: "/../secret", toPath: "/destino" },
      { fromPath: "/api/internal", toPath: "/destino" },
      { fromPath: "/origen", toPath: "/api/internal" },
      { fromPath: "/origen", toPath: "/admin/contenido" },
      { fromPath: "/origen", toPath: "/destino", statusCode: 300 },
    ]) {
      await assert.rejects(service.create(unsafe, audit), UrlRedirectValidationError);
    }

    await service.setActive(second.id, false, audit);
    assert.deepEqual(await service.resolve(start), {
      fromPath: start,
      toPath: middle,
      statusCode: 301,
      hops: 1,
    });
    await service.setActive(second.id, true, audit);
    assert.equal((await service.resolve(start)).hops, 2);
    await service.update(
      second.id,
      { fromPath: middle, toPath: "/comparar", statusCode: 307, active: true },
      audit,
    );
    assert.equal((await service.resolve(start)).toPath, "/comparar");
    const filtered = await service.list({ q: suffix, active: true, pageSize: 1, page: 1 });
    assert.equal(filtered.total, 2);
    assert.equal(filtered.totalPages, 2);
    assert.equal(filtered.items.length, 1);

    await service.archive(first.id, audit);
    assert.equal(await service.get(first.id), null);
    await assert.rejects(service.archive(first.id, audit), UrlRedirectNotFoundError);
    const recreated = await service.create(
      { fromPath: start, toPath: "/legal", statusCode: 302 },
      audit,
    );
    assert.equal(recreated.fromPath, start);
    assert.equal((await service.resolve(start)).toPath, "/legal");
    assert.ok(
      (await db.adminActionLog.count({
        where: { actorAdminUserId: actor.id, targetType: "UrlRedirect" },
      })) >= 7,
    );
  });

  it("serializes same-source races and prevents partial writes", async () => {
    const source = `/race-${randomUUID()}`;
    const outcomes = await Promise.allSettled([
      service.create({ fromPath: source, toPath: "/productos" }, audit),
      service.create({ fromPath: source, toPath: "/comparar" }, audit),
      service.create({ fromPath: source, toPath: "/legal" }, audit),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(
      outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof UrlRedirectConflictError,
      ).length,
      2,
    );
    assert.equal(await db.urlRedirect.count({ where: { fromPath: source, deletedAt: null } }), 1);
    const cycleA = `/cycle-a-${randomUUID()}`;
    const cycleB = `/cycle-b-${randomUUID()}`;
    const inactiveA = await service.create(
      { fromPath: cycleA, toPath: cycleB, active: false },
      audit,
    );
    const inactiveB = await service.create(
      { fromPath: cycleB, toPath: cycleA, active: false },
      audit,
    );
    const cycleOutcomes = await Promise.allSettled([
      service.setActive(inactiveA.id, true, audit),
      service.setActive(inactiveB.id, true, audit),
    ]);
    assert.equal(cycleOutcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(
      cycleOutcomes.filter(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof UrlRedirectValidationError,
      ).length,
      1,
    );
    assert.equal(
      await db.urlRedirect.count({
        where: { id: { in: [inactiveA.id, inactiveB.id] }, active: true, deletedAt: null },
      }),
      1,
    );
  });
});

describe("A1 — shared redirect cache generation across independent processes", () => {
  it("refreshes a warm independent cache immediately after every service mutation", async () => {
    const source = `/shared-cache-${randomUUID()}`;
    let generation = await currentGeneration();
    assert.equal(await cacheB.resolve(source), null);

    const created = await service.create(
      { fromPath: source, toPath: "/productos", statusCode: 308 },
      audit,
    );
    assert.equal(await currentGeneration(), generation + 1n);
    assert.deepEqual(await cacheB.resolve(source), {
      toPath: "/productos",
      statusCode: 308,
      hops: 1,
    });

    generation = await currentGeneration();
    await service.setActive(created.id, true, audit);
    assert.equal(await currentGeneration(), generation + 1n);
    assert.deepEqual(await cacheB.resolve(source), {
      toPath: "/productos",
      statusCode: 308,
      hops: 1,
    });

    generation = await currentGeneration();
    await service.update(
      created.id,
      { fromPath: source, toPath: "/comparar", statusCode: 302, active: true },
      audit,
    );
    assert.equal(await currentGeneration(), generation + 1n);
    assert.deepEqual(await cacheB.resolve(source), {
      toPath: "/comparar",
      statusCode: 302,
      hops: 1,
    });

    generation = await currentGeneration();
    await service.setActive(created.id, false, audit);
    assert.equal(await currentGeneration(), generation + 1n);
    assert.equal(await cacheB.resolve(source), null);

    generation = await currentGeneration();
    await service.setActive(created.id, true, audit);
    assert.equal(await currentGeneration(), generation + 1n);
    assert.deepEqual(await cacheB.resolve(source), {
      toPath: "/comparar",
      statusCode: 302,
      hops: 1,
    });

    generation = await currentGeneration();
    await service.archive(created.id, audit);
    assert.equal(await currentGeneration(), generation + 1n);
    assert.equal(await cacheB.resolve(source), null);

    generation = await currentGeneration();
    await service.create({ fromPath: source, toPath: "/legal", statusCode: 301 }, audit);
    assert.equal(await currentGeneration(), generation + 1n);
    assert.deepEqual(await cacheB.resolve(source), {
      toPath: "/legal",
      statusCode: 301,
      hops: 1,
    });
  });

  it("discards mutation-during-load snapshots and separates pending generations", async () => {
    const source = `/load-race-${randomUUID()}`;
    const created = await service.create(
      { fromPath: source, toPath: "/productos", statusCode: 308 },
      audit,
    );
    const racingCache = new CachedUrlRedirectResolver(dbB);
    const originalLoadEdges = racingCache.loadEdges.bind(racingCache);
    const edgesRead = deferred();
    const continueLoad = deferred();
    let intercept = true;
    racingCache.loadEdges = async () => {
      const edges = await originalLoadEdges();
      if (intercept) {
        intercept = false;
        edgesRead.resolve();
        await continueLoad.promise;
      }
      return edges;
    };

    const firstRequest = racingCache.resolve(source);
    try {
      await edgesRead.promise;
      await service.update(
        created.id,
        { fromPath: source, toPath: "/comparar", statusCode: 307, active: true },
        audit,
      );
      const generation = await currentGeneration();
      const secondRequest = racingCache.resolve(source);
      assert.deepEqual(await secondRequest, {
        toPath: "/comparar",
        statusCode: 307,
        hops: 1,
      });
      assert.equal(racingCache.snapshot.generation, generation);
    } finally {
      continueLoad.resolve();
    }

    assert.deepEqual(await firstRequest, {
      toPath: "/comparar",
      statusCode: 307,
      hops: 1,
    });
    assert.equal(racingCache.snapshot.generation, await currentGeneration());
  });

  it("fails closed without the singleton and rolls back every mutation and audit row", async () => {
    const source = `/missing-generation-${randomUUID()}`;
    const rejectedSource = `/missing-generation-create-${randomUUID()}`;
    const created = await service.create(
      { fromPath: source, toPath: "/productos", statusCode: 308 },
      audit,
    );
    const cache = new CachedUrlRedirectResolver(dbB);
    assert.equal((await cache.resolve(source)).toPath, "/productos");
    const generation = await currentGeneration();
    const auditCount = await db.adminActionLog.count({
      where: { actorAdminUserId: actor.id, targetType: "UrlRedirect" },
    });
    await db.urlRedirectCacheState.delete({ where: { id: cacheStateId } });

    try {
      await assert.rejects(cache.resolve(source), /cache generation is not initialized/);
      await assert.rejects(
        service.create({ fromPath: rejectedSource, toPath: "/legal" }, audit),
        /cache generation is not initialized/,
      );
      await assert.rejects(
        service.update(
          created.id,
          { fromPath: source, toPath: "/comparar", statusCode: 308, active: true },
          audit,
        ),
        /cache generation is not initialized/,
      );
      await assert.rejects(
        service.setActive(created.id, false, audit),
        /cache generation is not initialized/,
      );
      await assert.rejects(
        service.archive(created.id, audit),
        /cache generation is not initialized/,
      );

      const unchanged = await db.urlRedirect.findUnique({ where: { id: created.id } });
      assert.equal(unchanged.toPath, "/productos");
      assert.equal(unchanged.active, true);
      assert.equal(unchanged.deletedAt, null);
      assert.equal(
        await db.urlRedirect.count({ where: { fromPath: rejectedSource, deletedAt: null } }),
        0,
      );
      assert.equal(
        await db.adminActionLog.count({
          where: { actorAdminUserId: actor.id, targetType: "UrlRedirect" },
        }),
        auditCount,
      );
    } finally {
      if ((await currentGeneration()) === null) {
        await db.urlRedirectCacheState.create({ data: { version: generation } });
      }
    }

    assert.equal((await cache.resolve(source)).toPath, "/productos");
  });

  it("enforces singleton constraints and revokes Data API access", async () => {
    const client = new pg.Client({
      connectionString: harness.databaseUrl,
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    try {
      await assert.rejects(
        client.query(`UPDATE "UrlRedirectCacheState" SET "version" = -1 WHERE "id" = $1`, [
          cacheStateId,
        ]),
        (error) => error.code === "23514",
      );
      await assert.rejects(
        client.query(`INSERT INTO "UrlRedirectCacheState" ("id") VALUES ($1)`, [randomUUID()]),
        (error) => error.code === "23514",
      );
      for (const role of ["anon", "authenticated", "service_role"]) {
        await client.query(`SET ROLE ${role}`);
        await assert.rejects(
          client.query(`SELECT * FROM public."UrlRedirectCacheState"`),
          (error) => error.code === "42501",
        );
        await client.query("RESET ROLE");
      }
    } finally {
      await client.end();
    }
  });
});
