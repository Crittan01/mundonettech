import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import {
  AccountError,
  AccountService,
  B2bError,
  B2bService,
  CrmMergeService,
  CrmRetentionService,
  CrmService,
  IntegrationEnvironment,
  OperationsService,
  OrderLifecycleService,
  OrderService,
  createDatabaseClient,
} from "../packages/db/dist/index.js";
import {
  B2bCopilotError,
  B2bCopilotService,
  IntegrationCredentialVault,
  createCredentialKeyRing,
} from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";

const defaults = {
  taxRegime: "NO_RESPONSABLE_IVA",
  currency: "COP",
  timeZone: "America/Bogota",
  orderNumberPrefix: "MNT",
  orderNumberPadding: 4,
  uvtValueCents: 5_237_400n,
  uvtYear: 2026,
  standardShippingCents: 1_000_000n,
  deliveryPromiseDays: 30,
  reservationMinutes: 120,
  clickAndCollectEnabled: false,
};

let harness;
let sql;
let db;
let catalog;
let inventory;
let service;
let orders;
let crm;
let merges;
let retention;
let adminId;
let audit;
let priceListSequence = 0;

function bytes(value = randomBytes(32)) {
  return Uint8Array.from(value);
}

function future(hours = 72) {
  return new Date(Date.now() + hours * 3_600_000);
}

function idempotency() {
  return { keyHash: bytes(), subjectHash: bytes(), requestHash: bytes(), expiresAt: future(1) };
}

async function captureLead() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const email = `b2b-${suffix.toLowerCase()}@example.test`;
  const input = {
    legalName: `Comercializadora ${suffix}`,
    commercialName: `B2B ${suffix}`,
    taxId: `901${suffix}`,
    givenName: "Laura",
    familyName: "Rodríguez",
    email,
    phoneE164: `+573${String(Math.floor(100000000 + Math.random() * 899999999))}`,
    requirements: "Compra corporativa de equipos con entrega y validación de existencias.",
    privacyPolicyVersion: "2026-01",
    acceptanceProofHash: bytes(),
    acceptanceIpHash: bytes(),
    acceptanceUserAgentHash: bytes(),
    idempotency: idempotency(),
  };
  const result = await service.captureOpportunity(input);
  return { input, opportunityId: result.opportunityId, captureInput: input };
}

async function issueForLead(opportunityId, quantity = 2) {
  priceListSequence += 1;
  const list = await service.createPriceList(
    { code: `B2B-TEST-${priceListSequence}`, name: "Lista empresarial de integración" },
    audit,
  );
  await service.upsertPriceListItem(
    list.id,
    list.version,
    { sku: catalog.sku, unitPriceCents: "90000" },
    audit,
  );
  const populated = await service.getPriceList(list.id);
  const active = await service.activatePriceList(list.id, populated.version, audit);
  const current = await service.getOpportunity(opportunityId);
  await service.assignOrganizationPriceList(
    current.organization.id,
    current.organization.version,
    active.id,
    active.version,
    audit,
  );
  const proposal = await service.createProposal({
    opportunityId,
    expectedVersion: current.version,
    expiresAt: future(72),
    commercialNotes: "Pago pendiente y entrega sujeta a validación final de inventario.",
    items: [{ sku: catalog.sku, quantity }],
    audit,
  });
  const afterDraft = await service.getOpportunity(opportunityId);
  const issued = await service.issueProposal(proposal.id, afterDraft.version, audit);
  return { list, active, proposal, issued };
}

function checkoutInput(publicProposal, preview, key = idempotency()) {
  return {
    cart: { cartId: publicProposal.cartId },
    contact: {
      email: publicProposal.contact.email,
      givenName: publicProposal.contact.givenName,
      familyName: publicProposal.contact.familyName,
      recipientName: "Laura Rodríguez",
      phoneE164: publicProposal.contact.phoneE164,
      buyerDocumentType: "31",
      buyerDocumentNumber: publicProposal.contact.documentNumber,
      buyerTaxRegime: "NO_RESPONSABLE_IVA",
      termsVersion: "2026-01",
      privacyPolicyVersion: "2026-01",
      acceptanceProofHash: bytes(),
      acceptanceIpHash: bytes(),
      acceptanceUserAgentHash: bytes(),
    },
    fulfillment: {
      method: "HOME_DELIVERY",
      departmentCode: "11",
      municipalityCode: "11001",
      addressLine1: "Carrera 7 # 71-21",
      addressLine2: "Oficina 802",
      neighborhood: "Chapinero",
      postalCode: "110231",
    },
    idempotency: key,
    receiptAccessTokenHash: bytes(),
    b2bAcceptance: {
      proposalId: publicProposal.id,
      signerName: "Laura Rodríguez",
      signerDocumentType: "13",
      signerDocumentNumber: "1020304050",
    },
    expectedReviewFingerprint: preview.homeDelivery.reviewFingerprint,
  };
}

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "f4b2-b2b-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    catalog = await seedCatalogFixture(sql);
    inventory = await seedInventoryFixture(sql, catalog);
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 12 });
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `b2b-admin-${randomUUID()}@example.test`,
        displayName: "Administrador B2B",
        role: "SUPERADMIN",
        status: "ACTIVE",
      },
    });
    audit = {
      actorAdminUserId: adminId,
      ipHash: bytes(),
      userAgentHash: bytes(),
      requestId: randomUUID(),
    };
    service = new B2bService(db, defaults);
    orders = new OrderService(db, defaults);
    crm = new CrmService(db);
    merges = new CrmMergeService(db);
    retention = new CrmRetentionService(db);
  },
  { timeout: 240_000 },
);

after(
  async () => {
    if (db) await db.$disconnect();
    if (sql) await sql.end();
    if (harness) await harness.stop();
  },
  { timeout: 30_000 },
);

describe("F4B.2 production B2B flow", () => {
  it(
    "captures idempotently, prices, issues and converts exactly one balanced order under concurrency",
    async () => {
      const lead = await captureLead();
      const replay = await service.captureOpportunity(lead.captureInput);
      assert.deepEqual(replay, { opportunityId: lead.opportunityId, replayed: true });
      const { issued, proposal, active } = await issueForLead(lead.opportunityId, 2);
      assert.equal(issued.token.length, 43);
      const tokenRecord = await db.opportunityProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      assert.equal(tokenRecord.publicTokenHash.length, 32);
      assert.notEqual(Buffer.from(tokenRecord.publicTokenHash).toString("utf8"), issued.token);
      assert.equal(
        (await db.adminActionLog.count({ where: { targetType: "OpportunityProposal" } })) >= 2,
        true,
      );
      await assert.rejects(
        service.archivePriceList(active.id, active.version, audit),
        (error) => error instanceof B2bError && error.code === "CONFLICT",
      );

      const publicProposal = await service.getPublicProposal(
        Uint8Array.from(
          (await import("node:crypto")).createHash("sha256").update(issued.token).digest(),
        ),
      );
      assert.ok(publicProposal);
      assert.equal(publicProposal.available, true);
      assert.equal(publicProposal.subtotalCents, "200000");
      assert.equal(publicProposal.discountCents, "20000");
      assert.equal(publicProposal.taxCents, "0");
      assert.equal(publicProposal.totalCents, "1180000");
      const preview = await orders.preview({ cartId: publicProposal.cartId });
      assert.equal(preview.homeDelivery.totalCents, publicProposal.totalCents);
      const input = checkoutInput(publicProposal, preview);
      const attempts = await Promise.allSettled([orders.checkout(input), orders.checkout(input)]);
      const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
      assert.equal(succeeded.length, 2);
      assert.equal(new Set(succeeded.map((attempt) => attempt.value.orderId)).size, 1);
      assert.deepEqual(succeeded.map((attempt) => attempt.value.replayed).sort(), [false, true]);
      const converted = succeeded.find((attempt) => !attempt.value.replayed).value;
      const replayed = await orders.checkout(input);
      assert.deepEqual(replayed, { ...converted, replayed: true });

      const order = await db.order.findUniqueOrThrow({
        where: { id: converted.orderId },
        include: {
          items: { include: { taxLines: true, reservations: true } },
          receipt: true,
          sourceProposal: true,
        },
      });
      assert.equal(order.totalCents, 1_180_000n);
      assert.equal(order.subtotalCents, 200_000n);
      assert.equal(order.discountCents, 20_000n);
      assert.equal(order.shippingCents, 1_000_000n);
      assert.equal(order.items[0].unitPriceCents, 100_000n);
      assert.equal(order.items[0].wholesaleDiscountCents, 20_000n);
      assert.equal(order.items[0].lineTotalCents, 180_000n);
      assert.equal(order.items[0].taxLines[0].rule, "NOT_RESPONSABLE");
      assert.equal(order.sourceProposal.id, proposal.id);
      assert.equal(order.receipt.contentHash.length, 32);
      const convertedProposal = await db.opportunityProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      assert.equal(convertedProposal.status, "CONVERTED");
      assert.equal(convertedProposal.orderId, order.id);
      assert.equal(convertedProposal.signerDocumentNumber, "1020304050");
      assert.equal((await service.getOpportunity(lead.opportunityId)).status, "WON");
      const stock = await db.stockLevel.findFirstOrThrow({
        where: { variantId: catalog.variantId, locationId: inventory.locationId },
      });
      assert.equal(stock.committed, 2);
      assert.equal(
        (
          await service.getPublicProposal(
            Uint8Array.from(
              (await import("node:crypto")).createHash("sha256").update(issued.token).digest(),
            ),
          )
        ).unavailableReason,
        "CONVERTED",
      );
      await assert.rejects(
        sql.query(
          `UPDATE "OpportunityProposalItem" SET "unitPriceCents" = 1 WHERE "proposalId" = $1`,
          [proposal.id],
        ),
        /immutable/,
      );
      await assert.rejects(
        sql.query(`UPDATE "PriceListItem" SET "unitPriceCents" = 1 WHERE "priceListId" = $1`, [
          active.id,
        ]),
        /draft/,
      );
    },
    { timeout: 120_000 },
  );

  it(
    "supersedes versions, rolls back insufficient stock, expires only current proposals and redacts CRM lineage",
    async () => {
      const lead = await captureLead();
      const first = await issueForLead(lead.opportunityId, 1);
      let current = await service.getOpportunity(lead.opportunityId);
      const secondDraft = await service.createProposal({
        opportunityId: lead.opportunityId,
        expectedVersion: current.version,
        expiresAt: future(96),
        items: [{ sku: catalog.sku, quantity: 1, unitPriceCents: "85000" }],
        audit,
      });
      current = await service.getOpportunity(lead.opportunityId);
      const second = await service.issueProposal(secondDraft.id, current.version, audit);
      const oldPublic = await service.getPublicProposal(
        Uint8Array.from(
          (await import("node:crypto")).createHash("sha256").update(first.issued.token).digest(),
        ),
      );
      assert.equal(oldPublic.unavailableReason, "SUPERSEDED");
      assert.equal(
        (await db.cart.findUniqueOrThrow({ where: { id: first.issued.proposal.cartId } })).status,
        "CANCELLED",
      );

      const expiredCartId = randomUUID();
      const expiredProposalId = randomUUID();
      await sql.query(
        `INSERT INTO "Cart" ("id", "accessTokenHash", "kind", "expiresAt") VALUES ($1, $2, 'B2B', CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        [expiredCartId, randomBytes(32)],
      );
      await sql.query(
        `INSERT INTO "OpportunityProposal" (
         "id", "opportunityId", "version", "status", "publicTokenHash", "contentHash", "subtotalCents", "discountCents",
         "taxCents", "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays",
         "reservationMinutes", "expiresAt", "issuedAt", "cartId", "createdByAdminUserId"
       ) VALUES ($1, $2, 99, 'SENT', $3, $4, 100000, 15000, 0, 1000000, 1085000, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120,
         CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP - INTERVAL '2 days', $5, $6)`,
        [
          expiredProposalId,
          lead.opportunityId,
          randomBytes(32),
          randomBytes(32),
          expiredCartId,
          adminId,
        ],
      );
      current = await service.getOpportunity(lead.opportunityId);
      await db.opportunity.update({
        where: { id: lead.opportunityId },
        data: { currentVersion: 99, version: { increment: 1 } },
      });
      assert.equal((await service.expireDueProposals()) >= 1, true);
      assert.equal(
        (await db.opportunityProposal.findUniqueOrThrow({ where: { id: expiredProposalId } }))
          .status,
        "EXPIRED",
      );
      assert.equal(
        (await db.cart.findUniqueOrThrow({ where: { id: expiredCartId } })).status,
        "CANCELLED",
      );
      assert.equal((await service.getOpportunity(lead.opportunityId)).status, "QUALIFYING");
      await service.closeOpportunity(
        lead.opportunityId,
        (await service.getOpportunity(lead.opportunityId)).version,
        "LOST",
        audit,
      );

      const detailed = await service.getOpportunity(lead.opportunityId);
      const source = await db.contact.findUniqueOrThrow({ where: { id: detailed.contact.id } });
      const target = await crm.createContact(
        {
          organizationId: detailed.organization.id,
          givenName: "Laura",
          familyName: "Rodríguez",
          email: lead.input.email,
          phoneE164: "+573119990011",
          source: "admin-crm",
        },
        audit,
      );
      await crm.detectDuplicates({ contactId: source.id }, audit);
      const candidate = await db.identityMergeCandidate.findFirstOrThrow({
        where: {
          status: "PENDING",
          OR: [
            { sourceContactId: source.id, targetContactId: target.id },
            { sourceContactId: target.id, targetContactId: source.id },
          ],
        },
        include: { sourceContact: true, targetContact: true },
      });
      const merged = await merges.merge(
        {
          candidateId: candidate.id,
          expectedVersion: candidate.version,
          expectedSourceVersion: candidate.sourceContact.version,
          expectedTargetVersion: candidate.targetContact.version,
          note: "Identidad B2B revisada para conservar el linaje comercial.",
        },
        audit,
      );
      assert.equal(
        (await service.getOpportunity(lead.opportunityId)).contact.id,
        merged.targetContactId,
      );
      await merges.reverse(
        {
          candidateId: candidate.id,
          expectedVersion: merged.candidate.version,
          note: "Reversión verificada antes de la retención.",
        },
        audit,
      );
      assert.equal((await service.getOpportunity(lead.opportunityId)).contact.id, source.id);
      const beforeSuppression = await db.contact.findUniqueOrThrow({ where: { id: source.id } });
      await retention.suppress(
        {
          contactId: source.id,
          expectedVersion: beforeSuppression.version,
          reason: "DATA_SUBJECT_REQUEST",
          privacyPolicyVersion: "2026-01",
        },
        audit,
      );
      const redacted = await db.opportunity.findUniqueOrThrow({
        where: { id: lead.opportunityId },
      });
      assert.equal(redacted.requirements, "[contenido suprimido por retención]");
      assert.ok(redacted.anonymizedAt);
      const redactedProposal = await db.opportunityProposal.findUniqueOrThrow({
        where: { id: secondDraft.id },
      });
      assert.equal(redactedProposal.commercialNotes, null);
      assert.ok(redactedProposal.anonymizedAt);
      const mergeHistory = await db.identityMergeCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      assert.deepEqual(mergeHistory.movedOpportunityIds, []);
      const oldRedactedPublic = await service.getPublicProposal(
        Uint8Array.from(
          (await import("node:crypto")).createHash("sha256").update(second.token).digest(),
        ),
      );
      assert.equal(oldRedactedPublic.organizationName, "Organización anonimizada");
    },
    { timeout: 120_000 },
  );

  it(
    "rejects issuing insufficient stock without persisting a cart or changing the draft",
    async () => {
      const lead = await captureLead();
      const { proposal } = await issueForLead(lead.opportunityId, 2);
      const current = await service.getOpportunity(lead.opportunityId);
      const oversized = await service.createProposal({
        opportunityId: lead.opportunityId,
        expectedVersion: current.version,
        expiresAt: future(72),
        items: [{ sku: catalog.sku, quantity: 100_000 }],
        audit,
      });
      await assert.rejects(
        service.issueProposal(
          oversized.id,
          (await service.getOpportunity(lead.opportunityId)).version,
          audit,
        ),
        (error) => error instanceof B2bError && error.code === "CONFLICT",
      );
      assert.equal(
        (await db.opportunityProposal.findUniqueOrThrow({ where: { id: oversized.id } })).status,
        "DRAFT",
      );
      assert.equal(
        (await db.opportunityProposal.findUniqueOrThrow({ where: { id: oversized.id } })).cartId,
        null,
      );
      assert.equal(await db.cart.count({ where: { sourceProposal: { id: oversized.id } } }), 0);
      assert.ok(proposal.id);
    },
    { timeout: 120_000 },
  );

  it(
    "persists zero-PII Copilot runs, replays without another request and records provider failures",
    async () => {
      const opportunityId = (await db.opportunity.findFirstOrThrow({ where: { status: "WON" } }))
        .id;
      const keyRing = createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 1,
        serializedKeys: JSON.stringify({ 1: randomBytes(32).toString("base64") }),
      });
      const vault = new IntegrationCredentialVault(db, keyRing);
      const credential = await vault.create({
        provider: "gemini",
        accountName: "b2b-integration-test",
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            apiKey: "AIza-test-key-with-enough-length",
            model: "gemini-2.5-flash",
            apiUrl: "https://generativelanguage.googleapis.com/v1beta/models",
          }),
        ),
        actorAdminUserId: adminId,
        audit,
      });
      let calls = 0;
      let failNext = false;
      let lastBody = "";
      const copilot = new B2bCopilotService(db, {
        vault,
        fetchImpl: async (_url, init) => {
          calls += 1;
          lastBody = String(init?.body ?? "");
          if (failNext) return new Response("{}", { status: 503 });
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          priority: "NORMAL",
                          nextAction: "CONTACT_CUSTOMER",
                          reasonCodes: ["READY_TO_CONVERT"],
                          confidenceBps: 8800,
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      const requestId = randomUUID();
      const result = await copilot.run({
        opportunityId,
        credentialId: credential.id,
        requestId,
        audit,
      });
      assert.equal(result.suggestion.nextAction, "CONTACT_CUSTOMER");
      assert.equal(lastBody.includes("Comercializadora"), false);
      assert.equal(lastBody.includes("example.test"), false);
      assert.equal(lastBody.includes(opportunityId), false);
      const replay = await copilot.run({
        opportunityId,
        credentialId: credential.id,
        requestId,
        audit,
      });
      assert.equal(replay.replayed, true);
      assert.equal(calls, 1);
      const stored = await db.opportunityCopilotRun.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(stored.status, "SUCCEEDED");
      assert.equal(stored.model, "gemini-2.5-flash");
      failNext = true;
      const failedId = randomUUID();
      await assert.rejects(
        copilot.run({ opportunityId, credentialId: credential.id, requestId: failedId, audit }),
        (error) => error instanceof B2bCopilotError && error.code === "PROVIDER",
      );
      assert.equal(
        (await db.opportunityCopilotRun.findUniqueOrThrow({ where: { id: failedId } })).status,
        "FAILED",
      );
      assert.equal(
        (await db.opportunityCopilotRun.findUniqueOrThrow({ where: { id: failedId } })).output,
        null,
      );
    },
    { timeout: 120_000 },
  );

  it(
    "isolates B2B carts from abandoned cart sweeps, preserves active proposals on old cancellations, enforces catalog ceilings, RBAC and self-service Habeas Data erasure",
    async () => {
      const supportId = randomUUID();
      const cmsId = randomUUID();
      await db.adminUser.createMany({
        data: [
          {
            id: supportId,
            authUserId: randomUUID(),
            email: `b2b-support-${randomUUID()}@example.test`,
            displayName: "Soporte B2B",
            role: "CUSTOMER_SUPPORT",
            status: "ACTIVE",
          },
          {
            id: cmsId,
            authUserId: randomUUID(),
            email: `b2b-cms-${randomUUID()}@example.test`,
            displayName: "Editor CMS",
            role: "CMS_EDITOR",
            status: "ACTIVE",
          },
        ],
      });
      const supportAudit = { ...audit, actorAdminUserId: supportId, requestId: randomUUID() };
      await assert.rejects(
        service.createPriceList({ code: "B2B-FORBIDDEN", name: "No autorizada" }, supportAudit),
        (error) => error instanceof B2bError && error.code === "FORBIDDEN",
      );

      const ceilingLead = await captureLead();
      const operations = new OperationsService(db);
      const adminOps = await operations.snapshot(adminId);
      assert.equal(
        adminOps.notifications.some(
          (item) =>
            item.category === "b2b.opportunities" && item.entityId === ceilingLead.opportunityId,
        ),
        true,
      );
      const cmsOps = await operations.snapshot(cmsId);
      assert.equal(
        cmsOps.notifications.some((item) => item.category === "b2b.opportunities"),
        false,
      );

      priceListSequence += 1;
      const ceilingList = await service.createPriceList(
        { code: `B2B-CEIL-${priceListSequence}`, name: "Lista techo catálogo" },
        audit,
      );
      await service.upsertPriceListItem(
        ceilingList.id,
        ceilingList.version,
        { sku: catalog.sku, unitPriceCents: "95000" },
        audit,
      );
      const originalVariant = await db.productVariant.findUniqueOrThrow({
        where: { id: catalog.variantId },
      });
      await db.productVariant.update({
        where: { id: catalog.variantId },
        data: { priceCents: 80_000n },
      });
      try {
        const currentList = await service.getPriceList(ceilingList.id);
        await assert.rejects(
          service.activatePriceList(ceilingList.id, currentList.version, audit),
          (error) => error instanceof B2bError && error.code === "CONFLICT",
        );
      } finally {
        await db.productVariant.update({
          where: { id: catalog.variantId },
          data: { priceCents: originalVariant.priceCents },
        });
      }

      const issuedFirst = await issueForLead(ceilingLead.opportunityId, 1);
      await sql.query(
        `UPDATE "Cart" SET "updatedAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE "id" = $1`,
        [issuedFirst.issued.proposal.cartId],
      );
      const lifecycle = new OrderLifecycleService(db);
      await lifecycle.captureAbandonedCarts({ inactivityMinutes: 60 });
      assert.equal(
        await db.abandonedCart.count({ where: { cartId: issuedFirst.issued.proposal.cartId } }),
        0,
      );
      assert.equal(
        (await db.cart.findUniqueOrThrow({ where: { id: issuedFirst.issued.proposal.cartId } }))
          .status,
        "ACTIVE",
      );

      const oldExpiredId = randomUUID();
      await sql.query(
        `INSERT INTO "OpportunityProposal" (
           "id", "opportunityId", "version", "status", "contentHash", "subtotalCents", "discountCents",
           "taxCents", "shippingCents", "totalCents", "taxRegime", "uvtValueCents", "uvtYear", "deliveryPromiseDays",
           "reservationMinutes", "expiresAt", "createdByAdminUserId"
         ) VALUES ($1, $2, 98, 'EXPIRED', $3, 100000, 0, 0, 1000000, 1100000, 'NO_RESPONSABLE_IVA', 5237400, 2026, 30, 120,
           CURRENT_TIMESTAMP - INTERVAL '2 hours', $4)`,
        [oldExpiredId, ceilingLead.opportunityId, randomBytes(32), adminId],
      );
      const beforeCancelOld = await service.getOpportunity(ceilingLead.opportunityId);
      assert.equal(beforeCancelOld.status, "PROPOSAL_SENT");
      await service.cancelProposal(oldExpiredId, beforeCancelOld.version, audit);
      const afterCancelOld = await service.getOpportunity(ceilingLead.opportunityId);
      assert.equal(afterCancelOld.status, "PROPOSAL_SENT");
      assert.equal(afterCancelOld.currentVersion, issuedFirst.issued.proposal.version);

      const selfServiceLead = await captureLead();
      const selfIssued = await issueForLead(selfServiceLead.opportunityId, 1);
      const selfPublic = await service.getPublicProposal(
        Uint8Array.from(
          (await import("node:crypto"))
            .createHash("sha256")
            .update(selfIssued.issued.token)
            .digest(),
        ),
      );
      const selfPreview = await orders.preview({ cartId: selfPublic.cartId });
      const selfOrder = await orders.checkout(checkoutInput(selfPublic, selfPreview));
      const orderRow = await db.order.findUniqueOrThrow({ where: { id: selfOrder.orderId } });
      await sql.query(
        `UPDATE "Order" SET "reservationExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = $1`,
        [selfOrder.orderId],
      );
      const released = await lifecycle.releaseExpiredOrderReservations();
      assert.equal(released.orderIds.includes(selfOrder.orderId), true);
      await db.customer.update({
        where: { id: orderRow.customerId },
        data: { status: "ACTIVE", authUserId: randomUUID() },
      });

      const primaryContact = await db.contact.findFirstOrThrow({
        where: { customerId: orderRow.customerId, deletedAt: null },
      });
      const contact360 = await crm.getContact360(primaryContact.id);
      assert.equal(
        contact360.opportunities.some((item) => item.id === selfServiceLead.opportunityId),
        true,
      );

      const secondaryContact = await crm.createContact(
        {
          organizationId: primaryContact.organizationId,
          givenName: "Laura",
          familyName: "Rodríguez",
          email: selfServiceLead.input.email,
          phoneE164: "+573128887766",
          source: "admin-crm",
        },
        audit,
      );
      const openOpp = await db.opportunity.create({
        data: {
          organizationId: primaryContact.organizationId,
          contactId: secondaryContact.id,
          source: "storefront-b2b",
          requirements: "Segunda solicitud corporativa que debe fusionarse y redactarse.",
          privacyPolicyVersion: "2026-01",
          acceptanceProofHash: bytes(),
          acceptedAt: new Date(),
        },
      });
      await crm.detectDuplicates({ contactId: primaryContact.id }, audit);
      const mergeCandidate = await db.identityMergeCandidate.findFirstOrThrow({
        where: {
          status: "PENDING",
          OR: [
            { sourceContactId: primaryContact.id, targetContactId: secondaryContact.id },
            { sourceContactId: secondaryContact.id, targetContactId: primaryContact.id },
          ],
        },
        include: { sourceContact: true, targetContact: true },
      });
      await merges.merge(
        {
          candidateId: mergeCandidate.id,
          expectedVersion: mergeCandidate.version,
          expectedSourceVersion: mergeCandidate.sourceContact.version,
          expectedTargetVersion: mergeCandidate.targetContact.version,
          note: "Fusión B2B previa a baja self-service.",
        },
        audit,
      );

      const accounts = new AccountService(db, { privacyPolicyVersion: "2026-01" });
      await assert.rejects(
        accounts.anonymize(orderRow.customerId, "ELIMINAR MI CUENTA", {
          ipHash: bytes(),
          userAgentHash: bytes(),
        }),
        (error) => error instanceof AccountError && error.code === "CONFLICT",
      );

      const openOppState = await service.getOpportunity(openOpp.id);
      await service.closeOpportunity(openOpp.id, openOppState.version, "CANCELLED", audit);

      await accounts.anonymize(orderRow.customerId, "ELIMINAR MI CUENTA", {
        ipHash: bytes(),
        userAgentHash: bytes(),
      });

      const redactedSelfOpp = await db.opportunity.findUniqueOrThrow({
        where: { id: selfServiceLead.opportunityId },
      });
      assert.equal(redactedSelfOpp.requirements, "[contenido suprimido por retención]");
      assert.ok(redactedSelfOpp.anonymizedAt);
      const redactedConvertedProposal = await db.opportunityProposal.findUniqueOrThrow({
        where: { id: selfIssued.proposal.id },
      });
      assert.equal(redactedConvertedProposal.signerName, null);
      assert.equal(redactedConvertedProposal.signerDocumentNumber, null);
      assert.equal(redactedConvertedProposal.commercialNotes, null);
      assert.ok(redactedConvertedProposal.anonymizedAt);
      const redactedMergeCandidate = await db.identityMergeCandidate.findUniqueOrThrow({
        where: { id: mergeCandidate.id },
      });
      assert.deepEqual(redactedMergeCandidate.movedOpportunityIds, []);
    },
    { timeout: 120_000 },
  );
});
