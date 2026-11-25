import { randomUUID } from "node:crypto";

import { hasAdminPermission, isAdminRole } from "@mundonettech/core";
import { IntegrationEnvironment, Prisma, type PrismaClient } from "@mundonettech/db";

import { calculateCude, calculateCufe, dianTimestamp, parseDianCredentials } from "./dian.js";
import { DianInvoiceProvider, signedDocumentHash } from "./dian-provider.js";
import {
  assertIntegrationKey,
  assertIntegrationUuid,
  hash32,
  integrationDigest,
} from "./integration-utils.js";
import {
  InvoiceConflictError,
  InvoiceNotFoundError,
  InvoiceProviderError,
  InvoiceValidationError,
  type DianCredentials,
  type FiscalLine,
  type FiscalParty,
  type FiscalTransmissionResult,
  type InvoiceAuditContext,
  type InvoiceProvider,
  type InvoiceServiceOptions,
} from "./invoice-types.js";
import { buildCreditNoteUbl, buildInvoiceUbl } from "./ubl.js";

export interface FiscalOperationResult {
  readonly id: string;
  readonly status: string;
  readonly fullNumber: string;
  readonly replayed: boolean;
}

function issuer(credentials: DianCredentials): FiscalParty {
  return {
    documentType: "31",
    documentNumber: credentials.issuerNit,
    legalName: credentials.issuerLegalName,
    email: credentials.issuerEmail,
    phoneE164: credentials.issuerPhoneE164,
    addressLine1: credentials.issuerAddress,
    departmentCode: credentials.issuerDepartmentCode,
    departmentName: credentials.issuerDepartmentName,
    municipalityCode: credentials.issuerMunicipalityCode,
    municipalityName: credentials.issuerMunicipalityName,
    postalCode: credentials.issuerPostalCode,
  };
}

function buyer(order: {
  recipientNameSnapshot: string | null;
  emailSnapshot: string | null;
  phoneE164Snapshot: string | null;
  buyerDocumentTypeSnapshot: string | null;
  buyerDocumentNumberSnapshot: string | null;
  buyerTaxRegimeSnapshot: "NO_RESPONSABLE_IVA" | "RESPONSABLE_IVA" | null;
  addressLine1Snapshot: string | null;
  departmentCode: string | null;
  departmentNameSnapshot: string | null;
  municipalityCode: string | null;
  municipalityNameSnapshot: string | null;
  postalCodeSnapshot: string | null;
}): FiscalParty {
  if (
    !order.recipientNameSnapshot ||
    !order.emailSnapshot ||
    !order.phoneE164Snapshot ||
    !order.buyerDocumentTypeSnapshot ||
    !order.buyerDocumentNumberSnapshot ||
    !order.buyerTaxRegimeSnapshot ||
    !order.addressLine1Snapshot ||
    !order.departmentCode ||
    !order.departmentNameSnapshot ||
    !order.municipalityCode ||
    !order.municipalityNameSnapshot
  ) {
    throw new InvoiceValidationError("The order does not contain complete buyer fiscal snapshots.");
  }
  return {
    taxRegime: order.buyerTaxRegimeSnapshot,
    documentType: order.buyerDocumentTypeSnapshot,
    documentNumber: order.buyerDocumentNumberSnapshot,
    legalName: order.recipientNameSnapshot,
    email: order.emailSnapshot,
    phoneE164: order.phoneE164Snapshot,
    addressLine1: order.addressLine1Snapshot,
    departmentCode: order.departmentCode,
    departmentName: order.departmentNameSnapshot,
    municipalityCode: order.municipalityCode,
    municipalityName: order.municipalityNameSnapshot,
    postalCode: order.postalCodeSnapshot,
  };
}

const claimLeaseMs = 300_000;

function buildClaimToken(workerId: string): string {
  return `${workerId.slice(0, 83)}:${randomUUID()}`;
}

function taxIdentity(item: {
  taxLines: readonly { appliedRateBps: number; treatment: string; rule: string }[];
}): { taxRateBps: number; taxCategory: "STANDARD" | "EXEMPT" | "EXCLUDED" } {
  const identities = new Set(
    item.taxLines.map((line) => `${line.treatment}:${line.appliedRateBps}`),
  );
  if (identities.size !== 1)
    throw new InvoiceValidationError(
      "Every fiscal item must have exactly one sealed tax category and rate.",
    );
  const line = item.taxLines[0]!;
  if (line.treatment === "UVT_THRESHOLD_EXCLUDED" && line.rule === "UVT_STANDARD_ABOVE_LIMIT") {
    return { taxRateBps: line.appliedRateBps, taxCategory: "STANDARD" };
  }
  const categories: Record<string, "STANDARD" | "EXEMPT" | "EXCLUDED"> = {
    STANDARD: "STANDARD",
    EXEMPT: "EXEMPT",
    EXCLUDED: "EXCLUDED",
    UVT_THRESHOLD_EXCLUDED: "EXCLUDED",
  };
  const taxCategory = categories[line.treatment];
  if (!taxCategory) {
    throw new InvoiceValidationError("The sealed tax category is not supported.");
  }
  return { taxRateBps: line.appliedRateBps, taxCategory };
}

export class InvoiceService {
  constructor(
    private readonly db: import("@mundonettech/db").PrismaClient,
    private readonly options: InvoiceServiceOptions,
  ) {}

  private async credentials(credentialId: string): Promise<DianCredentials> {
    const plaintext = await this.options.vault.reveal(credentialId);
    try {
      return parseDianCredentials(plaintext, this.options.environment);
    } finally {
      plaintext.fill(0);
    }
  }

  private provider(credentials: DianCredentials): InvoiceProvider {
    return this.options.providerFactory?.(credentials) ?? new DianInvoiceProvider(credentials);
  }

  private async assertActor(
    db: PrismaClient | Prisma.TransactionClient,
    audit: InvoiceAuditContext,
    lock = false,
  ): Promise<void> {
    assertIntegrationUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (audit.requestId !== undefined) assertIntegrationUuid(audit.requestId, "requestId");
    let role: string | undefined;
    if (lock) {
      const rows = await db.$queryRaw<Array<{ role: string }>>`
        SELECT "role"::text AS "role" FROM "AdminUser"
        WHERE "id" = ${audit.actorAdminUserId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
        FOR SHARE
      `;
      role = rows[0]?.role;
    } else {
      const actor = await db.adminUser.findFirst({
        where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { role: true },
      });
      role = actor?.role;
    }
    if (!role || !isAdminRole(role) || !hasAdminPermission(role, "invoices:write")) {
      throw new InvoiceValidationError("Administrator is not authorized for fiscal operations.");
    }
  }

  private async assertHumanActor(audit?: InvoiceAuditContext): Promise<void> {
    if (audit) await this.assertActor(this.db, audit);
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    options: {
      action: string;
      targetType: "TaxInvoice" | "CreditNote";
      targetId: string;
      audit?: InvoiceAuditContext | undefined;
      metadata?: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    if (!options.audit) return;
    const audit = options.audit;
    await this.assertActor(tx, audit);
    await tx.adminActionLog.create({
      data: {
        actorAdminUserId: audit.actorAdminUserId,
        action: options.action,
        targetType: options.targetType,
        targetId: options.targetId,
        requestId: audit.requestId ?? null,
        ipHash: hash32(audit.ipHash, "ipHash"),
        userAgentHash: audit.userAgentHash ? hash32(audit.userAgentHash, "userAgentHash") : null,
        metadata: options.metadata ?? {},
      },
    });
  }

  private async selectCredential(credentialId?: string): Promise<string> {
    const credentials = await this.options.vault.list({ includeRevoked: false, limit: 100 });
    const active = credentials.items.filter((item) => item.provider === "dian" && !item.revokedAt);
    const selected = credentialId
      ? active.find((item) => item.id === credentialId)
      : active.length === 1
        ? active[0]
        : null;
    if (!selected || (credentials.items.length === 100 && credentialId === undefined))
      throw new InvoiceConflictError(
        "An explicit active DIAN credential is required.",
        "NOT_READY",
      );
    return selected.id;
  }

  async prepareInvoice(
    orderId: string,
    credentialId?: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    await this.assertHumanActor(audit);
    assertIntegrationUuid(orderId, "orderId");
    if (credentialId !== undefined) assertIntegrationUuid(credentialId, "credentialId");
    const selectedCredential = await this.selectCredential(credentialId);
    const credentials = await this.credentials(selectedCredential);
    const existing = await this.db.taxInvoice.findUnique({ where: { orderId } });
    if (existing)
      return {
        id: existing.id,
        status: existing.status,
        fullNumber: existing.fullNumber,
        replayed: true,
      };
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const orders = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      if (orders.length === 0) throw new InvoiceNotFoundError("Order not found.");
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: { include: { taxLines: true } } },
      });
      if (
        order.taxRegime !== "RESPONSABLE_IVA" ||
        !["PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)
      ) {
        throw new InvoiceConflictError(
          "Only paid orders under responsible VAT can be invoiced.",
          "NOT_READY",
        );
      }
      const duplicate = await tx.taxInvoice.findUnique({ where: { orderId } });
      if (duplicate)
        return {
          id: duplicate.id,
          status: duplicate.status,
          fullNumber: duplicate.fullNumber,
          replayed: true,
        };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"dian-invoice:" + selectedCredential + ":" + credentials.invoicePrefix}, 0))`;
      const latest = await tx.taxInvoice.aggregate({
        where: {
          credentialId: selectedCredential,
          prefix: credentials.invoicePrefix,
          number: {
            gte: credentials.invoiceResolutionStart,
            lte: credentials.invoiceResolutionEnd,
          },
        },
        _max: { number: true },
      });
      const number =
        latest._max.number === null ? credentials.invoiceResolutionStart : latest._max.number + 1;
      if (number > credentials.invoiceResolutionEnd)
        throw new InvoiceConflictError("DIAN invoice resolution is exhausted.", "NOT_READY");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const issueDate = nowRows[0]!.now;
      const localDate = dianTimestamp(issueDate).date;
      if (
        localDate < credentials.invoiceResolutionValidFrom ||
        localDate > credentials.invoiceResolutionValidTo
      )
        throw new InvoiceConflictError(
          "DIAN invoice resolution is not valid at the database timestamp.",
          "NOT_READY",
        );
      const fullNumber = `${credentials.invoicePrefix}${number}`;
      const customer = buyer(order);
      const lines: FiscalLine[] = order.items.map((item) => ({
        sku: item.skuSnapshot,
        title: item.titleSnapshot,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountCents: item.discountCents,
        lineTotalCents: item.lineTotalCents,
        taxCents: item.taxCents,
        ...taxIdentity(item),
      }));
      const cufe = calculateCufe({
        fullNumber,
        issueDate,
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
        issuerNit: credentials.issuerNit,
        buyerDocumentNumber: customer.documentNumber,
        buyerDocumentType: customer.documentType,
        softwarePin: credentials.softwarePin,
        production: this.options.environment === IntegrationEnvironment.PRD,
      });
      const unsignedXml = buildInvoiceUbl(
        {
          fullNumber,
          issueDate,
          cufe,
          resolution: {
            authorizationNumber: credentials.invoiceResolutionNumber,
            prefix: credentials.invoicePrefix,
            rangeStart: credentials.invoiceResolutionStart,
            rangeEnd: credentials.invoiceResolutionEnd,
            validFrom: credentials.invoiceResolutionValidFrom,
            validTo: credentials.invoiceResolutionValidTo,
          },
          issuer: issuer(credentials),
          buyer: customer,
          lines,
          subtotalCents: order.subtotalCents,
          discountCents: order.discountCents,
          taxCents: order.taxCents,
          shippingCents: order.shippingCents,
          totalCents: order.totalCents,
        },
        this.options.environment === IntegrationEnvironment.PRD,
      );
      const created = await tx.taxInvoice.create({
        data: {
          orderId,
          credentialId: selectedCredential,
          environment: this.options.environment,
          prefix: credentials.invoicePrefix,
          number,
          fullNumber,
          cufe,
          subtotalCents: order.subtotalCents,
          discountCents: order.discountCents,
          taxCents: order.taxCents,
          shippingCents: order.shippingCents,
          totalCents: order.totalCents,
          requestHash: integrationDigest({ fullNumber, cufe, unsignedXml }),
          unsignedXml,
        },
      });
      await tx.domainOutbox.create({
        data: {
          eventType: "invoice.transmission.requested.v1",
          aggregateType: "TaxInvoice",
          aggregateId: created.id,
          deduplicationKey: `tax-invoice:${created.id}:transmission-requested:v1`,
          payload: { orderId, invoiceId: created.id },
        },
      });
      await this.writeAudit(tx, {
        action: "TAX_INVOICE_PREPARED",
        targetType: "TaxInvoice",
        targetId: created.id,
        audit,
        metadata: { orderId, fullNumber, status: created.status },
      });
      return { id: created.id, status: created.status, fullNumber, replayed: false };
    });
  }

  async prepareCreditNote(
    refundId: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    await this.assertHumanActor(audit);
    assertIntegrationUuid(refundId, "refundId");
    const existing = await this.db.creditNote.findUnique({ where: { refundId } });
    if (existing)
      return {
        id: existing.id,
        status: existing.status,
        fullNumber: existing.fullNumber,
        replayed: true,
      };
    const refund = await this.db.orderRefund.findUnique({
      where: { id: refundId },
      include: {
        items: { include: { orderItem: { include: { taxLines: true } } } },
        order: { include: { taxInvoice: true } },
      },
    });
    if (!refund) throw new InvoiceNotFoundError("Order refund not found.");
    if (
      refund.status !== "COMPLETED" ||
      !refund.order.taxInvoice ||
      refund.order.taxInvoice.status !== "ACCEPTED"
    ) {
      throw new InvoiceConflictError(
        "A completed refund and an accepted invoice are required.",
        "NOT_READY",
      );
    }
    const credentials = await this.credentials(refund.order.taxInvoice.credentialId);
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"dian-credit-note:" + refund.order.taxInvoice!.credentialId + ":" + credentials.creditNotePrefix}, 0))`;
      const lockedRefund = await tx.orderRefund.findUniqueOrThrow({
        where: { id: refundId },
        include: { items: { include: { orderItem: { include: { taxLines: true } } } } },
      });
      if (lockedRefund.status !== "COMPLETED")
        throw new InvoiceConflictError(
          "Refund state changed before credit note preparation.",
          "NOT_READY",
        );
      const duplicate = await tx.creditNote.findUnique({ where: { refundId } });
      if (duplicate)
        return {
          id: duplicate.id,
          status: duplicate.status,
          fullNumber: duplicate.fullNumber,
          replayed: true,
        };
      const latest = await tx.creditNote.aggregate({
        where: {
          credentialId: refund.order.taxInvoice!.credentialId,
          prefix: credentials.creditNotePrefix,
        },
        _max: { number: true },
      });
      const number = (latest._max.number ?? 0) + 1;
      if (number > 2_147_483_647)
        throw new InvoiceConflictError("Credit note sequence is exhausted.", "NOT_READY");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const issueDate = nowRows[0]!.now;
      const fullNumber = `${credentials.creditNotePrefix}${number}`;
      const invoice = await tx.taxInvoice.findUniqueOrThrow({
        where: { id: refund.order.taxInvoice!.id },
        include: { order: true },
      });
      if (invoice.status !== "ACCEPTED")
        throw new InvoiceConflictError("The source invoice is not accepted.", "NOT_READY");
      const customer = buyer(invoice.order);
      const lines: FiscalLine[] = lockedRefund.items.map((item) => ({
        sku: item.orderItem.skuSnapshot,
        title: item.orderItem.titleSnapshot,
        quantity: item.quantity,
        unitPriceCents: item.orderItem.unitPriceCents,
        discountCents: item.orderItem.unitPriceCents * BigInt(item.quantity) - item.subtotalCents,
        lineTotalCents: item.subtotalCents,
        taxCents: item.taxCents,
        ...taxIdentity(item.orderItem),
      }));
      const subtotalCents = lines.reduce(
        (sum, line) => sum + line.unitPriceCents * BigInt(line.quantity),
        0n,
      );
      const discountCents = subtotalCents - lockedRefund.subtotalCents;
      const cude = calculateCude({
        fullNumber,
        issueDate,
        subtotalCents,
        discountCents,
        taxCents: lockedRefund.taxCents,
        totalCents: lockedRefund.totalCents,
        issuerNit: credentials.issuerNit,
        buyerDocumentNumber: customer.documentNumber,
        buyerDocumentType: customer.documentType,
        softwarePin: credentials.softwarePin,
        production: this.options.environment === IntegrationEnvironment.PRD,
      });
      const reasonCode = { RETRACT: 1, WARRANTY: 5, ADJUSTMENT: 4, CUSTOMER_SUPPORT: 5 }[
        lockedRefund.reason
      ];
      const unsignedXml = buildCreditNoteUbl(
        {
          fullNumber,
          issueDate,
          cude,
          invoiceFullNumber: invoice.fullNumber,
          invoiceCufe: invoice.cufe,
          invoiceIssueDate: invoice.createdAt,
          reasonCode,
          issuer: issuer(credentials),
          buyer: customer,
          lines,
          subtotalCents,
          discountCents,
          taxCents: lockedRefund.taxCents,
          shippingCents: lockedRefund.shippingCents,
          totalCents: lockedRefund.totalCents,
        },
        this.options.environment === IntegrationEnvironment.PRD,
      );
      const created = await tx.creditNote.create({
        data: {
          invoiceId: invoice.id,
          refundId,
          credentialId: invoice.credentialId,
          prefix: credentials.creditNotePrefix,
          number,
          fullNumber,
          cude,
          subtotalCents,
          discountCents,
          taxCents: lockedRefund.taxCents,
          shippingCents: lockedRefund.shippingCents,
          totalCents: lockedRefund.totalCents,
          reasonCode,
          requestHash: integrationDigest({ fullNumber, cude, unsignedXml }),
          unsignedXml,
        },
      });
      await tx.domainOutbox.create({
        data: {
          eventType: "credit-note.transmission.requested.v1",
          aggregateType: "CreditNote",
          aggregateId: created.id,
          deduplicationKey: `credit-note:${created.id}:transmission-requested:v1`,
          payload: { orderId: invoice.orderId, refundId, creditNoteId: created.id },
        },
      });
      await this.writeAudit(tx, {
        action: "CREDIT_NOTE_PREPARED",
        targetType: "CreditNote",
        targetId: created.id,
        audit,
        metadata: { orderId: invoice.orderId, refundId, fullNumber },
      });
      return { id: created.id, status: created.status, fullNumber, replayed: false };
    });
  }

  private async acceptInvoice(
    invoiceId: string,
    result: FiscalTransmissionResult,
    claimToken: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimExpiresAt: Date | null;
        }>
      >`SELECT "id", "fullNumber", "status", "claimedBy", "claimExpiresAt" FROM "TaxInvoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new InvoiceNotFoundError();
      if (current.status === "ACCEPTED")
        return {
          id: current.id,
          status: current.status,
          fullNumber: current.fullNumber,
          replayed: true,
        };
      if (!["TRANSMITTING", "UNCERTAIN"].includes(current.status))
        throw new InvoiceConflictError("Only a transmitting or uncertain invoice can be accepted.");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (
        current.claimedBy !== claimToken ||
        !current.claimExpiresAt ||
        current.claimExpiresAt <= now
      ) {
        throw new InvoiceConflictError(
          "Invoice claim ownership expired before acceptance could be recorded.",
          "PROVIDER_UNCERTAIN",
        );
      }
      await tx.taxInvoice.update({
        where: { id: invoiceId },
        data: {
          status: "ACCEPTED",
          signedXml: result.signedXml,
          documentHash: signedDocumentHash(result.signedXml),
          providerDocumentId: result.providerDocumentId,
          acceptedAt: now,
          claimedBy: null,
          claimExpiresAt: null,
          failureCode: null,
        },
      });
      const invoice = await tx.taxInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      await tx.domainOutbox.upsert({
        where: { deduplicationKey: `tax-invoice:${invoiceId}:accepted:v1` },
        create: {
          eventType: "invoice.accepted.v1",
          aggregateType: "TaxInvoice",
          aggregateId: invoiceId,
          deduplicationKey: `tax-invoice:${invoiceId}:accepted:v1`,
          payload: { orderId: invoice.orderId, invoiceId },
        },
        update: {},
      });
      await this.writeAudit(tx, {
        action: "TAX_INVOICE_ACCEPTED",
        targetType: "TaxInvoice",
        targetId: invoiceId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          fullNumber: invoice.fullNumber,
          providerDocumentId: result.providerDocumentId,
        },
      });
      return { id: invoiceId, status: "ACCEPTED", fullNumber: invoice.fullNumber, replayed: false };
    });
  }

  private async failInvoice(
    invoiceId: string,
    claimToken: string,
    uncertain: boolean,
    code: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimActive: boolean;
        }>
      >`SELECT "id", "orderId", "fullNumber", "status", "claimedBy", ("claimExpiresAt" > CURRENT_TIMESTAMP) AS "claimActive" FROM "TaxInvoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) {
        return {
          id: current.id,
          status: current.status as FiscalOperationResult["status"],
          fullNumber: current.fullNumber,
          replayed: true,
        };
      }
      if (
        current.status !== "TRANSMITTING" ||
        current.claimedBy !== claimToken ||
        !current.claimActive
      ) {
        throw new InvoiceConflictError(
          "Invoice claim ownership changed before failure could be recorded.",
        );
      }
      const invoice = await tx.taxInvoice.update({
        where: { id: invoiceId },
        data: {
          status: uncertain ? "UNCERTAIN" : "REJECTED",
          failureCode: code.slice(0, 200),
          claimedBy: null,
          claimExpiresAt: null,
        },
      });
      if (!uncertain) {
        await tx.domainOutbox.upsert({
          where: { deduplicationKey: `tax-invoice:${invoiceId}:rejected:v1` },
          create: {
            eventType: "invoice.rejected.v1",
            aggregateType: "TaxInvoice",
            aggregateId: invoiceId,
            deduplicationKey: `tax-invoice:${invoiceId}:rejected:v1`,
            payload: { orderId: invoice.orderId, invoiceId },
          },
          update: {},
        });
      }
      await this.writeAudit(tx, {
        action: uncertain ? "TAX_INVOICE_MARKED_UNCERTAIN" : "TAX_INVOICE_REJECTED",
        targetType: "TaxInvoice",
        targetId: invoiceId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          fullNumber: invoice.fullNumber,
          code: code.slice(0, 200),
        },
      });
      return {
        id: invoice.id,
        status: invoice.status,
        fullNumber: invoice.fullNumber,
        replayed: false,
      };
    });
  }

  private async releaseUncertainInvoiceClaim(
    invoiceId: string,
    claimToken: string,
    code: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimActive: boolean;
        }>
      >`SELECT "id", "orderId", "fullNumber", "status", "claimedBy", ("claimExpiresAt" > CURRENT_TIMESTAMP) AS "claimActive" FROM "TaxInvoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) {
        return {
          id: current.id,
          status: current.status as FiscalOperationResult["status"],
          fullNumber: current.fullNumber,
          replayed: true,
        };
      }
      if (
        current.status !== "UNCERTAIN" ||
        current.claimedBy !== claimToken ||
        !current.claimActive
      ) {
        throw new InvoiceConflictError(
          "Invoice claim ownership changed before uncertain release could be recorded.",
        );
      }
      const invoice = await tx.taxInvoice.update({
        where: { id: invoiceId },
        data: {
          failureCode: code.slice(0, 200),
          claimedBy: null,
          claimExpiresAt: null,
        },
      });
      await this.writeAudit(tx, {
        action: "TAX_INVOICE_MARKED_UNCERTAIN",
        targetType: "TaxInvoice",
        targetId: invoiceId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          fullNumber: invoice.fullNumber,
          code: code.slice(0, 200),
        },
      });
      return {
        id: invoice.id,
        status: invoice.status,
        fullNumber: invoice.fullNumber,
        replayed: false,
      };
    });
  }

  async transmitInvoice(
    invoiceId: string,
    workerIdInput: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    await this.assertHumanActor(audit);
    assertIntegrationUuid(invoiceId, "invoiceId");
    const workerId = assertIntegrationKey(workerIdInput, "workerId");
    const claimToken = buildClaimToken(workerId);
    const claimed = await this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const rows = await tx.$queryRaw<
        Array<import("@mundonettech/db").TaxInvoice>
      >`SELECT * FROM "TaxInvoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) return current;
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (current.claimExpiresAt && current.claimExpiresAt > now)
        throw new InvoiceConflictError("Another worker owns this fiscal document claim.");
      const claimExpiresAt = new Date(now.getTime() + claimLeaseMs);
      if (current.status === "DRAFT") {
        return tx.taxInvoice.update({
          where: { id: invoiceId },
          data: {
            status: "TRANSMITTING",
            claimedBy: claimToken,
            claimExpiresAt,
            transmittedAt: null,
            failureCode: null,
          },
        });
      }
      if (current.status === "UNCERTAIN") {
        return tx.taxInvoice.update({
          where: { id: invoiceId },
          data: { claimedBy: claimToken, claimExpiresAt },
        });
      }
      if (current.status === "TRANSMITTING") {
        return tx.taxInvoice.update({
          where: { id: invoiceId },
          data: { status: "UNCERTAIN", claimedBy: claimToken, claimExpiresAt },
        });
      }
      throw new InvoiceConflictError("Invoice cannot be transmitted in its current state.");
    });
    if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(claimed.status))
      return {
        id: claimed.id,
        status: claimed.status,
        fullNumber: claimed.fullNumber,
        replayed: true,
      };
    let current = claimed;
    try {
      const credentials = await this.credentials(claimed.credentialId);
      const provider = this.provider(credentials);
      if (current.status === "UNCERTAIN") {
        const found = await provider.find(current.cufe, current.fullNumber, "INVOICE");
        if (found) return this.acceptInvoice(invoiceId, found, claimToken, audit);
        current = await this.db.$transaction(async (tx) => {
          const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
          const now = nowRows[0]!.now;
          const moved = await tx.taxInvoice.updateMany({
            where: {
              id: invoiceId,
              status: "UNCERTAIN",
              claimedBy: claimToken,
              claimExpiresAt: { gt: now },
            },
            data: {
              status: "TRANSMITTING",
              transmittedAt: null,
              claimExpiresAt: new Date(now.getTime() + claimLeaseMs),
            },
          });
          if (moved.count !== 1) {
            throw new InvoiceConflictError(
              "Invoice claim ownership changed during reconciliation.",
            );
          }
          return tx.taxInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
        });
      }
      if (!current.transmittedAt) {
        current = await this.db.$transaction(async (tx) => {
          const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
          const now = nowRows[0]!.now;
          const stamped = await tx.taxInvoice.updateMany({
            where: {
              id: invoiceId,
              status: "TRANSMITTING",
              claimedBy: claimToken,
              claimExpiresAt: { gt: now },
            },
            data: {
              transmittedAt: now,
              claimExpiresAt: new Date(now.getTime() + claimLeaseMs),
            },
          });
          if (stamped.count !== 1) {
            throw new InvoiceConflictError("Invoice claim ownership changed before transmission.");
          }
          return tx.taxInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
        });
      }
      const result = await provider.transmit({
        documentId: current.id,
        idempotencyKey: `fiscal:${current.id}`,
        documentType: "INVOICE",
        documentNumber: current.fullNumber,
        documentHash: current.cufe,
        unsignedXml: current.unsignedXml,
      });
      return await this.acceptInvoice(invoiceId, result, claimToken, audit);
    } catch (error) {
      if (error instanceof InvoiceConflictError) throw error;
      if (error instanceof InvoiceProviderError) {
        if (current.status === "UNCERTAIN") {
          return this.releaseUncertainInvoiceClaim(invoiceId, claimToken, error.code, audit);
        }
        const uncertain = ["NETWORK_UNCERTAIN", "INVALID_RESPONSE"].includes(error.code);
        return this.failInvoice(invoiceId, claimToken, uncertain, error.code, audit);
      }
      if (current.status === "UNCERTAIN") {
        await this.releaseUncertainInvoiceClaim(
          invoiceId,
          claimToken,
          "PRE_TRANSMIT_ERROR",
          audit,
        ).catch(() => undefined);
      } else {
        await this.failInvoice(invoiceId, claimToken, true, "PRE_TRANSMIT_ERROR", audit).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  private async acceptCreditNote(
    creditNoteId: string,
    result: FiscalTransmissionResult,
    claimToken: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimExpiresAt: Date | null;
        }>
      >`SELECT "id", "fullNumber", "status", "claimedBy", "claimExpiresAt" FROM "CreditNote" WHERE "id" = ${creditNoteId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new InvoiceNotFoundError();
      if (current.status === "ACCEPTED")
        return {
          id: current.id,
          status: current.status,
          fullNumber: current.fullNumber,
          replayed: true,
        };
      if (!["TRANSMITTING", "UNCERTAIN"].includes(current.status))
        throw new InvoiceConflictError(
          "Only a transmitting or uncertain credit note can be accepted.",
        );
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (
        current.claimedBy !== claimToken ||
        !current.claimExpiresAt ||
        current.claimExpiresAt <= now
      ) {
        throw new InvoiceConflictError(
          "Credit note claim ownership expired before acceptance could be recorded.",
          "PROVIDER_UNCERTAIN",
        );
      }
      const note = await tx.creditNote.update({
        where: { id: creditNoteId },
        data: {
          status: "ACCEPTED",
          signedXml: result.signedXml,
          documentHash: signedDocumentHash(result.signedXml),
          providerDocumentId: result.providerDocumentId,
          acceptedAt: now,
          claimedBy: null,
          claimExpiresAt: null,
          failureCode: null,
        },
      });
      const invoice = await tx.taxInvoice.findUniqueOrThrow({ where: { id: note.invoiceId } });
      await tx.domainOutbox.upsert({
        where: { deduplicationKey: `credit-note:${creditNoteId}:accepted:v1` },
        create: {
          eventType: "credit-note.accepted.v1",
          aggregateType: "CreditNote",
          aggregateId: creditNoteId,
          deduplicationKey: `credit-note:${creditNoteId}:accepted:v1`,
          payload: { orderId: invoice.orderId, refundId: note.refundId, creditNoteId },
        },
        update: {},
      });
      await this.writeAudit(tx, {
        action: "CREDIT_NOTE_ACCEPTED",
        targetType: "CreditNote",
        targetId: creditNoteId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          refundId: note.refundId,
          fullNumber: note.fullNumber,
          providerDocumentId: result.providerDocumentId,
        },
      });
      return { id: creditNoteId, status: "ACCEPTED", fullNumber: note.fullNumber, replayed: false };
    });
  }

  private async failCreditNote(
    creditNoteId: string,
    claimToken: string,
    uncertain: boolean,
    code: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          invoiceId: string;
          refundId: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimActive: boolean;
        }>
      >`SELECT "id", "invoiceId", "refundId", "fullNumber", "status", "claimedBy", ("claimExpiresAt" > CURRENT_TIMESTAMP) AS "claimActive" FROM "CreditNote" WHERE "id" = ${creditNoteId}::uuid FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) {
        return {
          id: current.id,
          status: current.status as FiscalOperationResult["status"],
          fullNumber: current.fullNumber,
          replayed: true,
        };
      }
      if (
        current.status !== "TRANSMITTING" ||
        current.claimedBy !== claimToken ||
        !current.claimActive
      ) {
        throw new InvoiceConflictError(
          "Credit note claim ownership changed before failure could be recorded.",
        );
      }
      const note = await tx.creditNote.update({
        where: { id: creditNoteId },
        data: {
          status: uncertain ? "UNCERTAIN" : "REJECTED",
          failureCode: code.slice(0, 200),
          claimedBy: null,
          claimExpiresAt: null,
        },
      });
      const invoice = await tx.taxInvoice.findUniqueOrThrow({ where: { id: note.invoiceId } });
      if (!uncertain) {
        await tx.domainOutbox.upsert({
          where: { deduplicationKey: `credit-note:${creditNoteId}:rejected:v1` },
          create: {
            eventType: "credit-note.rejected.v1",
            aggregateType: "CreditNote",
            aggregateId: creditNoteId,
            deduplicationKey: `credit-note:${creditNoteId}:rejected:v1`,
            payload: { orderId: invoice.orderId, refundId: note.refundId, creditNoteId },
          },
          update: {},
        });
      }
      await this.writeAudit(tx, {
        action: uncertain ? "CREDIT_NOTE_MARKED_UNCERTAIN" : "CREDIT_NOTE_REJECTED",
        targetType: "CreditNote",
        targetId: creditNoteId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          refundId: note.refundId,
          fullNumber: note.fullNumber,
          code: code.slice(0, 200),
        },
      });
      return { id: note.id, status: note.status, fullNumber: note.fullNumber, replayed: false };
    });
  }

  private async releaseUncertainCreditNoteClaim(
    creditNoteId: string,
    claimToken: string,
    code: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    return this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          invoiceId: string;
          refundId: string;
          fullNumber: string;
          status: string;
          claimedBy: string | null;
          claimActive: boolean;
        }>
      >`SELECT "id", "invoiceId", "refundId", "fullNumber", "status", "claimedBy", ("claimExpiresAt" > CURRENT_TIMESTAMP) AS "claimActive" FROM "CreditNote" WHERE "id" = ${creditNoteId}::uuid FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) {
        return {
          id: current.id,
          status: current.status as FiscalOperationResult["status"],
          fullNumber: current.fullNumber,
          replayed: true,
        };
      }
      if (
        current.status !== "UNCERTAIN" ||
        current.claimedBy !== claimToken ||
        !current.claimActive
      ) {
        throw new InvoiceConflictError(
          "Credit note claim ownership changed before uncertain release could be recorded.",
        );
      }
      const note = await tx.creditNote.update({
        where: { id: creditNoteId },
        data: {
          failureCode: code.slice(0, 200),
          claimedBy: null,
          claimExpiresAt: null,
        },
      });
      const invoice = await tx.taxInvoice.findUniqueOrThrow({ where: { id: note.invoiceId } });
      await this.writeAudit(tx, {
        action: "CREDIT_NOTE_MARKED_UNCERTAIN",
        targetType: "CreditNote",
        targetId: creditNoteId,
        audit,
        metadata: {
          orderId: invoice.orderId,
          refundId: note.refundId,
          fullNumber: note.fullNumber,
          code: code.slice(0, 200),
        },
      });
      return { id: note.id, status: note.status, fullNumber: note.fullNumber, replayed: false };
    });
  }

  async transmitCreditNote(
    creditNoteId: string,
    workerIdInput: string,
    audit?: InvoiceAuditContext,
  ): Promise<FiscalOperationResult> {
    await this.assertHumanActor(audit);
    assertIntegrationUuid(creditNoteId, "creditNoteId");
    const workerId = assertIntegrationKey(workerIdInput, "workerId");
    const claimToken = buildClaimToken(workerId);
    const claimed = await this.db.$transaction(async (tx) => {
      if (audit) await this.assertActor(tx, audit, true);
      const rows = await tx.$queryRaw<
        Array<import("@mundonettech/db").CreditNote>
      >`SELECT * FROM "CreditNote" WHERE "id" = ${creditNoteId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new InvoiceNotFoundError();
      if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(current.status)) return current;
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (current.claimExpiresAt && current.claimExpiresAt > now)
        throw new InvoiceConflictError("Another worker owns this fiscal document claim.");
      const claimExpiresAt = new Date(now.getTime() + claimLeaseMs);
      if (current.status === "DRAFT") {
        return tx.creditNote.update({
          where: { id: creditNoteId },
          data: {
            status: "TRANSMITTING",
            claimedBy: claimToken,
            claimExpiresAt,
            transmittedAt: null,
            failureCode: null,
          },
        });
      }
      if (current.status === "UNCERTAIN") {
        return tx.creditNote.update({
          where: { id: creditNoteId },
          data: { claimedBy: claimToken, claimExpiresAt },
        });
      }
      if (current.status === "TRANSMITTING") {
        return tx.creditNote.update({
          where: { id: creditNoteId },
          data: { status: "UNCERTAIN", claimedBy: claimToken, claimExpiresAt },
        });
      }
      throw new InvoiceConflictError("Credit note cannot be transmitted in its current state.");
    });
    if (["ACCEPTED", "REJECTED", "CANCELLED"].includes(claimed.status))
      return {
        id: claimed.id,
        status: claimed.status,
        fullNumber: claimed.fullNumber,
        replayed: true,
      };
    let current = claimed;
    try {
      const credentials = await this.credentials(claimed.credentialId);
      const provider = this.provider(credentials);
      if (current.status === "UNCERTAIN") {
        const found = await provider.find(current.cude, current.fullNumber, "CREDIT_NOTE");
        if (found) return this.acceptCreditNote(creditNoteId, found, claimToken, audit);
        current = await this.db.$transaction(async (tx) => {
          const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
          const now = nowRows[0]!.now;
          const moved = await tx.creditNote.updateMany({
            where: {
              id: creditNoteId,
              status: "UNCERTAIN",
              claimedBy: claimToken,
              claimExpiresAt: { gt: now },
            },
            data: {
              status: "TRANSMITTING",
              transmittedAt: null,
              claimExpiresAt: new Date(now.getTime() + claimLeaseMs),
            },
          });
          if (moved.count !== 1) {
            throw new InvoiceConflictError(
              "Credit note claim ownership changed during reconciliation.",
            );
          }
          return tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
        });
      }
      if (!current.transmittedAt) {
        current = await this.db.$transaction(async (tx) => {
          const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
          const now = nowRows[0]!.now;
          const stamped = await tx.creditNote.updateMany({
            where: {
              id: creditNoteId,
              status: "TRANSMITTING",
              claimedBy: claimToken,
              claimExpiresAt: { gt: now },
            },
            data: {
              transmittedAt: now,
              claimExpiresAt: new Date(now.getTime() + claimLeaseMs),
            },
          });
          if (stamped.count !== 1) {
            throw new InvoiceConflictError(
              "Credit note claim ownership changed before transmission.",
            );
          }
          return tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
        });
      }
      const result = await provider.transmit({
        documentId: current.id,
        idempotencyKey: `fiscal:${current.id}`,
        documentType: "CREDIT_NOTE",
        documentNumber: current.fullNumber,
        documentHash: current.cude,
        unsignedXml: current.unsignedXml,
      });
      return await this.acceptCreditNote(creditNoteId, result, claimToken, audit);
    } catch (error) {
      if (error instanceof InvoiceConflictError) throw error;
      if (error instanceof InvoiceProviderError) {
        if (current.status === "UNCERTAIN") {
          return this.releaseUncertainCreditNoteClaim(creditNoteId, claimToken, error.code, audit);
        }
        const uncertain = ["NETWORK_UNCERTAIN", "INVALID_RESPONSE"].includes(error.code);
        return this.failCreditNote(creditNoteId, claimToken, uncertain, error.code, audit);
      }
      if (current.status === "UNCERTAIN") {
        await this.releaseUncertainCreditNoteClaim(
          creditNoteId,
          claimToken,
          "PRE_TRANSMIT_ERROR",
          audit,
        ).catch(() => undefined);
      } else {
        await this.failCreditNote(
          creditNoteId,
          claimToken,
          true,
          "PRE_TRANSMIT_ERROR",
          audit,
        ).catch(() => undefined);
      }
      throw error;
    }
  }
}
