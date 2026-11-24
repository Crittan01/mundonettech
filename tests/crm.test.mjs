import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AccountService,
  CrmError,
  CrmMergeService,
  CrmRetentionService,
  CrmService,
  OperationsService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { databaseNow, recordAdminAction } from "../packages/db/dist/primitives.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

let harness;
let sql;
let db;
let crm;
let merges;
let retention;
let adminId;
let supportId;
let audit;
let supportAudit;

function bytes() {
  return Uint8Array.from(randomBytes(32));
}

function future(hours = 48) {
  return new Date(Date.now() + hours * 3_600_000);
}

let phoneSequence = 100000000;

function contactInput(overrides = {}) {
  const id = randomUUID().slice(0, 8);
  phoneSequence += 1;
  return {
    givenName: "Laura",
    familyName: "Rodríguez",
    email: `crm-${id}@example.test`,
    phoneE164: `+573${phoneSequence}`,
    source: "admin-crm",
    ...overrides,
  };
}

async function createContact(overrides = {}) {
  return crm.createContact(contactInput(overrides), audit);
}

async function candidateFor(source, target) {
  const detected = await crm.detectDuplicates({ contactId: source.id }, audit);
  assert.equal(detected.candidates.length >= 1, true);
  return db.identityMergeCandidate.findFirstOrThrow({
    where: {
      status: "PENDING",
      OR: [
        { sourceContactId: source.id, targetContactId: target.id },
        { sourceContactId: target.id, targetContactId: source.id },
      ],
    },
  });
}

before(async () => {
  harness = await acquireIsolatedTestDatabase({
    containerName: "f4b1-crm-test_mundonettech",
    port: 54428,
  });
  sql = new pg.Client({ connectionString: harness.databaseUrl });
  await sql.connect();
  db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
  adminId = randomUUID();
  supportId = randomUUID();
  await db.adminUser.createMany({
    data: [
      {
        id: adminId,
        authUserId: randomUUID(),
        email: `crm-admin-${randomUUID()}@example.test`,
        displayName: "Administrador CRM",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
      {
        id: supportId,
        authUserId: randomUUID(),
        email: `crm-support-${randomUUID()}@example.test`,
        displayName: "Soporte CRM",
        role: "CUSTOMER_SUPPORT",
        status: "ACTIVE",
      },
    ],
  });
  crm = new CrmService(db);
  merges = new CrmMergeService(db);
  retention = new CrmRetentionService(db);
  audit = {
    actorAdminUserId: adminId,
    ipHash: bytes(),
    userAgentHash: bytes(),
    requestId: randomUUID(),
  };
  supportAudit = { ...audit, actorAdminUserId: supportId, requestId: randomUUID() };
});

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("CRM 360 production behavior", () => {
  it("reads the authoritative PG17 clock through client and transaction executors", async () => {
    const clientNow = await databaseNow(db);
    assert.ok(clientNow instanceof Date);
    assert.ok(Math.abs(clientNow.getTime() - Date.now()) < 10_000);
    await db.$transaction(async (tx) => {
      const transactionNow = await databaseNow(tx);
      const rows = await tx.$queryRaw`SELECT CURRENT_TIMESTAMP AS now`;
      assert.ok(transactionNow instanceof Date);
      assert.equal(transactionNow.getTime(), rows[0].now.getTime());
    });
  });

  it("persists shared audit hashes and request IDs while PG17 derives selfDealing", async () => {
    const requestId = randomUUID();
    const generatedTargetId = randomUUID();
    const ipHash = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
    const userAgentHash = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 32));
    await db.$transaction(async (tx) => {
      await recordAdminAction(
        tx,
        { actorAdminUserId: adminId, ipHash, userAgentHash, requestId },
        "CRM_PRIMITIVE_AUDIT",
        "AdminUser",
        adminId,
        { verified: true },
      );
      await recordAdminAction(
        tx,
        { actorAdminUserId: adminId, ipHash, userAgentHash: null },
        "CRM_PRIMITIVE_AUDIT_GENERATED",
        "Contact",
        generatedTargetId,
      );
    });
    const persisted = await db.adminActionLog.findFirstOrThrow({ where: { requestId } });
    assert.equal(persisted.targetAdminUserId, adminId);
    assert.equal(persisted.selfDealing, true);
    assert.deepEqual(Uint8Array.from(persisted.ipHash), ipHash);
    assert.deepEqual(Uint8Array.from(persisted.userAgentHash), userAgentHash);
    assert.deepEqual(persisted.metadata, { verified: true });
    const generated = await db.adminActionLog.findFirstOrThrow({
      where: { action: "CRM_PRIMITIVE_AUDIT_GENERATED", targetId: generatedTargetId },
    });
    assert.match(
      generated.requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(generated.userAgentHash, null);
    assert.equal(generated.selfDealing, false);
  });

  it("persists organizations, masked contacts, verification, activities and tasks", async () => {
    const organization = await crm.createOrganization(
      { legalName: "Comercializadora Andina", commercialName: "Andina", taxId: "901.234.567-8" },
      audit,
    );
    const contact = await createContact({ organizationId: organization.id });
    assert.equal(contact.status, "ACTIVE");
    assert.equal(contact.verificationLevel, "UNVERIFIED");
    const list = await crm.listContacts({ query: contact.email });
    assert.equal(list.items.length, 1);
    assert.notEqual(list.items[0].email, contact.email);
    assert.equal(list.items[0].givenName, "L•••");
    assert.equal(JSON.stringify(list).includes(contact.email), false);
    const organizations = await crm.listOrganizations();
    assert.equal(JSON.stringify(organizations).includes("901.234.567-8"), false);

    const verified = await crm.verifyContact(
      {
        contactId: contact.id,
        expectedVersion: contact.version,
        level: "IDENTITY_VERIFIED",
        document: "CC-1020304050",
      },
      audit,
    );
    assert.equal(verified.verificationLevel, "IDENTITY_VERIFIED");
    const activity = await crm.addActivity(
      {
        contactId: contact.id,
        kind: "NOTE",
        subject: "Revisión comercial",
        body: "Se validaron los canales y el documento aportado.",
      },
      supportAudit,
    );
    const task = await crm.createTask(
      {
        contactId: contact.id,
        title: "Contactar para renovación",
        description: "Confirmar la necesidad comercial vigente.",
        dueAt: future(),
        assignedToAdminUserId: supportId,
        priority: "HIGH",
      },
      supportAudit,
    );
    const completed = await crm.updateTask(
      {
        taskId: task.id,
        expectedVersion: task.version,
        title: task.title,
        description: task.description,
        status: "COMPLETED",
        priority: task.priority,
        dueAt: task.dueAt,
        assignedToAdminUserId: supportId,
      },
      supportAudit,
    );
    assert.ok(completed.completedAt);
    await assert.rejects(
      crm.updateTask(
        {
          taskId: task.id,
          expectedVersion: completed.version,
          title: task.title,
          status: "PENDING",
          priority: task.priority,
          dueAt: task.dueAt,
          assignedToAdminUserId: supportId,
        },
        supportAudit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
    const detail = await crm.getContact360(contact.id);
    assert.equal(detail.activities[0].id, activity.id);
    assert.equal(detail.tasks[0].status, "COMPLETED");
    assert.equal(
      detail.identities.some((identity) => identity.kind === "DOCUMENT"),
      true,
    );
    assert.equal(JSON.stringify(detail).includes("CC-1020304050"), false);
  });

  it("merges duplicate identities and reverses all owned records exactly once", async () => {
    const email = `duplicate-${randomUUID()}@example.test`;
    const first = await createContact({ email, phoneE164: "+573001111111" });
    const second = await createContact({ email, phoneE164: "+573002222222" });
    const activity = await crm.addActivity(
      { contactId: second.id, kind: "CALL", body: "Llamada que debe sobrevivir a la fusión." },
      audit,
    );
    const task = await crm.createTask(
      { contactId: second.id, title: "Tarea trasladada", dueAt: future() },
      audit,
    );
    const candidate = await candidateFor(first, second);
    const source = await db.contact.findUniqueOrThrow({ where: { id: candidate.sourceContactId } });
    const target = await db.contact.findUniqueOrThrow({ where: { id: candidate.targetContactId } });
    await assert.rejects(
      merges.merge(
        {
          candidateId: candidate.id,
          expectedVersion: candidate.version,
          expectedSourceVersion: source.version + 1,
          expectedTargetVersion: target.version,
          note: "Fusión con versión obsoleta.",
        },
        audit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
    const merged = await merges.merge(
      {
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        expectedSourceVersion: source.version,
        expectedTargetVersion: target.version,
        note: "Identidades revisadas y fusionadas por el operador.",
      },
      audit,
    );
    const mergedSource = await db.contact.findUniqueOrThrow({ where: { id: source.id } });
    assert.equal(mergedSource.status, "MERGED");
    assert.equal(mergedSource.mergedIntoContactId, target.id);
    assert.equal(
      await db.contactActivity.count({ where: { id: activity.id, contactId: target.id } }),
      1,
    );
    assert.equal(await db.task.count({ where: { id: task.id, contactId: target.id } }), 1);
    const reversed = await merges.reverse(
      {
        candidateId: candidate.id,
        expectedVersion: merged.candidate.version,
        note: "Reversión verificada por discrepancia documental.",
      },
      audit,
    );
    assert.equal(reversed.candidate.status, "REVERSED");
    assert.equal(
      (await db.contact.findUniqueOrThrow({ where: { id: source.id } })).status,
      "ACTIVE",
    );
    assert.equal(
      await db.contactActivity.count({ where: { id: activity.id, contactId: source.id } }),
      1,
    );
    assert.equal(await db.task.count({ where: { id: task.id, contactId: source.id } }), 1);
    await assert.rejects(
      merges.reverse(
        { candidateId: candidate.id, expectedVersion: 3, note: "Intento de reversa duplicado." },
        audit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
  });

  it("detects each pair once under concurrency and blocks stale reversal", async () => {
    const email = `race-${randomUUID()}@example.test`;
    const first = await createContact({ email });
    const second = await createContact({ email });
    const detected = await Promise.all([
      crm.detectDuplicates({ contactId: first.id }, audit),
      crm.detectDuplicates({ contactId: second.id }, audit),
    ]);
    assert.equal(
      detected.reduce((sum, item) => sum + item.created, 0),
      1,
    );
    const candidate = await candidateFor(first, second);
    const source = await db.contact.findUniqueOrThrow({ where: { id: candidate.sourceContactId } });
    const target = await db.contact.findUniqueOrThrow({ where: { id: candidate.targetContactId } });
    const merged = await merges.merge(
      {
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        expectedSourceVersion: source.version,
        expectedTargetVersion: target.version,
        note: "Fusión para comprobar reversa con cambios posteriores.",
      },
      audit,
    );
    await crm.addActivity(
      { contactId: target.id, kind: "NOTE", body: "Nueva gestión posterior a la fusión." },
      audit,
    );
    await assert.rejects(
      merges.reverse(
        {
          candidateId: candidate.id,
          expectedVersion: merged.candidate.version,
          note: "No debe revertirse con actividad posterior.",
        },
        audit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
  });

  it("enforces merge RBAC and persists human rejection", async () => {
    const email = `rbac-${randomUUID()}@example.test`;
    const first = await createContact({ email });
    await createContact({ email });
    const candidate = await candidateFor(
      first,
      await db.contact.findFirstOrThrow({ where: { email, id: { not: first.id } } }),
    );
    await assert.rejects(
      merges.reject(
        {
          candidateId: candidate.id,
          expectedVersion: candidate.version,
          note: "Rechazo sin privilegio.",
        },
        supportAudit,
      ),
      (error) => error instanceof CrmError && error.code === "FORBIDDEN",
    );
    const rejected = await merges.reject(
      {
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        note: "Son personas distintas verificadas.",
      },
      audit,
    );
    assert.equal(rejected.status, "REJECTED");
    const repeated = await crm.detectDuplicates({ contactId: first.id }, audit);
    assert.equal(repeated.created, 0);
  });

  it("anonymizes merged lineage, activities, identities and snapshots", async () => {
    const email = `retention-${randomUUID()}@example.test`;
    const first = await createContact({ email, phoneE164: "+573003333333" });
    const second = await createContact({ email, phoneE164: "+573004444444" });
    await crm.addActivity(
      { contactId: second.id, kind: "NOTE", subject: email, body: `Dato directo ${email}` },
      audit,
    );
    const candidate = await candidateFor(first, second);
    const source = await db.contact.findUniqueOrThrow({ where: { id: candidate.sourceContactId } });
    const target = await db.contact.findUniqueOrThrow({ where: { id: candidate.targetContactId } });
    const merged = await merges.merge(
      {
        candidateId: candidate.id,
        expectedVersion: candidate.version,
        expectedSourceVersion: source.version,
        expectedTargetVersion: target.version,
        note: "Fusión previa a la supresión de todo el linaje.",
      },
      audit,
    );
    const suppressed = await retention.suppress(
      {
        contactId: target.id,
        expectedVersion: merged.candidate.mergedTargetVersion,
        reason: "DATA_SUBJECT_REQUEST",
        privacyPolicyVersion: "1.0.0",
      },
      audit,
    );
    assert.equal(suppressed.lineage.length, 2);
    const contacts = await db.contact.findMany({ where: { id: { in: suppressed.lineage } } });
    assert.equal(
      contacts.every((contact) => contact.status === "ANONYMIZED"),
      true,
    );
    assert.equal(
      contacts.every((contact) => contact.email === null && contact.givenName === null),
      true,
    );
    assert.equal(
      await db.contactIdentity.count({
        where: { contactId: { in: suppressed.lineage } },
      }),
      0,
    );
    const activity = await db.contactActivity.findFirstOrThrow({
      where: { contactId: { in: suppressed.lineage } },
    });
    assert.equal(activity.body, "[contenido suprimido por retención]");
    const redacted = await db.identityMergeCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    assert.deepEqual(redacted.sourceSnapshot, { redacted: true });
    assert.equal(JSON.stringify(redacted).includes(email), false);
    await assert.rejects(
      merges.reverse(
        {
          candidateId: candidate.id,
          expectedVersion: redacted.version,
          note: "No se revierte una supresión.",
        },
        audit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
  });

  it("keeps manual CRM task guards distinct from self-service cancellation", async () => {
    const contact = await createContact();
    const activity = await crm.addActivity(
      { contactId: contact.id, kind: "NOTE", body: "No debe redactarse tras un guard fallido." },
      audit,
    );
    const task = await crm.createTask(
      { contactId: contact.id, title: "Obligación CRM abierta", dueAt: future() },
      supportAudit,
    );
    const currentContact = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    await assert.rejects(
      retention.suppress(
        {
          contactId: contact.id,
          expectedVersion: currentContact.version,
          reason: "DATA_SUBJECT_REQUEST",
          privacyPolicyVersion: "1.0.0",
        },
        audit,
      ),
      (error) =>
        error instanceof CrmError &&
        error.code === "CONFLICT" &&
        error.message.includes("Resolve open CRM tasks"),
    );
    const persistedTask = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(persistedTask.status, "PENDING");
    assert.equal(persistedTask.version, task.version);
    assert.equal(persistedTask.redactedAt, null);
    assert.equal(
      (await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).status,
      "ACTIVE",
    );
    assert.equal(
      (await db.contactActivity.findUniqueOrThrow({ where: { id: activity.id } })).redactedAt,
      null,
    );
  });

  it("anonymizes a linked guest and defers retention with active obligations", async () => {
    const guest = await db.customer.create({
      data: {
        email: `guest-${randomUUID()}@example.test`,
        givenName: "Invitado",
        familyName: "Comprador",
        phoneE164: "+573005555555",
        status: "GUEST",
      },
    });
    const contact = await crm.syncCustomerContact(guest.id);
    const result = await retention.suppress(
      {
        contactId: contact.id,
        expectedVersion: contact.version,
        reason: "DATA_SUBJECT_REQUEST",
        privacyPolicyVersion: "1.0.0",
      },
      audit,
    );
    assert.deepEqual(result.customers, [guest.id]);
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: guest.id } })).status,
      "ANONYMIZED",
    );

    const blockedCustomer = await db.customer.create({
      data: {
        email: `blocked-${randomUUID()}@example.test`,
        givenName: "Cliente",
        familyName: "Con obligación",
        status: "GUEST",
      },
    });
    const blockedContact = await crm.syncCustomerContact(blockedCustomer.id);
    await db.order.create({
      data: {
        orderNumber: `CRM-${randomUUID().slice(0, 12).toUpperCase()}`,
        customerId: blockedCustomer.id,
        orderStatus: "PENDING",
        paymentStatus: "UNPAID",
        fulfillmentStatus: "UNFULFILLED",
        taxRegime: "NO_RESPONSABLE_IVA",
      },
    });
    await sql.query(
      `UPDATE "Contact" SET "retentionReviewAt" = "createdAt" + INTERVAL '1 microsecond' WHERE "id" = $1`,
      [blockedContact.id],
    );
    const run = await retention.runDue({ privacyPolicyVersion: "1.0.0" }, audit);
    assert.equal(run.deferred.includes(blockedContact.id), true);
    assert.equal(run.suppressed.includes(blockedContact.id), false);
    const deferred = await db.contact.findUniqueOrThrow({ where: { id: blockedContact.id } });
    assert.equal(deferred.status, "ACTIVE");
    assert.ok(deferred.retentionReviewAt > new Date());
  });

  it("blocks destructive or historical mutations directly in PostgreSQL", async () => {
    const contact = await createContact();
    await assert.rejects(
      sql.query(`DELETE FROM "Contact" WHERE "id" = $1`, [contact.id]),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      sql.query(
        `UPDATE "Contact" SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '10 years' WHERE "id" = $1`,
        [contact.id],
      ),
      (error) => error.code === "55000" || error.code === "23514",
    );
    const activity = await crm.addActivity(
      { contactId: contact.id, kind: "NOTE", body: "Contenido inmutable." },
      audit,
    );
    const otherContact = await createContact();
    await assert.rejects(
      sql.query(
        `UPDATE "ContactActivity" SET "body" = 'Alterado', "contactId" = $2 WHERE "id" = $1`,
        [activity.id, otherContact.id],
      ),
      (error) => error.code === "55000",
    );
    const task = await crm.createTask(
      { contactId: contact.id, title: "Tarea inmutable", dueAt: future() },
      audit,
    );
    await assert.rejects(sql.query(`DELETE FROM "Task" WHERE "id" = $1`, [task.id]));
  });

  it("isolates pair matchReasons across triplets, guards duplicate NITs, preserves masked NIT/checkout source and searches 360 identities", async () => {
    const sharedTaxId = `900.${randomUUID().slice(0, 8).toUpperCase()}`;
    const org = await crm.createOrganization(
      { legalName: "Grupo Empresarial Norte", commercialName: "Norte Tech", taxId: sharedTaxId },
      audit,
    );
    await assert.rejects(
      crm.createOrganization({ legalName: "Duplicada NIT", taxId: sharedTaxId }, audit),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );
    const updatedOrg = await crm.updateOrganization(
      {
        organizationId: org.id,
        expectedVersion: org.version,
        legalName: "Grupo Empresarial Norte SAS",
        commercialName: "Norte Tech B2B",
      },
      audit,
    );
    assert.equal(updatedOrg.taxId, sharedTaxId);

    await assert.rejects(
      createContact({ source: "Fuente Invalida Con Mayusculas" }),
      (error) => error instanceof CrmError && error.code === "VALIDATION",
    );

    const sharedEmail = `triplet-${randomUUID()}@example.test`;
    const sharedPhone = `+57399${String(Math.floor(Math.random() * 9000000 + 1000000))}`;
    const contactA = await createContact({
      givenName: "Camila",
      familyName: "Restrepo",
      email: sharedEmail,
      phoneE164: sharedPhone,
      organizationId: org.id,
    });
    const contactB = await createContact({
      givenName: "Camila",
      familyName: "Dos",
      email: sharedEmail,
    });
    const contactC = await createContact({
      givenName: "Camila",
      familyName: "Tres",
      phoneE164: sharedPhone,
    });

    await crm.detectDuplicates({ contactId: contactA.id }, audit);
    const abKey = [contactA.id, contactB.id].sort().join(":");
    const acKey = [contactA.id, contactC.id].sort().join(":");
    const abCandidate = await db.identityMergeCandidate.findFirstOrThrow({
      where: { pairKey: abKey, status: "PENDING" },
    });
    const acCandidate = await db.identityMergeCandidate.findFirstOrThrow({
      where: { pairKey: acKey, status: "PENDING" },
    });
    assert.deepEqual(abCandidate.matchReasons, ["EMAIL_EXACT"]);
    assert.deepEqual(acCandidate.matchReasons, ["PHONE_EXACT"]);

    const docCode = `NIT-${randomUUID().slice(0, 10).toUpperCase()}`;
    await crm.verifyContact(
      {
        contactId: contactA.id,
        expectedVersion: contactA.version,
        level: "IDENTITY_VERIFIED",
        document: docCode,
      },
      audit,
    );
    const byFullName = await crm.listContacts({ query: "Camila Restrepo" });
    assert.equal(
      byFullName.items.some((item) => item.id === contactA.id),
      true,
    );
    const byCommercial = await crm.listContacts({ query: "Norte Tech B2B" });
    assert.equal(
      byCommercial.items.some((item) => item.id === contactA.id),
      true,
    );
    const byDocument = await crm.listContacts({ query: docCode });
    assert.equal(
      byDocument.items.some((item) => item.id === contactA.id),
      true,
    );
    await assert.rejects(
      crm.listContacts({ cursor: randomUUID() }),
      (error) => error instanceof CrmError && error.code === "NOT_FOUND",
    );
  });

  it("handles customer phone changes without verification spoofing, cascades /mi-cuenta erasure to CRM lineage, blocks archived-org reversal and scopes /admin/hoy alerts", async () => {
    const customer = await db.customer.create({
      data: {
        authUserId: randomUUID(),
        email: `sync-${randomUUID()}@example.test`,
        givenName: "Mateo",
        familyName: "Gómez",
        phoneE164: "+573151112233",
        status: "ACTIVE",
      },
    });
    const synced = await crm.syncCustomerContact(customer.id);
    assert.equal(synced.verificationLevel, "SINGLE_CHANNEL_VERIFIED");
    const dualVerified = await crm.verifyContact(
      {
        contactId: synced.id,
        expectedVersion: synced.version,
        level: "DUAL_CHANNEL_VERIFIED",
      },
      audit,
    );
    assert.equal(dualVerified.verificationLevel, "DUAL_CHANNEL_VERIFIED");

    await db.customer.update({ where: { id: customer.id }, data: { phoneE164: null } });
    const preservedPhone = await crm.syncCustomerContact(customer.id);
    assert.equal(preservedPhone.phoneE164, "+573151112233");
    assert.equal(preservedPhone.verificationLevel, "DUAL_CHANNEL_VERIFIED");

    await db.customer.update({
      where: { id: customer.id },
      data: { phoneE164: "+573159998877" },
    });
    const downgraded = await crm.syncCustomerContact(customer.id);
    assert.equal(downgraded.phoneE164, "+573159998877");
    assert.equal(downgraded.verificationLevel, "SINGLE_CHANNEL_VERIFIED");

    const edited = await crm.updateContact(
      {
        contactId: downgraded.id,
        expectedVersion: downgraded.version,
        givenName: "Mateo",
        familyName: "Gómez",
        email: customer.email,
      },
      audit,
    );
    assert.equal(edited.source, "checkout");
    assert.equal(edited.phoneE164, null);
    assert.equal(edited.verificationLevel, "SINGLE_CHANNEL_VERIFIED");

    const extra = await createContact({ email: customer.email, phoneE164: "+573154445566" });
    const mergeCand = await candidateFor(edited, extra);
    const mSource = await db.contact.findUniqueOrThrow({
      where: { id: mergeCand.sourceContactId },
    });
    const mTarget = await db.contact.findUniqueOrThrow({
      where: { id: mergeCand.targetContactId },
    });
    await merges.merge(
      {
        candidateId: mergeCand.id,
        expectedVersion: mergeCand.version,
        expectedSourceVersion: mSource.version,
        expectedTargetVersion: mTarget.version,
        note: "Fusión antes de supresión self-service del cliente.",
      },
      audit,
    );
    await crm.createTask(
      { contactId: mTarget.id, title: "Seguimiento interno abierto", dueAt: future() },
      supportAudit,
    );
    const accounts = new AccountService(db, { privacyPolicyVersion: "1.0.0" });
    await accounts.anonymize(customer.id, "ELIMINAR MI CUENTA", {
      ipHash: bytes(),
      userAgentHash: bytes(),
    });
    const erasedLineage = await db.contact.findMany({
      where: { id: { in: [mSource.id, mTarget.id] } },
    });
    assert.equal(
      erasedLineage.every((c) => c.status === "ANONYMIZED" && c.email === null),
      true,
    );
    assert.equal(
      await db.contactIdentity.count({ where: { contactId: { in: [mSource.id, mTarget.id] } } }),
      0,
    );
    const cancelledTask = await db.task.findFirstOrThrow({ where: { contactId: mTarget.id } });
    assert.equal(cancelledTask.status, "CANCELLED");
    assert.equal(cancelledTask.title, "[tarea suprimida por retención]");

    await assert.rejects(
      retention.runDue({ privacyPolicyVersion: "1.0.0" }, supportAudit),
      (error) => error instanceof CrmError && error.code === "FORBIDDEN",
    );

    const orgToArchive = await crm.createOrganization({ legalName: "Org Temporal" }, audit);
    const orgRetained = await crm.createOrganization({ legalName: "Org Principal" }, audit);
    const emailOrg = `org-rev-${randomUUID()}@example.test`;
    const orgSource = await createContact({ email: emailOrg, organizationId: orgToArchive.id });
    const orgTarget = await createContact({ email: emailOrg, organizationId: orgRetained.id });
    await crm.verifyContact(
      {
        contactId: orgTarget.id,
        expectedVersion: orgTarget.version,
        level: "SINGLE_CHANNEL_VERIFIED",
        channel: "EMAIL",
      },
      audit,
    );
    const orgCand = await candidateFor(orgSource, orgTarget);
    const oSource = await db.contact.findUniqueOrThrow({ where: { id: orgCand.sourceContactId } });
    const oTarget = await db.contact.findUniqueOrThrow({ where: { id: orgCand.targetContactId } });
    const orgMerged = await merges.merge(
      {
        candidateId: orgCand.id,
        expectedVersion: orgCand.version,
        expectedSourceVersion: oSource.version,
        expectedTargetVersion: oTarget.version,
        note: "Fusión con organización que luego será archivada.",
      },
      audit,
    );
    await crm.archiveOrganization(
      { organizationId: orgToArchive.id, expectedVersion: orgToArchive.version },
      audit,
    );
    await assert.rejects(
      merges.reverse(
        {
          candidateId: orgCand.id,
          expectedVersion: orgMerged.candidate.version,
          note: "Intento de reversa con organización archivada.",
        },
        audit,
      ),
      (error) => error instanceof CrmError && error.code === "CONFLICT",
    );

    const overdueContact = await createContact();
    const overdueTask = await crm.createTask(
      {
        contactId: overdueContact.id,
        title: "Llamar cliente vencido",
        dueAt: future(1),
        assignedToAdminUserId: supportId,
      },
      supportAudit,
    );
    await sql.query(
      `UPDATE "Task" SET "dueAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" = $1`,
      [overdueTask.id],
    );
    const openTasks = await crm.listTasks({ assignedToAdminUserId: supportId });
    assert.equal(
      openTasks.some((t) => t.id === overdueTask.id && t.isOverdue),
      true,
    );

    const cmsId = randomUUID();
    await db.adminUser.create({
      data: {
        id: cmsId,
        authUserId: randomUUID(),
        email: `crm-cms-${randomUUID()}@example.test`,
        displayName: "CMS sin CRM",
        role: "CMS_EDITOR",
        status: "ACTIVE",
      },
    });
    const ops = new OperationsService(db);
    const adminSnap = await ops.snapshot(adminId);
    const supportSnap = await ops.snapshot(supportId);
    const cmsSnap = await ops.snapshot(cmsId);
    assert.equal(
      adminSnap.notifications.some((n) => n.category === "crm.tasks"),
      true,
    );
    assert.equal(
      supportSnap.notifications.some((n) => n.category === "crm.tasks"),
      true,
    );
    assert.equal(
      supportSnap.notifications.some((n) => n.category === "crm.merges"),
      false,
    );
    assert.equal(
      cmsSnap.notifications.some((n) => n.category.startsWith("crm.")),
      false,
    );
  });
});
