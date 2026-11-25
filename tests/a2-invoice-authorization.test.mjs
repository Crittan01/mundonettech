import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import pg from "pg";

import { createDatabaseClient } from "../packages/db/dist/index.js";
import { InvoiceService } from "../packages/integrations/dist/index.js";
import { acquireIsolatedTestDatabase } from "../scripts/lib/postgres-test-harness.mjs";
import { seedCatalogFixture } from "../scripts/lib/catalog-test-fixture.mjs";
import { seedInventoryFixture } from "../scripts/lib/inventory-test-fixture.mjs";
import { seedPricingFixture } from "../scripts/lib/pricing-test-fixture.mjs";
import { seedCheckoutFixture, seedPaymentFixture } from "../scripts/lib/checkout-test-fixture.mjs";

const dianCredentialId = randomUUID();
const dian = {
  bearerToken: "a-secure-provider-token",
  providerUrl: "https://fiscal.example.test",
  issuerNit: "9010000001",
  issuerDv: "1",
  issuerLegalName: "Emisor de Prueba",
  issuerEmail: "fiscal@example.test",
  issuerAddress: "Carrera 7 # 71-21",
  issuerDepartmentCode: "11",
  issuerDepartmentName: "Bogotá, D.C.",
  issuerMunicipalityCode: "11001",
  issuerMunicipalityName: "Bogotá, D.C.",
  issuerPostalCode: "110231",
  issuerPhoneE164: "+573001234567",
  softwareId: "software-1234",
  softwarePin: "software-secret-pin",
  invoicePrefix: "FE",
  invoiceResolutionNumber: "18760000001",
  invoiceResolutionStart: 1,
  invoiceResolutionEnd: 1000,
  invoiceResolutionDate: "2026-01-01",
  invoiceResolutionValidFrom: "2026-01-01",
  invoiceResolutionValidTo: "2027-12-31",
  creditNotePrefix: "NC",
};
const plaintext = new TextEncoder().encode(JSON.stringify(dian));
let harness;
let sql;
let db;
let checkout;
let audit;
let invoice;
let adminId;
let listCalls;
let revealCalls;
let transmitCalls;
let findCalls;
let invoiceTransmitWait;

before(
  async () => {
    harness = await acquireIsolatedTestDatabase({
      containerName: "a2-invoice-authorization-test_mundonettech",
      port: 54428,
    });
    sql = new pg.Client({ connectionString: harness.databaseUrl });
    await sql.connect();
    db = createDatabaseClient({ databaseUrl: harness.databaseUrl, maxConnections: 8 });
    const catalog = await seedCatalogFixture(sql);
    const inventory = await seedInventoryFixture(sql, catalog);
    const pricing = await seedPricingFixture(sql, catalog);
    adminId = randomUUID();
    await db.adminUser.create({
      data: {
        id: adminId,
        authUserId: randomUUID(),
        email: `a2-fiscal-${randomUUID()}@example.test`,
        displayName: "Operador fiscal A2",
        role: "FINANCE_ANALYST",
        status: "ACTIVE",
      },
    });
    await sql.query("BEGIN");
    checkout = await seedCheckoutFixture(sql, { catalog, inventory, pricing, adminId });
    await seedPaymentFixture(sql, { checkout, catalog, adminId });
    await sql.query("COMMIT");
    await db.integrationCredential.create({
      data: {
        id: dianCredentialId,
        provider: "dian",
        environment: "LOCAL",
        accountName: `a2-fiscal-${randomUUID()}`,
        keyVersion: 1,
        nonce: randomBytes(12),
        ciphertext: randomBytes(32),
        authTag: randomBytes(16),
        createdByAdminUserId: adminId,
      },
    });
    audit = {
      actorAdminUserId: adminId,
      requestId: randomUUID(),
      ipHash: randomBytes(32),
      userAgentHash: randomBytes(32),
    };
    listCalls = 0;
    revealCalls = 0;
    transmitCalls = 0;
    findCalls = 0;
    invoiceTransmitWait = null;
    invoice = new InvoiceService(db, {
      environment: "LOCAL",
      vault: {
        async list() {
          listCalls += 1;
          return { items: [{ id: dianCredentialId, provider: "dian", revokedAt: null }] };
        },
        async reveal(id) {
          assert.equal(id, dianCredentialId);
          revealCalls += 1;
          return Uint8Array.from(plaintext);
        },
      },
      providerFactory: () => ({
        async transmit(input) {
          transmitCalls += 1;
          if (invoiceTransmitWait) {
            invoiceTransmitWait.started();
            await invoiceTransmitWait.wait;
          }
          return {
            providerDocumentId: `doc-${input.documentHash.slice(0, 12)}`,
            signedXml: `<Document><UUID>${input.documentHash}</UUID><Signature>valid-test-signature</Signature></Document>`,
          };
        },
        async find() {
          findCalls += 1;
          return null;
        },
      }),
    });
  },
  { timeout: 240_000 },
);

after(async () => {
  if (db) await db.$disconnect();
  if (sql) await sql.end();
  if (harness) await harness.stop();
});

describe("A2 — autorización DIAN humana y workers", () => {
  it("bloquea actor suspendido sin bóveda, factura ni proveedor y conserva el flujo posterior", async () => {
    await db.adminUser.update({ where: { id: adminId }, data: { status: "SUSPENDED" } });
    await assert.rejects(
      invoice.prepareInvoice(checkout.orderId, undefined, audit),
      (error) => error.name === "InvoiceValidationError",
    );
    assert.equal(listCalls, 0);
    assert.equal(revealCalls, 0);
    assert.equal(transmitCalls, 0);
    assert.equal(await db.taxInvoice.count({ where: { orderId: checkout.orderId } }), 0);

    await db.adminUser.update({ where: { id: adminId }, data: { status: "ACTIVE" } });
    const prepared = await invoice.prepareInvoice(checkout.orderId);
    assert.equal(prepared.status, "DRAFT");
    assert.equal(listCalls, 1);
    assert.equal(revealCalls, 1);
    assert.equal(await db.adminActionLog.count({ where: { action: "TAX_INVOICE_PREPARED" } }), 0);

    let releaseTransmission;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    invoiceTransmitWait = {
      wait: new Promise((resolve) => {
        releaseTransmission = resolve;
      }),
      started: () => markStarted(),
    };
    const stale = invoice.transmitInvoice(prepared.id, "admin:fiscal-a2", audit);
    await started;
    await sql.query(
      `UPDATE "TaxInvoice" SET "claimExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`,
      [prepared.id],
    );
    releaseTransmission();
    await assert.rejects(stale, (error) => error.code === "PROVIDER_UNCERTAIN");
    invoiceTransmitWait = null;
    const expired = await db.taxInvoice.findUniqueOrThrow({ where: { id: prepared.id } });
    assert.equal(expired.status, "TRANSMITTING");
    assert.equal(expired.signedXml, null);

    const accepted = await invoice.transmitInvoice(prepared.id, "admin:fiscal-a2", audit);
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(transmitCalls, 2);
    assert.equal(findCalls, 1);
    const acceptedLog = await db.adminActionLog.findFirstOrThrow({
      where: { action: "TAX_INVOICE_ACCEPTED", targetId: prepared.id },
    });
    assert.equal(acceptedLog.actorAdminUserId, adminId);
    assert.equal(acceptedLog.requestId, audit.requestId);
  });
});
