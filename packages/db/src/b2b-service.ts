import { randomBytes, randomUUID } from "node:crypto";

import {
  assertB2bExpiry,
  calculateOrderTaxes,
  maskIdentifier,
  maskName,
  normalizePriceListCode,
  normalizeSku,
  type StoreTaxRegimeValue,
} from "@mundonettech/core";

import { CartService } from "./cart-service.js";
import { maskCrmContact, maskCrmOrganization } from "./crm-presenters.js";
import {
  crmIdentityHash,
  crmRetentionReviewAt,
  normalizeCrmContactInput,
  normalizeCrmOrganizationInput,
} from "./crm-shared.js";
import { IdempotencyStatus } from "./generated/client.js";
import type {
  OpportunityProposal,
  Prisma,
  PrismaClient,
  ProductVariant,
  StoreSettings,
} from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  inInventoryTransaction,
  isSellableVariant,
} from "./inventory-shared.js";
import { acquireIdempotencyKey, completeIdempotencyKey } from "./primitives.js";
import type { CheckoutDefaults } from "./order-types.js";
import {
  B2bError,
  assertProposalIntegrity,
  b2bActor,
  b2bDate,
  b2bEmail,
  b2bHash,
  b2bLog,
  b2bMoney,
  b2bNow,
  b2bOptionalHash,
  b2bOptionalText,
  b2bPhone,
  b2bText,
  b2bVersion,
  proposalContentHash,
  sha256,
  type ProposalContentSource,
} from "./b2b-shared.js";
import type {
  B2bLeadInput,
  B2bOpportunityListItem,
  B2bPriceListView,
  B2bProposalLineInput,
  CreateB2bProposalInput,
  PriceListInput,
  PriceListItemInput,
  PublicB2bProposal,
} from "./b2b-types.js";

const leadScope = "b2b-lead";

type VariantForProposal = ProductVariant & {
  readonly product: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
    readonly deletedAt: Date | null;
    readonly brand: { readonly deletedAt: Date | null };
    readonly category: { readonly deletedAt: Date | null };
    readonly taxGroup: {
      readonly code: string;
      readonly name: string;
      readonly treatment: "STANDARD" | "EXEMPT" | "EXCLUDED" | "UVT_THRESHOLD_EXCLUDED";
      readonly rateBps: number;
      readonly uvtLimit: number | null;
      readonly aboveUvtRateBps: number | null;
    };
  };
};

function settingsFromRecord(settings: StoreSettings): CheckoutDefaults {
  return {
    taxRegime: settings.taxRegime,
    currency: "COP",
    timeZone: settings.timeZone,
    orderNumberPrefix: settings.orderNumberPrefix,
    orderNumberPadding: settings.orderNumberPadding,
    uvtValueCents: settings.uvtValueCents,
    uvtYear: settings.uvtYear,
    standardShippingCents: settings.standardShippingCents,
    deliveryPromiseDays: settings.deliveryPromiseDays,
    reservationMinutes: settings.reservationMinutes,
    clickAndCollectEnabled: settings.clickAndCollectEnabled,
  };
}

function validateDefaults(settings: CheckoutDefaults): CheckoutDefaults {
  if (!["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(settings.taxRegime)) {
    throw new B2bError("VALIDATION", "Invalid store tax regime.");
  }
  if (settings.currency !== "COP") throw new B2bError("VALIDATION", "B2B currency must be COP.");
  b2bText(settings.timeZone, "timeZone", 1, 64);
  b2bMoney(settings.uvtValueCents, "uvtValueCents", true);
  b2bMoney(settings.standardShippingCents, "standardShippingCents");
  if (!Number.isInteger(settings.uvtYear) || settings.uvtYear < 2000 || settings.uvtYear > 9999) {
    throw new B2bError("VALIDATION", "Invalid UVT year.");
  }
  if (
    !Number.isInteger(settings.deliveryPromiseDays) ||
    settings.deliveryPromiseDays < 1 ||
    settings.deliveryPromiseDays > 365 ||
    !Number.isInteger(settings.reservationMinutes) ||
    settings.reservationMinutes < 5 ||
    settings.reservationMinutes > 10_080
  ) {
    throw new B2bError("VALIDATION", "Invalid delivery or reservation settings.");
  }
  return settings;
}

function normalizePriceListInput(input: PriceListInput) {
  let code: string;
  try {
    code = normalizePriceListCode(input.code);
  } catch (error) {
    throw new B2bError("VALIDATION", error instanceof Error ? error.message : "Invalid code.");
  }
  const validFrom = input.validFrom ? b2bDate(input.validFrom, "validFrom") : null;
  const validTo = input.validTo ? b2bDate(input.validTo, "validTo") : null;
  if (validFrom && validTo && validTo <= validFrom) {
    throw new B2bError("VALIDATION", "validTo must be later than validFrom.");
  }
  return {
    code,
    name: b2bText(input.name, "name", 2, 160),
    description: b2bOptionalText(input.description, "description", 500),
    validFrom,
    validTo,
  };
}

function normalizeSkuValue(value: string): string {
  try {
    return normalizeSku(value);
  } catch (error) {
    throw new B2bError("VALIDATION", error instanceof Error ? error.message : "Invalid SKU.");
  }
}

function sellable(variant: VariantForProposal): boolean {
  return isSellableVariant(variant);
}

function publicUnavailableReason(
  proposal: OpportunityProposal,
  currentVersion: number,
  now: Date,
): PublicB2bProposal["unavailableReason"] {
  if (proposal.status === "CONVERTED") return "CONVERTED";
  if (proposal.status === "CANCELLED") return "CANCELLED";
  if (proposal.status === "SUPERSEDED" || proposal.version !== currentVersion) return "SUPERSEDED";
  if (proposal.status === "EXPIRED" || proposal.expiresAt <= now) return "EXPIRED";
  return null;
}

export class B2bService {
  constructor(
    private readonly db: PrismaClient,
    private readonly defaults: CheckoutDefaults,
  ) {
    validateDefaults(defaults);
  }

  private async lockedSettings(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-settings-default'))`;
    const stored = await tx.storeSettings.findUnique({ where: { key: "default" } });
    return validateDefaults(stored ? settingsFromRecord(stored) : this.defaults);
  }

  async captureOpportunity(input: B2bLeadInput) {
    const organizationInput = normalizeCrmOrganizationInput({
      legalName: input.legalName,
      commercialName: input.commercialName ?? null,
      taxId: input.taxId,
    });
    if (!organizationInput.taxId) throw new B2bError("VALIDATION", "A tax identifier is required.");
    const contactInput = normalizeCrmContactInput({
      givenName: input.givenName,
      familyName: input.familyName,
      email: b2bEmail(input.email),
      phoneE164: b2bPhone(input.phoneE164),
      source: "storefront-b2b",
    });
    const requirements = b2bText(input.requirements, "requirements", 10, 5000);
    const privacyPolicyVersion = b2bText(input.privacyPolicyVersion, "privacyPolicyVersion", 1, 50);
    const acceptanceProofHash = b2bHash(input.acceptanceProofHash, "acceptanceProofHash");
    const acceptanceIpHash = b2bOptionalHash(input.acceptanceIpHash, "acceptanceIpHash");
    const acceptanceUserAgentHash = b2bOptionalHash(
      input.acceptanceUserAgentHash,
      "acceptanceUserAgentHash",
    );
    const idempotency = {
      keyHash: b2bHash(input.idempotency.keyHash, "keyHash"),
      subjectHash: b2bHash(input.idempotency.subjectHash, "subjectHash"),
      requestHash: b2bHash(input.idempotency.requestHash, "requestHash"),
      expiresAt: b2bDate(input.idempotency.expiresAt, "idempotency.expiresAt"),
    };
    return inInventoryTransaction(this.db, async (tx) => {
      const acquired = await acquireIdempotencyKey(tx, { scope: leadScope, ...idempotency });
      if (!acquired.acquired) {
        if (
          acquired.status === IdempotencyStatus.SUCCEEDED &&
          acquired.resultType === "Opportunity" &&
          acquired.resultId
        ) {
          return { opportunityId: acquired.resultId, replayed: true };
        }
        throw new B2bError("CONFLICT", "An equivalent opportunity capture is in progress.");
      }
      await acquireOperationLocks(tx, [
        `crm-org-tax:${organizationInput.taxId}`,
        `b2b-contact:${contactInput.email}`,
      ]);
      const now = await b2bNow(tx);
      let organization = await tx.organization.findFirst({
        where: { taxId: organizationInput.taxId, deletedAt: null },
      });
      if (!organization) {
        organization = await tx.organization.create({ data: organizationInput });
      }
      let contact = await tx.contact.findFirst({
        where: {
          organizationId: organization.id,
          email: contactInput.email,
          status: "ACTIVE",
          deletedAt: null,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (!contact) {
        contact = await tx.contact.create({
          data: {
            ...contactInput,
            organizationId: organization.id,
            retentionReviewAt: await crmRetentionReviewAt(tx, 24),
            lastActivityAt: now,
          },
        });
        await tx.contactIdentity.createMany({
          data: [
            {
              contactId: contact.id,
              kind: "EMAIL" as const,
              normalizedValue: contactInput.email!,
              valueHash: crmIdentityHash("EMAIL", contactInput.email!),
            },
            {
              contactId: contact.id,
              kind: "PHONE" as const,
              normalizedValue: contactInput.phoneE164!,
              valueHash: crmIdentityHash("PHONE", contactInput.phoneE164!),
            },
          ],
        });
      } else {
        await tx.contact.update({
          where: { id: contact.id },
          data: {
            lastActivityAt: now,
            retentionReviewAt: await crmRetentionReviewAt(tx, 24),
            version: { increment: 1 },
          },
        });
      }
      const opportunity = await tx.opportunity.create({
        data: {
          organizationId: organization.id,
          contactId: contact.id,
          source: "storefront-b2b",
          requirements,
          privacyPolicyVersion,
          acceptanceProofHash,
          acceptanceIpHash,
          acceptanceUserAgentHash,
          acceptedAt: now,
        },
      });
      const completed = await completeIdempotencyKey(tx, {
        scope: leadScope,
        ...idempotency,
        status: IdempotencyStatus.SUCCEEDED,
        responseStatus: 201,
        resultType: "Opportunity",
        resultId: opportunity.id,
      });
      if (!completed) throw new B2bError("CONFLICT", "Unable to seal opportunity idempotency.");
      return { opportunityId: opportunity.id, replayed: false };
    });
  }

  async listOpportunities(
    options: {
      readonly status?: "NEW" | "QUALIFYING" | "PROPOSAL_SENT" | "WON" | "LOST" | "CANCELLED";
      readonly page?: number;
      readonly pageSize?: number;
    } = {},
  ): Promise<{
    readonly items: readonly B2bOpportunityListItem[];
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
  }> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    if (!Number.isInteger(page) || page < 1 || page > 100_000) {
      throw new B2bError("VALIDATION", "Invalid opportunity page.");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new B2bError("VALIDATION", "Invalid opportunity page size.");
    }
    const where = { ...(options.status ? { status: options.status } : {}) };
    const [total, records] = await this.db.$transaction([
      this.db.opportunity.count({ where }),
      this.db.opportunity.findMany({
        where,
        include: { organization: true, contact: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: records.map((record) => {
        const organization = maskCrmOrganization(record.organization)!;
        const contact = maskCrmContact(record.contact);
        return {
          id: record.id,
          status: record.status,
          source: record.source,
          requirements: record.requirements,
          currentVersion: record.currentVersion,
          version: record.version,
          createdAt: record.createdAt,
          organization: {
            id: organization.id,
            legalName: organization.legalName,
            taxId: organization.taxId,
            priceListId: organization.priceListId,
          },
          contact: {
            id: contact.id,
            givenName: contact.givenName,
            familyName: contact.familyName,
            email: contact.email,
            phoneE164: contact.phoneE164,
          },
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async getOpportunity(id: string) {
    assertUuid(id, "opportunityId");
    const record = await this.db.opportunity.findUnique({
      where: { id },
      include: {
        organization: { include: { priceList: true } },
        contact: true,
        proposals: {
          include: { items: { orderBy: [{ skuSnapshot: "asc" }, { id: "asc" }] } },
          orderBy: [{ version: "desc" }],
        },
        copilotRuns: { orderBy: [{ createdAt: "desc" }], take: 20 },
      },
    });
    if (!record) throw new B2bError("NOT_FOUND", "Opportunity not found.");
    return {
      id: record.id,
      status: record.status,
      source: record.source,
      requirements: record.requirements,
      currentVersion: record.currentVersion,
      version: record.version,
      acceptedAt: record.acceptedAt,
      anonymizedAt: record.anonymizedAt,
      createdAt: record.createdAt,
      organization: {
        ...maskCrmOrganization(record.organization),
        priceList: record.organization.priceList
          ? {
              id: record.organization.priceList.id,
              code: record.organization.priceList.code,
              name: record.organization.priceList.name,
              status: record.organization.priceList.status,
              version: record.organization.priceList.version,
            }
          : null,
      },
      contact: maskCrmContact(record.contact),
      proposals: record.proposals.map((proposal) => ({
        ...proposal,
        signerName: proposal.signerName ? maskName(proposal.signerName) : null,
        signerDocumentNumber: maskIdentifier(proposal.signerDocumentNumber),
      })),
      copilotRuns: record.copilotRuns,
    };
  }

  async listPriceLists(): Promise<readonly B2bPriceListView[]> {
    const records = await this.db.priceList.findMany({
      include: { _count: { select: { items: true, organizations: true } } },
      orderBy: [{ createdAt: "desc" }, { code: "asc" }],
      take: 500,
    });
    return records.map((record) => ({
      id: record.id,
      code: record.code,
      name: record.name,
      description: record.description,
      status: record.status,
      validFrom: record.validFrom,
      validTo: record.validTo,
      version: record.version,
      itemCount: record._count.items,
      organizationCount: record._count.organizations,
    }));
  }

  async getPriceList(id: string) {
    assertUuid(id, "priceListId");
    const record = await this.db.priceList.findUnique({
      where: { id },
      include: {
        items: {
          include: { variant: { include: { product: true } } },
          orderBy: { variantId: "asc" },
        },
        organizations: { where: { deletedAt: null }, orderBy: { legalName: "asc" } },
      },
    });
    if (!record) throw new B2bError("NOT_FOUND", "Price list not found.");
    return {
      ...record,
      organizations: record.organizations.map((organization) => maskCrmOrganization(organization)!),
    };
  }

  async createPriceList(input: PriceListInput, audit: CreateB2bProposalInput["audit"]) {
    const values = normalizePriceListInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-price-list-code:${values.code}`]);
      const duplicate = await tx.priceList.findFirst({
        where: { code: values.code, deletedAt: null },
        select: { id: true },
      });
      if (duplicate) throw new B2bError("CONFLICT", "An active price list already uses this code.");
      const record = await tx.priceList.create({ data: values });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_CREATED", "PriceList", record.id, {
        code: record.code,
      });
      return record;
    });
  }

  async updatePriceList(
    id: string,
    expectedVersion: number,
    input: PriceListInput,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(id, "priceListId");
    const version = b2bVersion(expectedVersion);
    const values = normalizePriceListInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [
        `b2b-price-list:${id}`,
        `b2b-price-list-code:${values.code}`,
      ]);
      const current = await tx.priceList.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw new B2bError("NOT_FOUND", "Price list not found.");
      if (current.version !== version || current.status !== "DRAFT") {
        throw new B2bError("CONFLICT", "Only an unchanged draft price list can be edited.");
      }
      const duplicate = await tx.priceList.findFirst({
        where: { code: values.code, deletedAt: null, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) throw new B2bError("CONFLICT", "Another price list already uses this code.");
      const record = await tx.priceList.update({
        where: { id },
        data: { ...values, version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_UPDATED", "PriceList", id, {
        version: record.version,
      });
      return record;
    });
  }

  async activatePriceList(
    id: string,
    expectedVersion: number,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(id, "priceListId");
    const version = b2bVersion(expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-price-list:${id}`]);
      const current = await tx.priceList.findUnique({
        where: { id },
        include: {
          items: {
            include: {
              variant: {
                include: { product: { include: { brand: true, category: true, taxGroup: true } } },
              },
            },
          },
        },
      });
      if (!current || current.deletedAt) throw new B2bError("NOT_FOUND", "Price list not found.");
      if (current.version !== version || current.status !== "DRAFT") {
        throw new B2bError("CONFLICT", "The price list changed or is already active.");
      }
      const now = await b2bNow(tx);
      if (current.validTo && current.validTo <= now) {
        throw new B2bError("VALIDATION", "An expired price list cannot be activated.");
      }
      if (current.items.length === 0) {
        throw new B2bError("VALIDATION", "Add at least one item before activating the price list.");
      }
      if (
        current.items.some(
          (item) =>
            !sellable(item.variant as VariantForProposal) ||
            item.unitPriceCents > item.variant.priceCents,
        )
      ) {
        throw new B2bError(
          "CONFLICT",
          "Every price list variant must remain active and not exceed its catalog price.",
        );
      }
      const record = await tx.priceList.update({
        where: { id },
        data: { status: "ACTIVE", version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_ACTIVATED", "PriceList", id, {
        itemCount: current.items.length,
      });
      return record;
    });
  }

  async archivePriceList(
    id: string,
    expectedVersion: number,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(id, "priceListId");
    const version = b2bVersion(expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-price-list:${id}`]);
      const current = await tx.priceList.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw new B2bError("NOT_FOUND", "Price list not found.");
      if (current.version !== version) throw new B2bError("CONFLICT", "The price list changed.");
      const assigned = await tx.organization.count({
        where: { priceListId: id, deletedAt: null },
      });
      if (assigned > 0) {
        throw new B2bError("CONFLICT", "Unassign organizations before archiving the price list.");
      }
      const now = await b2bNow(tx);
      const record = await tx.priceList.update({
        where: { id },
        data: { status: "ARCHIVED", deletedAt: now, version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_ARCHIVED", "PriceList", id);
      return record;
    });
  }

  async upsertPriceListItem(
    priceListId: string,
    expectedVersion: number,
    input: PriceListItemInput,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(priceListId, "priceListId");
    const version = b2bVersion(expectedVersion);
    const sku = normalizeSkuValue(input.sku);
    const unitPriceCents = b2bMoney(input.unitPriceCents, "unitPriceCents");
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-price-list:${priceListId}`]);
      const priceList = await tx.priceList.findUnique({ where: { id: priceListId } });
      if (!priceList || priceList.deletedAt)
        throw new B2bError("NOT_FOUND", "Price list not found.");
      if (priceList.version !== version || priceList.status !== "DRAFT") {
        throw new B2bError("CONFLICT", "Price list items are editable only in an unchanged draft.");
      }
      const variant = (await tx.productVariant.findFirst({
        where: {
          sku,
          status: "ACTIVE",
          deletedAt: null,
          product: { status: "ACTIVE", deletedAt: null },
        },
        include: { product: { include: { brand: true, category: true, taxGroup: true } } },
      })) as VariantForProposal | null;
      if (!variant || !sellable(variant)) {
        throw new B2bError("NOT_FOUND", "Active variant not found for this SKU.");
      }
      if (unitPriceCents > variant.priceCents) {
        throw new B2bError("VALIDATION", "A B2B unit price cannot exceed the catalog unit price.");
      }
      const item = await tx.priceListItem.upsert({
        where: { priceListId_variantId: { priceListId, variantId: variant.id } },
        create: { priceListId, variantId: variant.id, unitPriceCents },
        update: { unitPriceCents },
      });
      await tx.priceList.update({
        where: { id: priceListId },
        data: { version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_ITEM_UPSERTED", "PriceListItem", item.id, {
        priceListId,
        variantId: variant.id,
        unitPriceCents: unitPriceCents.toString(),
      });
      return item;
    });
  }

  async removePriceListItem(
    priceListId: string,
    itemId: string,
    expectedVersion: number,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(priceListId, "priceListId");
    assertUuid(itemId, "itemId");
    const version = b2bVersion(expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-price-list:${priceListId}`]);
      const priceList = await tx.priceList.findUnique({ where: { id: priceListId } });
      if (!priceList || priceList.deletedAt)
        throw new B2bError("NOT_FOUND", "Price list not found.");
      if (priceList.version !== version || priceList.status !== "DRAFT") {
        throw new B2bError("CONFLICT", "Price list items are editable only in an unchanged draft.");
      }
      const removed = await tx.priceListItem.deleteMany({ where: { id: itemId, priceListId } });
      if (removed.count !== 1) throw new B2bError("NOT_FOUND", "Price list item not found.");
      await tx.priceList.update({
        where: { id: priceListId },
        data: { version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PRICE_LIST_ITEM_REMOVED", "PriceListItem", itemId, {
        priceListId,
      });
    });
  }

  async assignOrganizationPriceList(
    organizationId: string,
    expectedOrganizationVersion: number,
    priceListId: string | null,
    expectedPriceListVersion: number | null,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(organizationId, "organizationId");
    if (priceListId) assertUuid(priceListId, "priceListId");
    const organizationVersion = b2bVersion(expectedOrganizationVersion);
    const listVersion =
      expectedPriceListVersion === null ? null : b2bVersion(expectedPriceListVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [
        `crm-organization:${organizationId}`,
        ...(priceListId ? [`b2b-price-list:${priceListId}`] : []),
      ]);
      const organization = await tx.organization.findFirst({
        where: { id: organizationId, deletedAt: null },
      });
      if (!organization) throw new B2bError("NOT_FOUND", "Organization not found.");
      if (organization.version !== organizationVersion) {
        throw new B2bError("CONFLICT", "The organization changed in another session.");
      }
      if (priceListId) {
        const priceList = await tx.priceList.findUnique({ where: { id: priceListId } });
        const now = await b2bNow(tx);
        if (
          !priceList ||
          priceList.deletedAt ||
          priceList.status !== "ACTIVE" ||
          priceList.version !== listVersion ||
          (priceList.validFrom && priceList.validFrom > now) ||
          (priceList.validTo && priceList.validTo <= now)
        ) {
          throw new B2bError("CONFLICT", "The selected price list is not currently assignable.");
        }
      }
      const updated = await tx.organization.update({
        where: { id: organizationId },
        data: { priceListId, version: { increment: 1 } },
      });
      await b2bLog(
        tx,
        audit,
        "B2B_ORGANIZATION_PRICE_LIST_ASSIGNED",
        "Organization",
        organizationId,
        {
          priceListId,
          previousPriceListId: organization.priceListId,
        },
      );
      return updated;
    });
  }

  private async resolveProposalLines(
    tx: Prisma.TransactionClient,
    organizationId: string,
    inputs: readonly B2bProposalLineInput[],
    settings: CheckoutDefaults,
  ) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) {
      throw new B2bError("VALIDATION", "A proposal requires between 1 and 100 distinct items.");
    }
    const normalized = inputs.map((input) => ({ ...input, sku: normalizeSkuValue(input.sku) }));
    if (new Set(normalized.map((input) => input.sku)).size !== normalized.length) {
      throw new B2bError("VALIDATION", "Each SKU can appear only once in a proposal.");
    }
    const skuList = normalized.map((input) => input.sku).sort();
    const variants = (await tx.productVariant.findMany({
      where: { sku: { in: skuList } },
      include: { product: { include: { brand: true, category: true, taxGroup: true } } },
    })) as VariantForProposal[];
    const bySku = new Map(variants.filter(sellable).map((variant) => [variant.sku, variant]));
    if (bySku.size !== normalized.length) {
      throw new B2bError("NOT_FOUND", "One or more SKUs are not active sellable variants.");
    }
    const organization = await tx.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      include: { priceList: { include: { items: true } } },
    });
    if (!organization) throw new B2bError("NOT_FOUND", "Active organization not found.");
    const now = await b2bNow(tx);
    const list = organization.priceList;
    const usableList =
      list &&
      list.status === "ACTIVE" &&
      !list.deletedAt &&
      (!list.validFrom || list.validFrom <= now) &&
      (!list.validTo || list.validTo > now)
        ? list
        : null;
    const listPrices = new Map(
      (usableList?.items ?? []).map((item) => [item.variantId, item.unitPriceCents]),
    );
    const resolved = normalized.map((input) => {
      if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100_000) {
        throw new B2bError("VALIDATION", "Each proposal quantity must be between 1 and 100000.");
      }
      const variant = bySku.get(input.sku)!;
      const defaultPrice = listPrices.get(variant.id) ?? variant.priceCents;
      const unitPriceCents =
        input.unitPriceCents === undefined
          ? defaultPrice
          : b2bMoney(input.unitPriceCents, "unitPriceCents");
      if (unitPriceCents > variant.priceCents) {
        throw new B2bError(
          "VALIDATION",
          `The negotiated price for ${input.sku} exceeds its catalog price.`,
        );
      }
      const gross = b2bMoney(variant.priceCents * BigInt(input.quantity), "line gross");
      const lineTotalCents = b2bMoney(unitPriceCents * BigInt(input.quantity), "lineTotalCents");
      return {
        variant,
        quantity: input.quantity,
        catalogUnitPriceCents: variant.priceCents,
        unitPriceCents,
        discountCents: gross - lineTotalCents,
        lineTotalCents,
      };
    });
    if (resolved.every((item) => item.lineTotalCents === 0n)) {
      throw new B2bError("VALIDATION", "A proposal must have a positive merchandise total.");
    }
    const taxes = calculateOrderTaxes(
      resolved.map((item) => ({
        lineId: item.variant.id,
        quantity: item.quantity,
        netCents: item.lineTotalCents,
        taxGroupCode: item.variant.product.taxGroup.code,
        taxGroupName: item.variant.product.taxGroup.name,
        treatment: item.variant.product.taxGroup.treatment,
        catalogRateBps: item.variant.product.taxGroup.rateBps,
        uvtLimit: item.variant.product.taxGroup.uvtLimit,
        aboveUvtRateBps: item.variant.product.taxGroup.aboveUvtRateBps,
      })),
      {
        regime: settings.taxRegime as StoreTaxRegimeValue,
        uvtValueCents: settings.uvtValueCents,
        uvtYear: settings.uvtYear,
      },
    ).lines;
    return { resolved, taxes, priceList: usableList };
  }

  async createProposal(input: CreateB2bProposalInput) {
    assertUuid(input.opportunityId, "opportunityId");
    const expectedVersion = b2bVersion(input.expectedVersion);
    const expiresAt = b2bDate(input.expiresAt, "expiresAt");
    const commercialNotes = b2bOptionalText(input.commercialNotes, "commercialNotes", 2000);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, input.audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-opportunity:${input.opportunityId}`]);
      const opportunities = await tx.$queryRaw<
        Array<{ id: string; version: number; status: string }>
      >`
        SELECT "id", "version", "status" FROM "Opportunity" WHERE "id" = ${input.opportunityId}::uuid FOR UPDATE
      `;
      const opportunity = opportunities[0];
      if (!opportunity) throw new B2bError("NOT_FOUND", "Opportunity not found.");
      if (
        opportunity.version !== expectedVersion ||
        ["WON", "LOST", "CANCELLED"].includes(opportunity.status)
      ) {
        throw new B2bError("CONFLICT", "The opportunity changed or is closed.");
      }
      const record = await tx.opportunity.findUniqueOrThrow({
        where: { id: input.opportunityId },
        select: { organizationId: true },
      });
      const settings = await this.lockedSettings(tx);
      const now = await b2bNow(tx);
      try {
        assertB2bExpiry(expiresAt, now);
      } catch (error) {
        throw new B2bError(
          "VALIDATION",
          error instanceof Error ? error.message : "Invalid expiry.",
        );
      }
      const { resolved, taxes, priceList } = await this.resolveProposalLines(
        tx,
        record.organizationId,
        input.items,
        settings,
      );
      const latest = await tx.opportunityProposal.findFirst({
        where: { opportunityId: input.opportunityId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      const subtotalCents = resolved.reduce(
        (sum, item) => sum + item.catalogUnitPriceCents * BigInt(item.quantity),
        0n,
      );
      const discountCents = resolved.reduce((sum, item) => sum + item.discountCents, 0n);
      const taxCents = taxes.reduce((sum, item) => sum + item.taxCents, 0n);
      const merchandiseCents = resolved.reduce((sum, item) => sum + item.lineTotalCents, 0n);
      const totalCents = b2bMoney(
        merchandiseCents + taxCents + settings.standardShippingCents,
        "totalCents",
      );
      b2bMoney(subtotalCents, "subtotalCents");
      b2bMoney(discountCents, "discountCents");
      const itemData = resolved.map((item) => {
        const tax = taxes.find((candidate) => candidate.lineId === item.variant.id)!;
        return {
          variantId: item.variant.id,
          quantity: item.quantity,
          titleSnapshot: item.variant.product.name,
          productSlugSnapshot: item.variant.product.slug,
          skuSnapshot: item.variant.sku,
          catalogUnitPriceCents: item.catalogUnitPriceCents,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          lineTotalCents: item.lineTotalCents,
          taxGroupCode: tax.taxGroupCode,
          taxGroupName: tax.taxGroupName,
          treatment: tax.treatment,
          taxRule: tax.rule,
          catalogRateBps: tax.catalogRateBps,
          appliedRateBps: tax.appliedRateBps,
          uvtLimit: tax.uvtLimit,
          unitValueCents: tax.unitValueCents,
          taxableBaseCents: tax.taxableBaseCents,
          taxCents: tax.taxCents,
        };
      });
      const hashSource: ProposalContentSource = {
        opportunityId: input.opportunityId,
        version,
        priceListId: priceList?.id ?? null,
        priceListCodeSnapshot: priceList?.code ?? null,
        priceListVersionSnapshot: priceList?.version ?? null,
        currency: "COP",
        subtotalCents,
        discountCents,
        taxCents,
        shippingCents: settings.standardShippingCents,
        totalCents,
        taxRegime: settings.taxRegime,
        uvtValueCents: settings.uvtValueCents,
        uvtYear: settings.uvtYear,
        deliveryPromiseDays: settings.deliveryPromiseDays,
        reservationMinutes: settings.reservationMinutes,
        commercialNotes,
        expiresAt,
        items: itemData,
      };
      const proposalId = randomUUID();
      await tx.opportunityProposal.updateMany({
        where: { opportunityId: input.opportunityId, status: "DRAFT" },
        data: { status: "SUPERSEDED" },
      });
      await tx.opportunityProposal.create({
        data: {
          id: proposalId,
          opportunityId: input.opportunityId,
          version,
          contentHash: proposalContentHash(hashSource),
          priceListId: priceList?.id ?? null,
          priceListCodeSnapshot: priceList?.code ?? null,
          priceListVersionSnapshot: priceList?.version ?? null,
          subtotalCents,
          discountCents,
          taxCents,
          shippingCents: settings.standardShippingCents,
          totalCents,
          taxRegime: settings.taxRegime,
          uvtValueCents: settings.uvtValueCents,
          uvtYear: settings.uvtYear,
          deliveryPromiseDays: settings.deliveryPromiseDays,
          reservationMinutes: settings.reservationMinutes,
          commercialNotes,
          expiresAt,
          createdByAdminUserId: input.audit.actorAdminUserId,
          items: { create: itemData },
        },
        include: { items: true },
      });
      await tx.opportunity.update({
        where: { id: input.opportunityId },
        data: {
          status:
            opportunity.status === "NEW"
              ? "QUALIFYING"
              : (opportunity.status as "QUALIFYING" | "PROPOSAL_SENT"),
          version: { increment: 1 },
        },
      });
      const proposal = await tx.opportunityProposal.findUniqueOrThrow({
        where: { id: proposalId },
        include: { items: true },
      });
      assertProposalIntegrity(proposal);
      await b2bLog(
        tx,
        input.audit,
        "B2B_PROPOSAL_VERSION_CREATED",
        "OpportunityProposal",
        proposalId,
        {
          opportunityId: input.opportunityId,
          version,
          totalCents: totalCents.toString(),
        },
      );
      return proposal;
    });
  }

  async issueProposal(
    proposalId: string,
    expectedOpportunityVersion: number,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(proposalId, "proposalId");
    const expectedVersion = b2bVersion(expectedOpportunityVersion);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      const initial = await tx.opportunityProposal.findUnique({
        where: { id: proposalId },
        select: { opportunityId: true },
      });
      if (!initial) throw new B2bError("NOT_FOUND", "Proposal not found.");
      await acquireOperationLocks(tx, [`b2b-opportunity:${initial.opportunityId}`]);
      const opportunities = await tx.$queryRaw<
        Array<{ id: string; version: number; status: string; currentVersion: number }>
      >`
        SELECT "id", "version", "status", "currentVersion" FROM "Opportunity" WHERE "id" = ${initial.opportunityId}::uuid FOR UPDATE
      `;
      const opportunity = opportunities[0];
      if (
        !opportunity ||
        opportunity.version !== expectedVersion ||
        ["WON", "LOST", "CANCELLED"].includes(opportunity.status)
      ) {
        throw new B2bError("CONFLICT", "The opportunity changed or is closed.");
      }
      const proposal = await tx.opportunityProposal.findUniqueOrThrow({
        where: { id: proposalId },
        include: { items: true },
      });
      assertProposalIntegrity(proposal);
      if (proposal.status !== "DRAFT")
        throw new B2bError("CONFLICT", "Only a draft can be issued.");
      const latest = await tx.opportunityProposal.findFirst({
        where: { opportunityId: proposal.opportunityId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      if (latest?.version !== proposal.version) {
        throw new B2bError("CONFLICT", "Only the latest proposal draft can be issued.");
      }
      const now = await b2bNow(tx);
      if (proposal.expiresAt <= now)
        throw new B2bError("EXPIRED", "Create a new version with a future expiry.");
      const previous = await tx.opportunityProposal.findMany({
        where: { opportunityId: proposal.opportunityId, status: { in: ["SENT", "EXPIRED"] } },
        select: { id: true, cartId: true },
      });
      for (const old of previous) {
        if (old.cartId)
          await tx.cart.updateMany({
            where: { id: old.cartId, status: "ACTIVE" },
            data: { status: "CANCELLED" },
          });
        await tx.opportunityProposal.update({
          where: { id: old.id },
          data: { status: "SUPERSEDED" },
        });
      }
      const cart = await tx.cart.create({
        data: {
          accessTokenHash: randomBytes(32),
          kind: "B2B",
          subtotalCents: proposal.subtotalCents,
          wholesaleDiscountCents: proposal.discountCents,
          totalCents: proposal.subtotalCents - proposal.discountCents,
          itemCount: proposal.items.length,
          priceRevalidatedAt: now,
          expiresAt: proposal.expiresAt,
          items: {
            create: proposal.items.map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
              productNameSnapshot: item.titleSnapshot,
              productSlugSnapshot: item.productSlugSnapshot,
              skuSnapshot: item.skuSnapshot,
              unitPriceCents: item.catalogUnitPriceCents,
              wholesaleDiscountCents: item.discountCents,
              lineTotalCents: item.lineTotalCents,
            })),
          },
        },
      });
      await tx.opportunityProposal.update({
        where: { id: proposal.id },
        data: { status: "SENT", publicTokenHash: tokenHash, cartId: cart.id, issuedAt: now },
      });
      const issued = await tx.opportunityProposal.findUniqueOrThrow({
        where: { id: proposal.id },
        include: { items: true },
      });
      await tx.opportunity.update({
        where: { id: proposal.opportunityId },
        data: {
          status: "PROPOSAL_SENT",
          currentVersion: proposal.version,
          version: { increment: 1 },
        },
      });
      const cartSnapshot = await new CartService(tx).getById(cart.id);
      if (!cartSnapshot.canContinue) {
        throw new B2bError("CONFLICT", "Resolve proposal availability issues before issuing it.");
      }
      await b2bLog(tx, audit, "B2B_PROPOSAL_ISSUED", "OpportunityProposal", proposal.id, {
        opportunityId: proposal.opportunityId,
        version: proposal.version,
        cartId: cart.id,
        expiresAt: proposal.expiresAt.toISOString(),
      });
      return { proposal: issued, token, expiresAt: proposal.expiresAt };
    });
  }

  async cancelProposal(
    proposalId: string,
    expectedOpportunityVersion: number,
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(proposalId, "proposalId");
    const expectedVersion = b2bVersion(expectedOpportunityVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      const initial = await tx.opportunityProposal.findUnique({ where: { id: proposalId } });
      if (!initial) throw new B2bError("NOT_FOUND", "Proposal not found.");
      await acquireOperationLocks(tx, [`b2b-opportunity:${initial.opportunityId}`]);
      const opportunities = await tx.$queryRaw<
        Array<{ id: string; version: number; status: string; currentVersion: number }>
      >`
        SELECT "id", "version", "status", "currentVersion" FROM "Opportunity" WHERE "id" = ${initial.opportunityId}::uuid FOR UPDATE
      `;
      const opportunity = opportunities[0];
      if (
        !opportunity ||
        opportunity.version !== expectedVersion ||
        ["WON", "LOST", "CANCELLED"].includes(opportunity.status)
      ) {
        throw new B2bError("CONFLICT", "The opportunity changed or is closed.");
      }
      const proposal = await tx.opportunityProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
      if (!["DRAFT", "SENT", "EXPIRED"].includes(proposal.status)) {
        throw new B2bError("CONFLICT", "This proposal cannot be cancelled.");
      }
      if (proposal.cartId)
        await tx.cart.updateMany({
          where: { id: proposal.cartId, status: "ACTIVE" },
          data: { status: "CANCELLED" },
        });
      await tx.opportunityProposal.update({
        where: { id: proposalId },
        data: { status: "CANCELLED" },
      });
      const nextStatus =
        opportunity.status === "PROPOSAL_SENT" &&
        proposal.status === "SENT" &&
        opportunity.currentVersion === proposal.version
          ? "QUALIFYING"
          : (opportunity.status as "NEW" | "QUALIFYING" | "PROPOSAL_SENT");
      await tx.opportunity.update({
        where: { id: opportunity.id },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_PROPOSAL_CANCELLED", "OpportunityProposal", proposalId);
    });
  }

  async closeOpportunity(
    opportunityId: string,
    expectedVersion: number,
    status: "LOST" | "CANCELLED",
    audit: CreateB2bProposalInput["audit"],
  ) {
    assertUuid(opportunityId, "opportunityId");
    const version = b2bVersion(expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await b2bActor(tx, audit, "b2b:write");
      await acquireOperationLocks(tx, [`b2b-opportunity:${opportunityId}`]);
      const opportunities = await tx.$queryRaw<
        Array<{ id: string; version: number; status: string }>
      >`
        SELECT "id", "version", "status" FROM "Opportunity" WHERE "id" = ${opportunityId}::uuid FOR UPDATE
      `;
      const opportunity = opportunities[0];
      if (!opportunity) throw new B2bError("NOT_FOUND", "Opportunity not found.");
      if (
        opportunity.version !== version ||
        ["WON", "LOST", "CANCELLED"].includes(opportunity.status)
      ) {
        throw new B2bError("CONFLICT", "The opportunity changed or is already closed.");
      }
      const proposals = await tx.opportunityProposal.findMany({
        where: { opportunityId, status: { in: ["DRAFT", "SENT", "EXPIRED"] } },
      });
      for (const proposal of proposals) {
        if (proposal.cartId)
          await tx.cart.updateMany({
            where: { id: proposal.cartId, status: "ACTIVE" },
            data: { status: "CANCELLED" },
          });
        await tx.opportunityProposal.update({
          where: { id: proposal.id },
          data: { status: "CANCELLED" },
        });
      }
      await tx.opportunity.update({
        where: { id: opportunityId },
        data: { status, version: { increment: 1 } },
      });
      await b2bLog(tx, audit, "B2B_OPPORTUNITY_CLOSED", "Opportunity", opportunityId, { status });
    });
  }

  async getPublicProposal(tokenHash: Uint8Array): Promise<PublicB2bProposal | null> {
    const hash = b2bHash(tokenHash, "tokenHash");
    const record = await this.db.opportunityProposal.findFirst({
      where: { publicTokenHash: hash },
      include: {
        opportunity: { include: { organization: true, contact: true } },
        items: { orderBy: [{ skuSnapshot: "asc" }, { id: "asc" }] },
      },
    });
    if (!record) return null;
    assertProposalIntegrity(record);
    const now = await b2bNow(this.db);
    const unavailableReason = publicUnavailableReason(
      record,
      record.opportunity.currentVersion,
      now,
    );
    const organization = record.opportunity.organization;
    const contact = record.opportunity.contact;
    const redacted = record.anonymizedAt !== null;
    if (
      !redacted &&
      (!organization.taxId ||
        !contact.givenName ||
        !contact.familyName ||
        !contact.email ||
        !contact.phoneE164)
    ) {
      throw new B2bError("CONFLICT", "Proposal contact snapshots are incomplete.");
    }
    return {
      id: record.id,
      opportunityId: record.opportunityId,
      version: record.version,
      status: record.status,
      available: record.status === "SENT" && unavailableReason === null,
      unavailableReason,
      organizationName: redacted ? "Organización anonimizada" : organization.legalName,
      contact: {
        givenName: redacted ? "" : contact.givenName!,
        familyName: redacted ? "" : contact.familyName!,
        email: redacted ? "" : contact.email!,
        phoneE164: redacted ? "" : contact.phoneE164!,
        documentNumber: redacted ? "" : organization.taxId!,
      },
      currency: "COP",
      taxRegime: record.taxRegime,
      commercialNotes: record.commercialNotes,
      expiresAt: record.expiresAt.toISOString(),
      orderId: record.orderId,
      cartId: record.cartId,
      subtotalCents: record.subtotalCents.toString(),
      discountCents: record.discountCents.toString(),
      taxCents: record.taxCents.toString(),
      shippingCents: record.shippingCents.toString(),
      totalCents: record.totalCents.toString(),
      items: record.items.map((item) => ({
        variantId: item.variantId,
        sku: item.skuSnapshot,
        title: item.titleSnapshot,
        productSlug: item.productSlugSnapshot,
        quantity: item.quantity,
        catalogUnitPriceCents: item.catalogUnitPriceCents.toString(),
        unitPriceCents: item.unitPriceCents.toString(),
        discountCents: item.discountCents.toString(),
        lineTotalCents: item.lineTotalCents.toString(),
        taxCents: item.taxCents.toString(),
      })),
    };
  }

  async expireDueProposals(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new B2bError("VALIDATION", "Expiry batch limit must be between 1 and 500.");
    }
    const candidates = await this.db.opportunityProposal.findMany({
      where: { status: "SENT", expiresAt: { lte: await b2bNow(this.db) } },
      select: { id: true, opportunityId: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    let expired = 0;
    for (const candidate of candidates) {
      const changed = await inInventoryTransaction(this.db, async (tx) => {
        await acquireOperationLocks(tx, [`b2b-opportunity:${candidate.opportunityId}`]);
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Opportunity" WHERE "id" = ${candidate.opportunityId}::uuid FOR UPDATE
        `;
        const rows = await tx.$queryRaw<
          Array<{ id: string; opportunityId: string; cartId: string | null; version: number }>
        >`
          SELECT "id", "opportunityId", "cartId", "version" FROM "OpportunityProposal"
          WHERE "id" = ${candidate.id}::uuid AND "status" = 'SENT' AND "expiresAt" <= CURRENT_TIMESTAMP
          FOR UPDATE
        `;
        const proposal = rows[0];
        if (!proposal) return false;
        if (proposal.cartId)
          await tx.cart.updateMany({
            where: { id: proposal.cartId, status: "ACTIVE" },
            data: { status: "CANCELLED" },
          });
        await tx.opportunityProposal.update({
          where: { id: proposal.id },
          data: { status: "EXPIRED" },
        });
        await tx.opportunity.updateMany({
          where: {
            id: proposal.opportunityId,
            status: "PROPOSAL_SENT",
            currentVersion: proposal.version,
          },
          data: { status: "QUALIFYING", version: { increment: 1 } },
        });
        return true;
      });
      if (changed) expired += 1;
    }
    return expired;
  }
}
