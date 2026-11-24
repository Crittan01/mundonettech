import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  AccountService,
  LifecycleError,
  LifecycleService,
  SegmentationService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import { DomainEventWorker, EmailService } from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";

let harness;
let db;
let admin;
let audit;
let credentialId;
let lifecycle;
let segments;
let email;
let worker;
const sent = [];

const definition = {
  minFrequency: null,
  maxFrequency: null,
  minNetLtvCents: null,
  maxNetLtvCents: null,
  lastPurchaseWithinDays: null,
  lastPurchaseOlderThanDays: null,
  rfmClass: "PROSPECT",
};

function hash() {
  return Uint8Array.from(randomBytes(32));
}

function steps() {
  return [
    {
      position: 0,
      offsetMinutes: 0,
      subject: "Hola {{customerFirstName}} de {{storeName}}",
      htmlBody:
        '<p>Hola {{customerFirstName}}. Visita {{storeName}}.</p><p><a href="{{accountUrl}}">Cuenta</a></p><p><a href="{{unsubscribeUrl}}">Baja</a></p>',
      textBody:
        "Hola {{customerFirstName}}. {{storeName}}: {{accountUrl}}. Baja: {{unsubscribeUrl}}",
      variables: ["accountUrl", "customerFirstName", "storeName", "unsubscribeUrl"],
    },
  ];
}

async function makeCustomer(withConsent = true) {
  const customer = await db.customer.create({
    data: {
      authUserId: randomUUID(),
      email: `lifecycle-${randomUUID()}@example.test`,
      givenName: "Cliente Lifecycle",
      status: "ACTIVE",
    },
  });
  const consent = withConsent
    ? await db.consent.create({
        data: {
          customerId: customer.id,
          purpose: "MARKETING_EMAIL",
          status: "GRANTED",
          source: "lifecycle-integration",
          policyVersion: "2026-01",
          proofHash: hash(),
        },
      })
    : null;
  return { customer, consent };
}

async function createAutomation(name = "Bienvenida lifecycle", stepDefinitions = steps()) {
  const segment = await segments.createSegment({ name: `${name} segmento`, definition }, audit);
  const activeSegment = await segments.transitionSegment(
    { segmentId: segment.id, expectedVersion: 0, action: "ACTIVATE" },
    audit,
  );
  const journey = await lifecycle.createJourney(
    { name, segmentId: segment.id, steps: stepDefinitions },
    audit,
  );
  const activeJourney = await lifecycle.transitionJourney(
    { journeyId: journey.id, expectedVersion: 0, action: "ACTIVATE" },
    audit,
  );
  return { segment: activeSegment, journey: activeJourney };
}

async function archiveAutomation() {
  const journeys = await db.lifecycleJourney.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED", "DRAFT"] } },
  });
  for (const journey of journeys) {
    await lifecycle.transitionJourney(
      { journeyId: journey.id, expectedVersion: journey.version, action: "ARCHIVE" },
      audit,
    );
  }
  const activeSegments = await db.customerSegment.findMany({
    where: { status: { in: ["ACTIVE", "DRAFT"] } },
  });
  for (const segment of activeSegments) {
    await segments.transitionSegment(
      { segmentId: segment.id, expectedVersion: segment.version, action: "ARCHIVE" },
      audit,
    );
  }
  for (let batch = 0; batch < 3; batch += 1) {
    const result = await worker.runBatch(100);
    if (result.claimed === 0) break;
  }
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f52-lifecycle-test_mundonettech",
      port: 54428,
    });
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    admin = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-admin-${randomUUID()}@example.test`,
        displayName: "Administrador lifecycle",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    audit = { actorAdminUserId: admin.id, ipHash: hash(), userAgentHash: hash() };
    credentialId = randomUUID();
    await db.integrationCredential.create({
      data: {
        id: credentialId,
        provider: "resend",
        environment: "LOCAL",
        accountName: "lifecycle-test",
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: admin.id,
      },
    });
    lifecycle = new LifecycleService(db);
    segments = new SegmentationService(db);
    const vault = {
      list: async () => ({ items: [{ id: credentialId, provider: "resend", revokedAt: null }] }),
      reveal: async () =>
        Uint8Array.from(
          Buffer.from(
            JSON.stringify({
              apiKey: `re_${"a".repeat(32)}`,
              fromEmail: "lifecycle-sender@example.test",
              fromName: "Lifecycle pruebas",
              replyTo: null,
              svixSecret: `whsec_${"b".repeat(32)}`,
              unsubscribeSecret: randomBytes(32).toString("base64"),
              apiUrl: "https://api.resend.test/emails",
            }),
          ),
        ),
    };
    email = new EmailService(db, {
      vault,
      publicSiteUrl: "http://127.0.0.1:4110",
      providerFactory: () => ({
        send: async (input) => {
          sent.push(input);
          return { providerMessageId: `message_${randomUUID().replaceAll("-", "")}` };
        },
      }),
    });
    worker = new DomainEventWorker(db, {
      workerId: `lifecycle-${randomUUID()}`,
      shipping: {},
      email,
      invoice: {},
      vault,
      publicSiteUrl: "http://127.0.0.1:4110",
      storeName: "Tienda Lifecycle",
      receiptTokenForSubmission: () => "x".repeat(43),
      maximumAttempts: 3,
    });
  },
  { timeout: 240_000 },
);

beforeEach(async () => {
  sent.length = 0;
  const previousConsents = await db.consent.findMany({
    where: { purpose: "MARKETING_EMAIL", status: "GRANTED", revokedBy: null },
    select: { id: true, customerId: true },
  });
  for (const consent of previousConsents) {
    await db.consent.create({
      data: {
        customerId: consent.customerId,
        purpose: "MARKETING_EMAIL",
        status: "REVOKED",
        source: "lifecycle-test-isolation",
        policyVersion: "2026-01",
        proofHash: hash(),
        revokesId: consent.id,
      },
    });
  }
});

afterEach(async () => {
  await archiveAutomation();
});

after(async () => {
  if (db) await db.$disconnect();
  if (harness) await harness.stop();
});

describe("F5.2 — consented persistent segments and lifecycle journeys", () => {
  it("records auditable entries only with current consent and never duplicates enrollment or outbox", async () => {
    const eligible = await makeCustomer();
    await makeCustomer(false);
    const revoked = await makeCustomer();
    await db.consent.create({
      data: {
        customerId: revoked.customer.id,
        purpose: "MARKETING_EMAIL",
        status: "REVOKED",
        source: "lifecycle-revocation",
        policyVersion: "2026-01",
        proofHash: hash(),
        revokesId: revoked.consent.id,
      },
    });
    const { segment, journey } = await createAutomation();
    const first = await lifecycle.runScheduledWork(20);
    assert.equal(first.segments.entered, 1);
    assert.equal(first.enrolled, 1);
    assert.equal(first.dispatched, 1);
    const second = await lifecycle.runScheduledWork(20);
    assert.equal(second.segments.entered, 0);
    assert.equal(second.enrolled, 0);
    assert.equal(second.dispatched, 0);
    const memberships = await db.customerSegmentMembership.findMany({
      where: { segmentId: segment.id },
    });
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].customerId, eligible.customer.id);
    assert.equal(memberships[0].consentId, eligible.consent.id);
    assert.equal(memberships[0].metrics.rfmClass, "PROSPECT");
    await assert.rejects(
      db.customerSegmentMembership.update({
        where: { id: memberships[0].id },
        data: { reason: "FILTER_CHANGED" },
      }),
    );
    const enrollment = await db.lifecycleEnrollment.findUniqueOrThrow({
      where: { journeyId_customerId: { journeyId: journey.id, customerId: eligible.customer.id } },
    });
    const messages = await db.lifecycleMessage.findMany({ where: { enrollmentId: enrollment.id } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, "DISPATCHING");
    const lifecycleEvents = await db.domainOutbox.findMany({
      where: { eventType: { startsWith: "lifecycle." } },
    });
    assert.equal(lifecycleEvents.length, 2);
    for (const event of lifecycleEvents) {
      const serialized = JSON.stringify(event.payload);
      assert.equal(serialized.includes(eligible.customer.email), false);
      assert.equal(serialized.includes("Cliente Lifecycle"), false);
    }
    await assert.rejects(
      db.lifecycleStep.update({
        where: { id: messages[0].stepId },
        data: { subject: "Mutación indebida" },
      }),
    );
  });

  it("enrolls beyond twenty active journeys without scheduler starvation", async () => {
    const { customer } = await makeCustomer();
    const segment = await segments.createSegment(
      { name: "Segmento paginación", definition },
      audit,
    );
    await segments.transitionSegment(
      { segmentId: segment.id, expectedVersion: 0, action: "ACTIVATE" },
      audit,
    );
    const journeys = [];
    for (let index = 0; index < 21; index += 1) {
      const journey = await lifecycle.createJourney(
        { name: `Journey paginación ${index}`, segmentId: segment.id, steps: steps() },
        audit,
      );
      await lifecycle.transitionJourney(
        { journeyId: journey.id, expectedVersion: 0, action: "ACTIVATE" },
        audit,
      );
      journeys.push(journey);
    }
    const result = await lifecycle.runScheduledWork(500);
    assert.equal(result.enrolled, 21);
    assert.equal(result.dispatched, 21);
    assert.equal(await db.lifecycleEnrollment.count({ where: { customerId: customer.id } }), 21);
  });

  it("queues sealed content, completes once and remains idempotent through worker replays", async () => {
    const { customer } = await makeCustomer();
    const { journey } = await createAutomation();
    await lifecycle.runScheduledWork(20);
    let result = await worker.runBatch(100);
    assert.equal(result.failed, 0);
    const message = await db.lifecycleMessage.findFirstOrThrow({
      where: { enrollment: { journeyId: journey.id, customerId: customer.id } },
    });
    assert.equal(message.status, "QUEUED");
    const emailEvent = await db.emailEvent.findUniqueOrThrow({
      where: { lifecycleMessageId: message.id },
    });
    assert.equal(emailEvent.templateKey, "lifecycle.campaign");
    assert.equal(emailEvent.customerId, customer.id);
    assert.equal(emailEvent.subjectSnapshot, "Hola Cliente Lifecycle de Tienda Lifecycle");
    assert.equal(emailEvent.variablesSnapshot.accountUrl, "http://127.0.0.1:4110/mi-cuenta");
    assert.equal(emailEvent.variablesSnapshot.unsubscribeUrl.includes("/email/baja/"), true);
    await assert.rejects(
      db.lifecycleEnrollment.update({
        where: { id: message.enrollmentId },
        data: { status: "COMPLETED", completedAt: new Date() },
      }),
      /provider acceptance/,
    );
    result = await worker.runBatch(100);
    assert.equal(result.failed, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, customer.email);
    assert.equal(sent[0].idempotencyKey, `domain:lifecycle.campaign:${message.id}`);
    assert.equal(
      (await db.lifecycleEnrollment.findUniqueOrThrow({ where: { id: message.enrollmentId } }))
        .status,
      "COMPLETED",
    );
    await db.domainOutbox.create({
      data: {
        eventType: "lifecycle.message.dispatch.v1",
        aggregateType: "LifecycleMessage",
        aggregateId: message.id,
        deduplicationKey: `lifecycle:replay:${randomUUID()}`,
        payload: { lifecycleMessageId: message.id },
      },
    });
    await worker.runBatch(100);
    assert.equal(await db.emailEvent.count({ where: { lifecycleMessageId: message.id } }), 1);
    assert.equal(sent.length, 1);
  });

  it("recovers completion idempotently when an accepted email is retried", async () => {
    const { customer } = await makeCustomer();
    const { journey } = await createAutomation("Journey recuperación terminal");
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const emailEvent = await db.emailEvent.findFirstOrThrow({
      where: {
        lifecycleMessage: { enrollment: { journeyId: journey.id, customerId: customer.id } },
      },
    });
    await db.emailEvent.update({
      where: { id: emailEvent.id },
      data: {
        status: "SENT",
        statusRank: 20,
        providerMessageId: `message_${randomUUID().replaceAll("-", "")}`,
        sentAt: new Date(),
      },
    });
    const outcome = await email.send(emailEvent.id);
    assert.equal(outcome.status, "SENT");
    assert.equal(sent.length, 0);
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
    });
    assert.equal(enrollment.status, "COMPLETED");
    assert.equal((await email.send(emailEvent.id)).status, "SENT");
  });

  it("holds dispatch and provider sends while paused, then resumes without duplicates", async () => {
    const { customer } = await makeCustomer();
    const { journey } = await createAutomation("Journey pausable");
    await lifecycle.runScheduledWork(20);
    await lifecycle.transitionJourney(
      { journeyId: journey.id, expectedVersion: 1, action: "PAUSE" },
      audit,
    );
    await worker.runBatch(100);
    let message = await db.lifecycleMessage.findFirstOrThrow({
      where: { enrollment: { journeyId: journey.id, customerId: customer.id } },
    });
    assert.equal(message.status, "SCHEDULED");
    assert.equal(await db.emailEvent.count({ where: { lifecycleMessageId: message.id } }), 0);
    await lifecycle.transitionJourney(
      { journeyId: journey.id, expectedVersion: 2, action: "RESUME" },
      audit,
    );
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const queued = await db.emailEvent.findUniqueOrThrow({
      where: { lifecycleMessageId: message.id },
    });
    await lifecycle.transitionJourney(
      { journeyId: journey.id, expectedVersion: 3, action: "PAUSE" },
      audit,
    );
    const held = await worker.runBatch(100);
    assert.equal(held.retries, 1);
    assert.equal(sent.length, 0);
    assert.equal(
      (await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } })).status,
      "SENDING",
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await db.emailEvent.update({
        where: { id: queued.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await db.domainOutbox.updateMany({
        where: {
          aggregateType: "EmailEvent",
          aggregateId: queued.id,
          eventType: "email.requested.v1",
        },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      const deferredCycle = await worker.runBatch(100);
      assert.equal(deferredCycle.failed, 0);
      assert.equal(deferredCycle.retries, 1);
    }
    const pausedEmail = await db.emailEvent.findUniqueOrThrow({ where: { id: queued.id } });
    assert.equal(pausedEmail.attemptCount, 0);
    const pausedOutbox = await db.domainOutbox.findFirstOrThrow({
      where: {
        aggregateType: "EmailEvent",
        aggregateId: queued.id,
        eventType: "email.requested.v1",
      },
    });
    assert.equal(pausedOutbox.failedAt, null);
    await lifecycle.transitionJourney(
      { journeyId: journey.id, expectedVersion: 4, action: "RESUME" },
      audit,
    );
    await worker.runBatch(100);
    assert.equal(sent.length, 1);
    message = await db.lifecycleMessage.findUniqueOrThrow({ where: { id: message.id } });
    assert.equal(message.status, "QUEUED");
    assert.equal(
      (await db.lifecycleEnrollment.findUniqueOrThrow({ where: { id: message.enrollmentId } }))
        .status,
      "COMPLETED",
    );
  });

  it("suppresses an already queued message when consent is revoked before provider send", async () => {
    const { customer, consent } = await makeCustomer();
    const { journey } = await createAutomation("Journey revocable");
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const emailEvent = await db.emailEvent.findFirstOrThrow({
      where: {
        lifecycleMessage: { enrollment: { journeyId: journey.id, customerId: customer.id } },
      },
    });
    await db.consent.create({
      data: {
        customerId: customer.id,
        purpose: "MARKETING_EMAIL",
        status: "REVOKED",
        source: "lifecycle-before-send",
        policyVersion: "2026-01",
        proofHash: hash(),
        revokesId: consent.id,
      },
    });
    await worker.runBatch(100);
    assert.equal(sent.length, 0);
    assert.equal(
      (await db.emailEvent.findUniqueOrThrow({ where: { id: emailEvent.id } })).status,
      "SUPPRESSED",
    );
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
    });
    assert.equal(enrollment.status, "CANCELLED");
    assert.equal(enrollment.exitReason, "CONSENT_REVOKED");
  });

  it("applies RFC 8058 suppression to the lifecycle enrollment and future sends", async () => {
    const { customer } = await makeCustomer();
    const { journey } = await createAutomation("Journey baja comercial");
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const emailEvent = await db.emailEvent.findFirstOrThrow({
      where: {
        lifecycleMessage: { enrollment: { journeyId: journey.id, customerId: customer.id } },
      },
    });
    const token = decodeURIComponent(emailEvent.variablesSnapshot.unsubscribeUrl.split("/").at(-1));
    const result = await email.unsubscribe(token);
    assert.equal(result.topic, "lifecycle");
    assert.equal(result.replayed, false);
    assert.equal((await email.unsubscribe(token)).replayed, true);
    assert.equal((await email.send(emailEvent.id)).status, "SUPPRESSED");
    assert.equal(sent.length, 0);
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
    });
    assert.equal(enrollment.status, "CANCELLED");
    assert.equal(enrollment.exitReason, "SUPPRESSED");
  });

  it("keeps a multi-step enrollment active until later steps are accepted", async () => {
    const { customer } = await makeCustomer();
    const journeySteps = steps();
    journeySteps.push({
      ...journeySteps[0],
      position: 1,
      offsetMinutes: 60,
      subject: "Segundo paso de {{storeName}}",
    });
    const { journey } = await createAutomation("Journey multipaso", journeySteps);
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    await worker.runBatch(100);
    assert.equal(sent.length, 1);
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
      include: { messages: { orderBy: { scheduledAt: "asc" } } },
    });
    assert.equal(enrollment.status, "ACTIVE");
    assert.equal(enrollment.messages.length, 2);
    assert.equal(enrollment.messages[0].status, "QUEUED");
    assert.equal(enrollment.messages[1].status, "SCHEDULED");
    assert.ok(enrollment.messages[1].scheduledAt > enrollment.messages[0].scheduledAt);
  });

  it("closes remaining lifecycle steps on a signed bounce webhook", async () => {
    const { customer } = await makeCustomer();
    const journeySteps = steps();
    journeySteps.push({ ...journeySteps[0], position: 1, offsetMinutes: 60 });
    const { journey } = await createAutomation("Journey rebote", journeySteps);
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    await worker.runBatch(100);
    const emailEvent = await db.emailEvent.findFirstOrThrow({
      where: {
        lifecycleMessage: { enrollment: { journeyId: journey.id, customerId: customer.id } },
      },
    });
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: emailEvent.providerMessageId,
        created_at: new Date(timestamp * 1000).toISOString(),
      },
    });
    const signature = createHmac("sha256", Buffer.from("b".repeat(32), "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const result = await email.processWebhook({
      body,
      id,
      timestamp: String(timestamp),
      signature: `v1,${signature}`,
    });
    assert.equal(result.status, "BOUNCED");
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
      include: { messages: { orderBy: { scheduledAt: "asc" } } },
    });
    assert.equal(enrollment.status, "CANCELLED");
    assert.equal(enrollment.exitReason, "SUPPRESSED");
    assert.equal(enrollment.messages[0].status, "SUPPRESSED");
    assert.equal(enrollment.messages[1].status, "CANCELLED");
    assert.equal(
      await db.emailSuppression.count({
        where: { recipientHash: emailEvent.recipientHash, topic: "lifecycle", reason: "BOUNCE" },
      }),
      1,
    );
  });

  it("cancels lifecycle and appends segment exits during account anonymization", async () => {
    const { customer } = await makeCustomer();
    const { segment, journey } = await createAutomation("Journey anonimización");
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    await new AccountService(db, { privacyPolicyVersion: "2026-01" }).anonymize(
      customer.id,
      "ELIMINAR MI CUENTA",
      { ipHash: hash(), userAgentHash: hash() },
    );
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).status,
      "ANONYMIZED",
    );
    const enrollment = await db.lifecycleEnrollment.findFirstOrThrow({
      where: { journeyId: journey.id, customerId: customer.id },
    });
    assert.equal(enrollment.status, "CANCELLED");
    assert.equal(enrollment.exitReason, "ANONYMIZED");
    const membership = await db.customerSegmentMembership.findFirstOrThrow({
      where: { segmentId: segment.id, customerId: customer.id },
      orderBy: { sequence: "desc" },
    });
    assert.equal(membership.status, "EXITED");
    assert.equal(membership.reason, "ANONYMIZED");
    assert.equal(
      (
        await db.emailEvent.findFirstOrThrow({
          where: { lifecycleMessage: { enrollmentId: enrollment.id } },
        })
      ).status,
      "CANCELLED",
    );
    assert.equal(sent.length, 0);
  });

  it("enforces writer RBAC inside the domain service", async () => {
    const support = await db.adminUser.create({
      data: {
        authUserId: randomUUID(),
        email: `lifecycle-support-${randomUUID()}@example.test`,
        displayName: "Soporte lifecycle",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    await assert.rejects(
      segments.createSegment(
        { name: "No autorizado", definition },
        { actorAdminUserId: support.id, ipHash: hash(), userAgentHash: hash() },
      ),
      (error) => error instanceof LifecycleError && error.code === "FORBIDDEN",
    );
  });

  it("delivers steps that use only a subset of optional variables and blocks global template overrides or archived segments", async () => {
    await assert.rejects(
      email.saveTemplate(
        {
          templateKey: "lifecycle.campaign",
          subject: "Override prohibido {{storeName}}",
          htmlBody: '<p>{{storeName}} <a href="{{unsubscribeUrl}}">Baja</a></p>',
          textBody: "{{storeName}} {{unsubscribeUrl}}",
          variables: ["storeName", "unsubscribeUrl"],
          publish: true,
        },
        audit,
      ),
    );
    const archivedDraft = await segments.createSegment(
      { name: "Segmento archivado prueba", definition },
      audit,
    );
    await segments.transitionSegment(
      { segmentId: archivedDraft.id, expectedVersion: 0, action: "ARCHIVE" },
      audit,
    );
    await assert.rejects(
      lifecycle.createJourney(
        { name: "Journey sobre archivado", segmentId: archivedDraft.id, steps: steps() },
        audit,
      ),
      (error) => error instanceof LifecycleError && error.code === "CONFLICT",
    );
    const { customer } = await makeCustomer();
    const minimalSteps = [
      {
        position: 0,
        offsetMinutes: 0,
        subject: "Aviso breve de {{storeName}}",
        htmlBody:
          '<p>Gracias por elegir {{storeName}}.</p><p><a href="{{unsubscribeUrl}}">Baja</a></p>',
        textBody: "Gracias por elegir {{storeName}}. Baja: {{unsubscribeUrl}}",
        variables: ["storeName", "unsubscribeUrl"],
      },
    ];
    const { journey } = await createAutomation("Journey variables parciales", minimalSteps);
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    await worker.runBatch(100);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Aviso breve de Tienda Lifecycle");
    const enrollment = await db.lifecycleEnrollment.findUniqueOrThrow({
      where: { journeyId_customerId: { journeyId: journey.id, customerId: customer.id } },
    });
    assert.equal(enrollment.status, "COMPLETED");
  });

  it("immediately exits segments, cancels active enrollments and suppresses queued emails on profile consent revocation and topic unsubscribe", async () => {
    const { customer } = await makeCustomer();
    const { segment, journey: firstJourney } = await createAutomation(
      "Journey revocación perfil 1",
    );
    const secondDraft = await lifecycle.createJourney(
      {
        name: "Journey revocación perfil 2",
        segmentId: segment.id,
        steps: [{ ...steps()[0], offsetMinutes: 120 }],
      },
      audit,
    );
    const secondJourney = await lifecycle.transitionJourney(
      { journeyId: secondDraft.id, expectedVersion: 0, action: "ACTIVATE" },
      audit,
    );
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const accounts = new AccountService(db, { privacyPolicyVersion: "2026-01" });
    await accounts.updateProfile(
      customer.id,
      {
        givenName: "Cliente Lifecycle",
        familyName: "Revocado",
        phoneE164: null,
        marketingEmail: false,
        advertising: false,
      },
      { ipHash: hash(), userAgentHash: hash() },
    );
    const latestMembership = await db.customerSegmentMembership.findFirstOrThrow({
      where: { segmentId: segment.id, customerId: customer.id },
      orderBy: { sequence: "desc" },
    });
    assert.equal(latestMembership.status, "EXITED");
    assert.equal(latestMembership.reason, "CONSENT_REVOKED");
    for (const journeyId of [firstJourney.id, secondJourney.id]) {
      const enrollment = await db.lifecycleEnrollment.findUniqueOrThrow({
        where: { journeyId_customerId: { journeyId, customerId: customer.id } },
      });
      assert.equal(enrollment.status, "CANCELLED");
      assert.equal(enrollment.exitReason, "CONSENT_REVOKED");
    }
    const suppressedEmail = await db.emailEvent.findFirstOrThrow({
      where: { customerId: customer.id, templateKey: "lifecycle.campaign" },
    });
    assert.equal(suppressedEmail.status, "SUPPRESSED");

    const secondCustomer = await makeCustomer();
    await lifecycle.runScheduledWork(20);
    await worker.runBatch(100);
    const unsubscribeTarget = await db.emailEvent.findFirstOrThrow({
      where: { customerId: secondCustomer.customer.id, templateKey: "lifecycle.campaign" },
    });
    const token = decodeURIComponent(
      unsubscribeTarget.variablesSnapshot.unsubscribeUrl.split("/").at(-1),
    );
    await email.unsubscribe(token);
    for (const journeyId of [firstJourney.id, secondJourney.id]) {
      const enrollment = await db.lifecycleEnrollment.findUniqueOrThrow({
        where: { journeyId_customerId: { journeyId, customerId: secondCustomer.customer.id } },
      });
      assert.equal(enrollment.status, "CANCELLED");
      assert.equal(enrollment.exitReason, "SUPPRESSED");
    }
  });

  it("serializes concurrent segment refresh and customer anonymization without sequence collisions", async () => {
    const { customer } = await makeCustomer();
    const { segment } = await createAutomation("Journey concurrencia anonimización");
    await segments.refreshSegment(segment.id, audit);
    const accounts = new AccountService(db, { privacyPolicyVersion: "2026-01" });
    await Promise.all([
      segments.refreshSegment(segment.id, audit),
      accounts.anonymize(customer.id, "ELIMINAR MI CUENTA", {
        ipHash: hash(),
        userAgentHash: hash(),
      }),
    ]);
    const finalCustomer = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(finalCustomer.status, "ANONYMIZED");
    const history = await db.customerSegmentMembership.findMany({
      where: { segmentId: segment.id, customerId: customer.id },
      orderBy: { sequence: "asc" },
    });
    assert.equal(history.at(-1)?.status, "EXITED");
  });
});
