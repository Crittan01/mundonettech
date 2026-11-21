import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  createDatabaseClient,
  UrlRedirectConflictError,
  UrlRedirectNotFoundError,
  UrlRedirectService,
  UrlRedirectValidationError,
} from "../packages/db/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

let harness;
let db;
let service;
let actor;
let audit;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f23-url-redirects-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    service = new UrlRedirectService(db);
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
      { fromPath: "https://evil.example", toPath: "/destino" },
      { fromPath: "/origen", toPath: "https://evil.example" },
      { fromPath: "/../secret", toPath: "/destino" },
      { fromPath: "/api/internal", toPath: "/destino" },
      { fromPath: "/origen", toPath: "/api/internal" },
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
