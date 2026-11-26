import {
  adminRoles,
  contactPairKey,
  deriveContactVerificationLevel,
  hasAdminPermission,
  isAdminRole,
  normalizeContactIdentity,
  normalizeContactPhone,
  normalizeEmail,
  type ContactIdentityKindValue,
} from "@mundonettech/core";

import type {
  Contact,
  ContactIdentity,
  ContactVerificationLevel,
  Customer,
  Organization,
  Prisma,
  PrismaClient,
} from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  inInventoryTransaction,
} from "./inventory-shared.js";
import { databaseNow } from "./primitives.js";
import { maskCrmContact, maskCrmIdentity, maskCrmOrganization } from "./crm-presenters.js";
import {
  CrmError,
  crmActor,
  crmIdentityHash,
  crmLimit,
  crmLog,
  crmNow,
  crmOptionalText,
  crmRetentionMonths,
  crmRetentionReviewAt,
  crmSelfDealing,
  crmSource,
  crmText,
  crmVersion,
  normalizeCrmContactInput,
  normalizeCrmOrganizationInput,
  retryableLockDivergenceError,
  type CrmAudit,
  type CrmContactInput,
  type CrmContactUpdateInput,
  type CrmOrganizationInput,
  type CrmOrganizationUpdateInput,
} from "./crm-shared.js";

const verificationRank: Readonly<Record<ContactVerificationLevel, number>> = {
  UNVERIFIED: 0,
  SINGLE_CHANNEL_VERIFIED: 1,
  DUAL_CHANNEL_VERIFIED: 2,
  IDENTITY_VERIFIED: 3,
};

export class CrmService {
  private readonly retentionMonths: number;

  constructor(
    private readonly db: PrismaClient,
    options: { readonly retentionMonths?: number } = {},
  ) {
    this.retentionMonths = crmRetentionMonths(options.retentionMonths ?? 24);
  }

  private async touchContact(tx: Prisma.TransactionClient, contactId: string, now: Date) {
    const retentionReviewAt = await crmRetentionReviewAt(tx, this.retentionMonths);
    const updated = await tx.contact.updateMany({
      where: { id: contactId, status: "ACTIVE", deletedAt: null },
      data: {
        lastActivityAt: now,
        retentionReviewAt,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new CrmError("CONFLICT", "The contact is no longer active.");
    return retentionReviewAt;
  }

  private async assertOrganization(tx: Prisma.TransactionClient, organizationId: string | null) {
    if (!organizationId) return;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization"
      WHERE "id" = ${organizationId}::uuid AND "deletedAt" IS NULL
      FOR SHARE
    `;
    if (!rows[0]) throw new CrmError("NOT_FOUND", "Active organization not found.");
  }

  private async upsertIdentity(
    tx: Prisma.TransactionClient,
    contactId: string,
    kind: ContactIdentityKindValue,
    value: string,
    verifiedAt: Date | null,
  ): Promise<ContactIdentity> {
    const normalizedValue = normalizeContactIdentity(kind, value);
    const existing = await tx.contactIdentity.findUnique({
      where: { contactId_kind_normalizedValue: { contactId, kind, normalizedValue } },
    });
    if (existing) {
      return tx.contactIdentity.update({
        where: { id: existing.id },
        data: { retiredAt: null, verifiedAt: existing.verifiedAt ?? verifiedAt },
      });
    }
    return tx.contactIdentity.create({
      data: {
        contactId,
        kind,
        normalizedValue,
        valueHash: crmIdentityHash(kind, normalizedValue),
        verifiedAt,
      },
    });
  }

  private async retireIdentity(
    tx: Prisma.TransactionClient,
    contactId: string,
    kind: ContactIdentityKindValue,
    normalizedValue: string,
    exceptValue: string | null,
    now: Date,
  ) {
    if (exceptValue === normalizedValue) return;
    await tx.$executeRaw`
      WITH RECURSIVE lineage AS (
        SELECT "id" FROM "Contact" WHERE "id" = ${contactId}::uuid
        UNION
        SELECT contact."id" FROM "Contact" contact
        JOIN lineage parent ON contact."mergedIntoContactId" = parent."id"
      )
      UPDATE "ContactIdentity"
      SET "retiredAt" = ${now}
      WHERE "contactId" IN (SELECT "id" FROM lineage)
        AND "kind" = ${kind}::"ContactIdentityKind"
        AND "normalizedValue" = ${normalizedValue}
        AND "retiredAt" IS NULL
    `;
  }

  private async verificationLevel(
    tx: Prisma.TransactionClient,
    contactId: string,
    activeEmail: string | null,
    activePhone: string | null,
  ): Promise<ContactVerificationLevel> {
    const identities = await tx.$queryRaw<
      Array<{
        kind: ContactIdentityKindValue;
        normalizedValue: string;
        verifiedAt: Date | null;
      }>
    >`
      WITH RECURSIVE lineage AS (
        SELECT "id" FROM "Contact" WHERE "id" = ${contactId}::uuid
        UNION
        SELECT contact."id" FROM "Contact" contact
        JOIN lineage parent ON contact."mergedIntoContactId" = parent."id"
      )
      SELECT identity."kind", identity."normalizedValue", identity."verifiedAt"
      FROM "ContactIdentity" identity
      JOIN lineage ON lineage."id" = identity."contactId"
      WHERE identity."retiredAt" IS NULL
    `;
    return deriveContactVerificationLevel({
      emailVerified:
        activeEmail !== null &&
        identities.some(
          (item) =>
            item.kind === "EMAIL" &&
            item.normalizedValue === activeEmail &&
            item.verifiedAt !== null,
        ),
      phoneVerified:
        activePhone !== null &&
        identities.some(
          (item) =>
            item.kind === "PHONE" &&
            item.normalizedValue === activePhone &&
            item.verifiedAt !== null,
        ),
      identityVerified: identities.some(
        (item) => item.kind === "DOCUMENT" && item.verifiedAt !== null,
      ),
    });
  }

  private async assertUniqueOrganizationTaxId(
    tx: Prisma.TransactionClient,
    taxId: string | null,
    excludeOrganizationId?: string,
  ) {
    if (!taxId) return;
    const duplicate = await tx.organization.findFirst({
      where: {
        taxId,
        deletedAt: null,
        ...(excludeOrganizationId ? { id: { not: excludeOrganizationId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new CrmError("CONFLICT", "An active organization already uses this tax identifier.");
    }
  }

  async createOrganization(input: CrmOrganizationInput, audit: CrmAudit) {
    const values = normalizeCrmOrganizationInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      if (values.taxId) {
        await acquireOperationLocks(tx, [`crm-org-tax:${values.taxId}`]);
        await this.assertUniqueOrganizationTaxId(tx, values.taxId);
      }
      const organization = await tx.organization.create({ data: values });
      await crmLog(tx, audit, "CRM_ORGANIZATION_CREATED", "Organization", organization.id, {
        version: organization.version,
      });
      return organization;
    });
  }

  async updateOrganization(input: CrmOrganizationUpdateInput, audit: CrmAudit) {
    assertUuid(input.organizationId, "organizationId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const preserveTaxId = input.taxId === undefined;
    const values = normalizeCrmOrganizationInput({
      legalName: input.legalName,
      commercialName: input.commercialName ?? null,
      taxId: preserveTaxId ? null : input.taxId,
    });
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      const lockKeys = [`crm-organization:${input.organizationId}`];
      if (!preserveTaxId && values.taxId) lockKeys.push(`crm-org-tax:${values.taxId}`);
      await acquireOperationLocks(tx, lockKeys);
      const rows = await tx.$queryRaw<
        Array<{ id: string; version: number; taxId: string | null; deletedAt: Date | null }>
      >`
        SELECT "id", "version", "taxId", "deletedAt" FROM "Organization" WHERE "id" = ${input.organizationId}::uuid FOR UPDATE
      `;
      const current = rows[0];
      if (!current || current.deletedAt) throw new CrmError("NOT_FOUND", "Organization not found.");
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The organization changed in another session.");
      }
      const resolvedTaxId = preserveTaxId ? current.taxId : values.taxId;
      if (!preserveTaxId && resolvedTaxId) {
        await this.assertUniqueOrganizationTaxId(tx, resolvedTaxId, current.id);
      }
      const organization = await tx.organization.update({
        where: { id: current.id },
        data: {
          legalName: values.legalName,
          commercialName: values.commercialName,
          taxId: resolvedTaxId,
          version: { increment: 1 },
        },
      });
      await crmLog(tx, audit, "CRM_ORGANIZATION_UPDATED", "Organization", organization.id, {
        previousVersion: expectedVersion,
        version: organization.version,
      });
      return organization;
    });
  }

  async archiveOrganization(
    input: { readonly organizationId: string; readonly expectedVersion: number },
    audit: CrmAudit,
  ) {
    assertUuid(input.organizationId, "organizationId");
    const expectedVersion = crmVersion(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`crm-organization:${input.organizationId}`]);
      const orgRows = await tx.$queryRaw<Organization[]>`
        SELECT * FROM "Organization"
        WHERE "id" = ${input.organizationId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      const current = orgRows[0];
      if (!current) throw new CrmError("NOT_FOUND", "Organization not found.");
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The organization changed in another session.");
      }
      const activeContacts = await tx.contact.count({
        where: { organizationId: current.id, status: "ACTIVE", deletedAt: null },
      });
      if (activeContacts > 0) {
        throw new CrmError(
          "CONFLICT",
          "Reassign active contacts before archiving the organization.",
        );
      }
      const activeOpportunities = await tx.opportunity.count({
        where: {
          organizationId: current.id,
          status: { in: ["NEW", "QUALIFYING", "PROPOSAL_SENT"] },
        },
      });
      if (activeOpportunities > 0) {
        throw new CrmError(
          "CONFLICT",
          "Close active B2B opportunities before archiving the organization.",
        );
      }
      const now = await crmNow(tx);
      const organization = await tx.organization.update({
        where: { id: current.id },
        data: { deletedAt: now, version: { increment: 1 } },
      });
      await crmLog(tx, audit, "CRM_ORGANIZATION_ARCHIVED", "Organization", organization.id, {
        previousVersion: expectedVersion,
      });
      return organization;
    });
  }

  async listOrganizations() {
    const organizations = await this.db.organization.findMany({
      where: { deletedAt: null },
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      take: 500,
    });
    return organizations.map((organization) => maskCrmOrganization(organization)!);
  }

  async createContact(input: CrmContactInput, audit: CrmAudit) {
    const values = normalizeCrmContactInput(input);
    if (values.customerId) {
      throw new CrmError("VALIDATION", "Use customer synchronization to link a Customer identity.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      if (values.organizationId) {
        await acquireOperationLocks(tx, [`crm-organization:${values.organizationId}`]);
      }
      await this.assertOrganization(tx, values.organizationId);
      const [now, retentionReviewAt] = await Promise.all([
        crmNow(tx),
        crmRetentionReviewAt(tx, this.retentionMonths),
      ]);
      const contact = await tx.contact.create({
        data: {
          organizationId: values.organizationId,
          givenName: values.givenName,
          familyName: values.familyName,
          email: values.email,
          phoneE164: values.phoneE164,
          source: values.source,
          retentionReviewAt,
          lastActivityAt: now,
        },
      });
      if (values.email) await this.upsertIdentity(tx, contact.id, "EMAIL", values.email, null);
      if (values.phoneE164)
        await this.upsertIdentity(tx, contact.id, "PHONE", values.phoneE164, null);
      await crmLog(tx, audit, "CRM_CONTACT_CREATED", "Contact", contact.id, {
        source: contact.source,
        organizationId: contact.organizationId,
      });
      return contact;
    });
  }

  async syncCustomerContactInTransaction(
    tx: Prisma.TransactionClient,
    customerId: string,
    options: { readonly preferredContactId?: string } = {},
  ): Promise<Contact> {
    assertUuid(customerId, "customerId");
    await acquireOperationLocks(tx, [`crm-customer:${customerId}`]);
    const customers = await tx.$queryRaw<
      Customer[]
    >`SELECT * FROM "Customer" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
    const customer = customers[0];
    if (!customer || customer.status === "ANONYMIZED" || customer.deletedAt) {
      throw new CrmError("NOT_FOUND", "Customer eligible for CRM synchronization not found.");
    }
    if (!customer.givenName || !customer.familyName) {
      throw new CrmError(
        "VALIDATION",
        "Customer names must be complete before CRM synchronization.",
      );
    }
    const [now, retentionReviewAt] = await Promise.all([
      crmNow(tx),
      crmRetentionReviewAt(tx, this.retentionMonths),
    ]);
    const normalizedEmail = normalizeEmail(customer.email);
    const emailVerifiedAt = customer.authUserId && customer.status === "ACTIVE" ? now : null;
    let existing: Contact | null = await tx.contact.findFirst({
      where: { customerId, status: "ACTIVE", deletedAt: null },
    });
    let fromPreferred = false;
    if (!existing && options.preferredContactId) {
      assertUuid(options.preferredContactId, "preferredContactId");
      const preferred = await tx.contact.findFirst({
        where: {
          id: options.preferredContactId,
          status: "ACTIVE",
          deletedAt: null,
          email: normalizedEmail,
        },
      });
      if (!preferred || (preferred.customerId !== null && preferred.customerId !== customerId)) {
        throw new CrmError("CONFLICT", "The B2B contact cannot be linked to this customer.");
      }
      existing = preferred;
      fromPreferred = true;
    }
    let activeTarget: Contact | null = null;
    if (existing) {
      await acquireOperationLocks(tx, [`crm-contact:${existing.id}`]);
      const lockedRows = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
      let locked = lockedRows[0] ?? null;
      const visited = new Set<string>([existing.id]);
      while (locked && locked.status === "MERGED" && locked.mergedIntoContactId) {
        const nextId = locked.mergedIntoContactId;
        if (visited.has(nextId) || visited.size >= 20) {
          locked = null;
          break;
        }
        if (compareStrings(locked.id, nextId) >= 0) {
          throw retryableLockDivergenceError("The contact was merged concurrently.");
        }
        visited.add(nextId);
        await acquireOperationLocks(tx, [`crm-contact:${nextId}`]);
        const targetRows = await tx.$queryRaw<
          Contact[]
        >`SELECT * FROM "Contact" WHERE "id" = ${nextId}::uuid FOR UPDATE`;
        locked = targetRows[0] ?? null;
      }
      if (locked && locked.status === "ACTIVE" && locked.deletedAt === null) {
        if (
          (locked.customerId !== null && locked.customerId !== customerId) ||
          (fromPreferred && locked.email !== normalizedEmail)
        ) {
          throw new CrmError("CONFLICT", "The B2B contact cannot be linked to this customer.");
        }
        activeTarget = locked;
      } else if (fromPreferred) {
        throw new CrmError("CONFLICT", "The B2B contact cannot be linked to this customer.");
      }
    }
    const effectivePhone = customer.phoneE164
      ? normalizeContactPhone(customer.phoneE164)
      : (activeTarget?.phoneE164 ?? null);
    if (!activeTarget) {
      const initialLevel: ContactVerificationLevel = emailVerifiedAt
        ? "SINGLE_CHANNEL_VERIFIED"
        : "UNVERIFIED";
      const created = await tx.contact.create({
        data: {
          customerId,
          givenName: customer.givenName,
          familyName: customer.familyName,
          email: normalizedEmail,
          phoneE164: effectivePhone,
          verificationLevel: initialLevel,
          source: "checkout",
          retentionReviewAt,
          lastActivityAt: now,
        },
      });
      await this.upsertIdentity(tx, created.id, "EMAIL", normalizedEmail, emailVerifiedAt);
      if (effectivePhone) {
        await this.upsertIdentity(tx, created.id, "PHONE", effectivePhone, null);
      }
      return created;
    }
    await this.upsertIdentity(tx, activeTarget.id, "EMAIL", normalizedEmail, emailVerifiedAt);
    if (activeTarget.email && activeTarget.email !== normalizedEmail) {
      await this.retireIdentity(
        tx,
        activeTarget.id,
        "EMAIL",
        activeTarget.email,
        normalizedEmail,
        now,
      );
    }
    if (effectivePhone) {
      await this.upsertIdentity(tx, activeTarget.id, "PHONE", effectivePhone, null);
    }
    if (activeTarget.phoneE164 && activeTarget.phoneE164 !== effectivePhone) {
      await this.retireIdentity(
        tx,
        activeTarget.id,
        "PHONE",
        activeTarget.phoneE164,
        effectivePhone,
        now,
      );
    }
    const verificationLevel = await this.verificationLevel(
      tx,
      activeTarget.id,
      normalizedEmail,
      effectivePhone,
    );
    return tx.contact.update({
      where: { id: activeTarget.id },
      data: {
        customerId,
        givenName: customer.givenName,
        familyName: customer.familyName,
        email: normalizedEmail,
        phoneE164: effectivePhone,
        verificationLevel,
        lastActivityAt: now,
        retentionReviewAt,
        version: { increment: 1 },
      },
    });
  }

  async syncCustomerContact(customerId: string): Promise<Contact> {
    return inInventoryTransaction(this.db, async (tx) =>
      this.syncCustomerContactInTransaction(tx, customerId),
    );
  }

  async updateContact(input: CrmContactUpdateInput, audit: CrmAudit) {
    assertUuid(input.contactId, "contactId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const values = normalizeCrmContactInput({
      ...input,
      source: input.source ?? "admin-crm",
    });
    const explicitSource = input.source !== undefined ? crmSource(input.source) : null;
    if (values.customerId) throw new CrmError("VALIDATION", "Customer links are system managed.");
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      const peek = await tx.contact.findUnique({
        where: { id: input.contactId },
        select: { organizationId: true },
      });
      const orgLocks = [
        ...new Set(
          [peek?.organizationId ?? null, values.organizationId].filter(
            (id): id is string => id !== null,
          ),
        ),
      ].sort();
      if (orgLocks.length > 0) {
        await acquireOperationLocks(
          tx,
          orgLocks.map((id) => `crm-organization:${id}`),
        );
      }
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const rows = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" = ${input.contactId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current || current.status !== "ACTIVE" || current.deletedAt) {
        throw new CrmError("NOT_FOUND", "Active contact not found.");
      }
      if ((peek?.organizationId ?? null) !== current.organizationId) {
        throw retryableLockDivergenceError("The contact organization changed concurrently.");
      }
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The contact changed in another session.");
      }
      if (values.organizationId !== current.organizationId && current.organizationId !== null) {
        const linkedOpportunity = await tx.opportunity.findFirst({
          where: { contactId: current.id, organizationId: current.organizationId },
          select: { id: true },
        });
        if (linkedOpportunity) {
          throw new CrmError(
            "CONFLICT",
            "Cannot change organization while B2B opportunities are linked to this contact.",
          );
        }
      }
      await this.assertOrganization(tx, values.organizationId);
      const now = await crmNow(tx);
      if (values.email) await this.upsertIdentity(tx, current.id, "EMAIL", values.email, null);
      if (values.phoneE164)
        await this.upsertIdentity(tx, current.id, "PHONE", values.phoneE164, null);
      if (current.email)
        await this.retireIdentity(tx, current.id, "EMAIL", current.email, values.email, now);
      if (current.phoneE164)
        await this.retireIdentity(
          tx,
          current.id,
          "PHONE",
          current.phoneE164,
          values.phoneE164,
          now,
        );
      const verificationLevel = await this.verificationLevel(
        tx,
        current.id,
        values.email,
        values.phoneE164,
      );
      const updated = await tx.contact.update({
        where: { id: current.id },
        data: {
          organizationId: values.organizationId,
          givenName: values.givenName,
          familyName: values.familyName,
          email: values.email,
          phoneE164: values.phoneE164,
          verificationLevel,
          source: explicitSource ?? current.source,
          lastActivityAt: now,
          retentionReviewAt: await crmRetentionReviewAt(tx, this.retentionMonths),
          version: { increment: 1 },
        },
      });
      await crmLog(tx, audit, "CRM_CONTACT_UPDATED", "Contact", updated.id, {
        previousVersion: expectedVersion,
        version: updated.version,
      });
      return updated;
    });
  }

  async verifyContact(
    input: {
      readonly contactId: string;
      readonly expectedVersion: number;
      readonly level: "SINGLE_CHANNEL_VERIFIED" | "DUAL_CHANNEL_VERIFIED" | "IDENTITY_VERIFIED";
      readonly channel?: "EMAIL" | "PHONE";
      readonly document?: string;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.contactId, "contactId");
    const expectedVersion = crmVersion(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const rows = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" = ${input.contactId}::uuid FOR UPDATE`;
      const contact = rows[0];
      if (!contact || contact.status !== "ACTIVE" || contact.deletedAt) {
        throw new CrmError("NOT_FOUND", "Active contact not found.");
      }
      if (contact.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The contact changed in another session.");
      }
      const now = await crmNow(tx);
      if (
        !["SINGLE_CHANNEL_VERIFIED", "DUAL_CHANNEL_VERIFIED", "IDENTITY_VERIFIED"].includes(
          input.level,
        )
      ) {
        throw new CrmError("VALIDATION", "Unsupported verification level.");
      }
      if (
        input.level === "SINGLE_CHANNEL_VERIFIED" &&
        input.channel !== "EMAIL" &&
        input.channel !== "PHONE"
      ) {
        throw new CrmError(
          "VALIDATION",
          "A specific verification channel (EMAIL or PHONE) is required.",
        );
      }
      const verifyEmail = input.level !== "SINGLE_CHANNEL_VERIFIED" || input.channel === "EMAIL";
      const verifyPhone = input.level !== "SINGLE_CHANNEL_VERIFIED" || input.channel === "PHONE";
      if (verifyEmail) {
        if (!contact.email) throw new CrmError("VALIDATION", "An email identity is required.");
        await this.upsertIdentity(tx, contact.id, "EMAIL", contact.email, now);
      }
      if (verifyPhone) {
        if (!contact.phoneE164) throw new CrmError("VALIDATION", "A phone identity is required.");
        await this.upsertIdentity(tx, contact.id, "PHONE", contact.phoneE164, now);
      }
      if (input.level === "IDENTITY_VERIFIED") {
        if (!input.document)
          throw new CrmError("VALIDATION", "A reviewed document identifier is required.");
        try {
          await this.upsertIdentity(tx, contact.id, "DOCUMENT", input.document, now);
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            throw new CrmError("VALIDATION", error.message);
          }
          throw error;
        }
      }
      const verificationLevel = await this.verificationLevel(
        tx,
        contact.id,
        contact.email,
        contact.phoneE164,
      );
      const updated = await tx.contact.update({
        where: { id: contact.id },
        data: {
          verificationLevel,
          lastActivityAt: now,
          retentionReviewAt: await crmRetentionReviewAt(tx, this.retentionMonths),
          version: { increment: 1 },
        },
      });
      await crmLog(tx, audit, "CRM_CONTACT_VERIFIED", "Contact", contact.id, {
        previousVersion: expectedVersion,
        verificationLevel,
      });
      return updated;
    });
  }

  async listContacts(
    options: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly query?: string;
      readonly status?: "ACTIVE" | "MERGED" | "ANONYMIZED";
      readonly organizationId?: string;
    } = {},
  ) {
    if (options.cursor) assertUuid(options.cursor, "cursor");
    if (options.organizationId) assertUuid(options.organizationId, "organizationId");
    const limit = crmLimit(options.limit, 100);
    const query = options.query?.trim() || null;
    if (query && query.length > 320) throw new CrmError("VALIDATION", "Search query is too long.");
    let cursor: { id: string; createdAt: Date } | null = null;
    if (options.cursor) {
      const found = await this.db.contact.findUnique({
        where: { id: options.cursor },
        select: { id: true, createdAt: true },
      });
      if (!found) throw new CrmError("NOT_FOUND", "Contact cursor not found.");
      cursor = found;
    }
    const tokens = query ? query.split(/\s+/).filter(Boolean).slice(0, 6) : [];
    const searchFilter: Prisma.ContactWhereInput | null = query
      ? {
          OR: [
            { givenName: { contains: query, mode: "insensitive" } },
            { familyName: { contains: query, mode: "insensitive" } },
            ...(tokens.length > 1
              ? [
                  {
                    AND: tokens.map((token) => ({
                      OR: [
                        { givenName: { contains: token, mode: "insensitive" as const } },
                        { familyName: { contains: token, mode: "insensitive" as const } },
                      ],
                    })),
                  },
                ]
              : []),
            { email: { contains: query.toLowerCase(), mode: "insensitive" } },
            { phoneE164: { contains: query } },
            { organization: { legalName: { contains: query, mode: "insensitive" } } },
            { organization: { commercialName: { contains: query, mode: "insensitive" } } },
            {
              identities: {
                some: {
                  retiredAt: null,
                  OR: [
                    { kind: "EMAIL", normalizedValue: { contains: query.toLowerCase() } },
                    { kind: "PHONE", normalizedValue: { contains: query } },
                    { kind: "DOCUMENT", normalizedValue: query.toUpperCase() },
                  ],
                },
              },
            },
          ],
        }
      : null;
    const filters: Prisma.ContactWhereInput[] = [
      {
        status: options.status ?? "ACTIVE",
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      },
    ];
    if (searchFilter) filters.push(searchFilter);
    if (cursor) {
      filters.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }
    const contacts = await this.db.contact.findMany({
      where: { AND: filters },
      include: {
        organization: true,
        identities: { where: { retiredAt: null }, orderBy: [{ kind: "asc" }, { id: "asc" }] },
        _count: { select: { tasks: true, activities: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = contacts.length > limit;
    const page = hasMore ? contacts.slice(0, limit) : contacts;
    return {
      items: page.map((contact) => ({ ...maskCrmContact(contact), counts: contact._count })),
      nextCursor: hasMore ? page.at(-1)!.id : null,
    };
  }

  async getContact360(contactId: string) {
    assertUuid(contactId, "contactId");
    const contact = await this.db.contact.findUnique({
      where: { id: contactId },
      include: {
        organization: true,
        mergedFrom: {
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 50,
        },
        identities: { orderBy: [{ kind: "asc" }, { createdAt: "asc" }] },
        activities: {
          include: { createdBy: { select: { id: true, displayName: true } } },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 200,
        },
        tasks: {
          include: {
            assignedTo: { select: { id: true, displayName: true } },
            createdBy: { select: { id: true, displayName: true } },
          },
          orderBy: [{ status: "asc" }, { dueAt: "asc" }, { id: "asc" }],
          take: 200,
        },
        opportunities: {
          select: { id: true, status: true, currentVersion: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
        },
        customer: {
          select: {
            id: true,
            status: true,
            orders: {
              select: {
                id: true,
                orderNumber: true,
                orderStatus: true,
                paymentStatus: true,
                fulfillmentStatus: true,
                totalCents: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 100,
            },
            returnRequests: {
              select: { id: true, status: true, kind: true, createdAt: true, orderId: true },
              orderBy: [{ createdAt: "desc" }],
              take: 50,
            },
            warrantyClaims: {
              select: { id: true, status: true, remedy: true, createdAt: true, orderId: true },
              orderBy: [{ createdAt: "desc" }],
              take: 50,
            },
            supportTickets: {
              select: {
                id: true,
                ticketNumber: true,
                status: true,
                kind: true,
                slaDueAt: true,
                createdAt: true,
              },
              orderBy: [{ createdAt: "desc" }],
              take: 50,
            },
          },
        },
      },
    });
    if (!contact) throw new CrmError("NOT_FOUND", "Contact not found.");
    return {
      ...maskCrmContact(contact),
      mergedFrom: contact.mergedFrom.map((entry) => maskCrmContact(entry)),
      identities: contact.identities.map(maskCrmIdentity),
      activities: contact.activities,
      tasks: contact.tasks,
      opportunities: contact.opportunities,
      customer: contact.customer,
    };
  }

  async addActivity(
    input: {
      readonly contactId: string;
      readonly kind: "NOTE" | "CALL" | "EMAIL" | "MEETING";
      readonly subject?: string | null;
      readonly body: string;
      readonly occurredAt?: Date;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.contactId, "contactId");
    const body = crmText(input.body, "body", 1, 5000);
    const subject = input.subject ? crmText(input.subject, "subject", 1, 200) : null;
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const now = await crmNow(tx);
      const occurredAt = input.occurredAt ?? now;
      if (
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.getTime() > now.getTime() + 300_000 ||
        occurredAt.getFullYear() < 2000
      ) {
        throw new CrmError("VALIDATION", "Activity occurrence is outside the accepted range.");
      }
      const contact = await tx.contact.findFirst({
        where: { id: input.contactId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });
      if (!contact) throw new CrmError("NOT_FOUND", "Active contact not found.");
      const activity = await tx.contactActivity.create({
        data: {
          contactId: contact.id,
          kind: input.kind,
          subject,
          body,
          occurredAt,
          createdByAdminUserId: audit.actorAdminUserId,
        },
      });
      await this.touchContact(tx, contact.id, now);
      await crmLog(tx, audit, "CRM_ACTIVITY_CREATED", "ContactActivity", activity.id, {
        contactId: contact.id,
        kind: activity.kind,
      });
      return activity;
    });
  }

  private async assertAssignee(tx: Prisma.TransactionClient, adminUserId: string | null) {
    if (!adminUserId) return;
    const rows = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT "role"::text AS "role"
      FROM "AdminUser"
      WHERE "id" = ${adminUserId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
      FOR SHARE
    `;
    const admin = rows[0];
    if (!admin || !isAdminRole(admin.role) || !hasAdminPermission(admin.role, "crm:read")) {
      throw new CrmError("VALIDATION", "The task assignee is not an active CRM operator.");
    }
  }

  async createTask(
    input: {
      readonly contactId: string;
      readonly title: string;
      readonly description?: string | null;
      readonly priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      readonly dueAt: Date;
      readonly assignedToAdminUserId?: string | null;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.contactId, "contactId");
    if (input.assignedToAdminUserId)
      assertUuid(input.assignedToAdminUserId, "assignedToAdminUserId");
    const title = crmText(input.title, "title", 2, 160);
    const description = crmOptionalText(input.description, "description", 5000);
    if (!Number.isFinite(input.dueAt.getTime())) {
      throw new CrmError("VALIDATION", "Task due date is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await this.assertAssignee(tx, input.assignedToAdminUserId ?? null);
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const now = await crmNow(tx);
      if (input.dueAt.getTime() < now.getTime() - 300_000) {
        throw new CrmError("VALIDATION", "A new task cannot be due in the past.");
      }
      const contact = await tx.contact.findFirst({
        where: { id: input.contactId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });
      if (!contact) throw new CrmError("NOT_FOUND", "Active contact not found.");
      const task = await tx.task.create({
        data: {
          contactId: contact.id,
          title,
          description,
          priority: input.priority ?? "NORMAL",
          dueAt: input.dueAt,
          assignedToAdminUserId: input.assignedToAdminUserId ?? null,
          createdByAdminUserId: audit.actorAdminUserId,
        },
      });
      await this.touchContact(tx, contact.id, now);
      await crmLog(tx, audit, "CRM_TASK_CREATED", "Task", task.id, {
        contactId: contact.id,
        assignedToAdminUserId: task.assignedToAdminUserId,
        dueAt: task.dueAt.toISOString(),
        priority: task.priority,
      });
      return task;
    });
  }

  async updateTask(
    input: {
      readonly taskId: string;
      readonly expectedVersion: number;
      readonly title: string;
      readonly description?: string | null;
      readonly status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
      readonly priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      readonly dueAt: Date;
      readonly assignedToAdminUserId?: string | null;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.taskId, "taskId");
    if (input.assignedToAdminUserId)
      assertUuid(input.assignedToAdminUserId, "assignedToAdminUserId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const title = crmText(input.title, "title", 2, 160);
    const description = crmOptionalText(input.description, "description", 5000);
    if (!Number.isFinite(input.dueAt.getTime())) {
      throw new CrmError("VALIDATION", "Task due date is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await this.assertAssignee(tx, input.assignedToAdminUserId ?? null);
      const peek = await tx.task.findUnique({
        where: { id: input.taskId },
        select: { contactId: true },
      });
      if (!peek) throw new CrmError("NOT_FOUND", "Task not found.");
      await acquireOperationLocks(tx, [
        `crm-contact:${peek.contactId}`,
        `crm-task:${input.taskId}`,
      ]);
      const rows = await tx.$queryRaw<
        Array<import("./generated/client.js").Task>
      >`SELECT * FROM "Task" WHERE "id" = ${input.taskId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new CrmError("NOT_FOUND", "Task not found.");
      if (current.contactId !== peek.contactId) {
        throw retryableLockDivergenceError("The task contact changed concurrently.");
      }
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The task changed in another session.");
      }
      if (["COMPLETED", "CANCELLED"].includes(current.status)) {
        throw new CrmError("CONFLICT", "Terminal tasks cannot be reopened or edited.");
      }
      const now = await crmNow(tx);
      const task = await tx.task.update({
        where: { id: current.id },
        data: {
          title,
          description,
          status: input.status,
          priority: input.priority,
          dueAt: input.dueAt,
          assignedToAdminUserId: input.assignedToAdminUserId ?? null,
          completedAt: input.status === "COMPLETED" ? now : null,
          version: { increment: 1 },
        },
      });
      await this.touchContact(tx, current.contactId, now);
      await crmLog(tx, audit, "CRM_TASK_UPDATED", "Task", task.id, {
        contactId: task.contactId,
        previousVersion: expectedVersion,
        status: task.status,
        assignedToAdminUserId: task.assignedToAdminUserId,
        dueAt: task.dueAt.toISOString(),
      });
      return task;
    });
  }

  async listTaskAssignees() {
    const crmRoles = adminRoles.filter((role) => hasAdminPermission(role, "crm:read"));
    return this.db.adminUser.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        role: { in: [...crmRoles] },
      },
      select: { id: true, displayName: true, role: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: 500,
    });
  }

  async listTasks(
    options: {
      readonly assignedToAdminUserId?: string;
      readonly status?: "OPEN" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
      readonly limit?: number;
    } = {},
  ) {
    if (options.assignedToAdminUserId) {
      assertUuid(options.assignedToAdminUserId, "assignedToAdminUserId");
    }
    const limit = crmLimit(options.limit, 100);
    const statusFilter: Prisma.TaskWhereInput =
      !options.status || options.status === "OPEN"
        ? { status: { in: ["PENDING", "IN_PROGRESS"] } }
        : { status: options.status };
    const [currentTime, tasks] = await Promise.all([
      databaseNow(this.db),
      this.db.task.findMany({
        where: {
          ...statusFilter,
          contact: { status: "ACTIVE", deletedAt: null },
          ...(options.assignedToAdminUserId
            ? { assignedToAdminUserId: options.assignedToAdminUserId }
            : {}),
        },
        include: {
          contact: { include: { organization: true } },
          assignedTo: { select: { id: true, displayName: true } },
          createdBy: { select: { id: true, displayName: true } },
        },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        take: limit,
      }),
    ]);
    const now = currentTime.getTime();
    return tasks.map((task) => ({
      id: task.id,
      contactId: task.contactId,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
      version: task.version,
      isOverdue:
        (task.status === "PENDING" || task.status === "IN_PROGRESS") && task.dueAt.getTime() < now,
      assignedTo: task.assignedTo,
      createdBy: task.createdBy,
      contact: maskCrmContact(task.contact),
    }));
  }

  async listTasksPage(
    options: {
      readonly assignedToAdminUserId?: string;
      readonly status?: "OPEN" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
      readonly page?: number;
      readonly pageSize?: number;
    } = {},
  ) {
    if (options.assignedToAdminUserId) {
      assertUuid(options.assignedToAdminUserId, "assignedToAdminUserId");
    }
    if (
      options.status !== undefined &&
      !["OPEN", "PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(options.status)
    ) {
      throw new CrmError("VALIDATION", "Task status filter is invalid.");
    }
    const requestedPage = options.page ?? 1;
    const pageSize = options.pageSize ?? 25;
    if (
      !Number.isInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 10_000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new CrmError("VALIDATION", "Invalid CRM task pagination.");
    }
    const statusFilter: Prisma.TaskWhereInput =
      !options.status || options.status === "OPEN"
        ? { status: { in: ["PENDING", "IN_PROGRESS"] } }
        : { status: options.status };
    const where: Prisma.TaskWhereInput = {
      ...statusFilter,
      contact: { status: "ACTIVE", deletedAt: null },
      ...(options.assignedToAdminUserId
        ? { assignedToAdminUserId: options.assignedToAdminUserId }
        : {}),
    };
    const [currentTime, total] = await Promise.all([
      databaseNow(this.db),
      this.db.task.count({ where }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const tasks = await this.db.task.findMany({
      where,
      include: {
        contact: { include: { organization: true } },
        assignedTo: { select: { id: true, displayName: true } },
        createdBy: { select: { id: true, displayName: true } },
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const now = currentTime.getTime();
    return {
      items: tasks.map((task) => ({
        id: task.id,
        contactId: task.contactId,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueAt: task.dueAt,
        completedAt: task.completedAt,
        version: task.version,
        isOverdue:
          (task.status === "PENDING" || task.status === "IN_PROGRESS") &&
          task.dueAt.getTime() < now,
        assignedTo: task.assignedTo,
        createdBy: task.createdBy,
        contact: maskCrmContact(task.contact),
      })),
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  async detectDuplicates(
    options: { readonly contactId?: string; readonly limit?: number },
    audit: CrmAudit,
  ) {
    if (options.contactId) assertUuid(options.contactId, "contactId");
    const limit = crmLimit(options.limit, 100);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      const groups = await tx.$queryRaw<
        Array<{
          kind: ContactIdentityKindValue;
          normalizedValue: string;
          contactIds: string[];
        }>
      >`
        SELECT identity."kind", identity."normalizedValue", array_agg(DISTINCT identity."contactId") AS "contactIds"
        FROM "ContactIdentity" identity
        JOIN "Contact" contact ON contact."id" = identity."contactId"
        WHERE identity."retiredAt" IS NULL AND contact."status" = 'ACTIVE' AND contact."deletedAt" IS NULL
          AND (${options.contactId ?? null}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM "ContactIdentity" requested
            WHERE requested."contactId" = ${options.contactId ?? null}::uuid
              AND requested."kind" = identity."kind" AND requested."normalizedValue" = identity."normalizedValue"
              AND requested."retiredAt" IS NULL
          ))
        GROUP BY identity."kind", identity."normalizedValue"
        HAVING count(DISTINCT identity."contactId") > 1
        ORDER BY identity."kind", identity."normalizedValue"
        LIMIT ${limit}
      `;
      const pairs = new Map<string, { leftId: string; rightId: string; reasons: Set<string> }>();
      for (const group of groups) {
        const sortedIds = [...new Set(group.contactIds)].sort();
        for (let i = 0; i < sortedIds.length; i += 1) {
          for (let j = i + 1; j < sortedIds.length; j += 1) {
            const leftId = sortedIds[i]!;
            const rightId = sortedIds[j]!;
            if (
              options.contactId &&
              leftId !== options.contactId &&
              rightId !== options.contactId
            ) {
              continue;
            }
            const pairKey = contactPairKey(leftId, rightId);
            const entry = pairs.get(pairKey) ?? {
              leftId,
              rightId,
              reasons: new Set<string>(),
            };
            entry.reasons.add(`${group.kind}_EXACT`);
            pairs.set(pairKey, entry);
          }
        }
      }
      const sortedPairs = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b));
      const allPairContactIds = [
        ...new Set(sortedPairs.flatMap(([, entry]) => [entry.leftId, entry.rightId])),
      ].sort(compareStrings);
      if (sortedPairs.length > 0) {
        await acquireOperationLocks(tx, [
          ...allPairContactIds.map((id) => `crm-contact:${id}`),
          ...sortedPairs.map(([pairKey]) => `crm-merge:${pairKey}`),
        ]);
      }
      const lockedContacts =
        allPairContactIds.length > 0
          ? await tx.$queryRaw<Contact[]>`
              SELECT * FROM "Contact"
              WHERE "id" = ANY(${allPairContactIds}::uuid[])
                AND "status" = 'ACTIVE'
                AND "deletedAt" IS NULL
              ORDER BY "id"
              FOR SHARE
            `
          : [];
      const activeContactsById = new Map(lockedContacts.map((contact) => [contact.id, contact]));
      const activeIdentitiesByContact = new Map<string, Map<string, ContactIdentityKindValue>>();
      if (lockedContacts.length > 0) {
        const currentIdentities = await tx.contactIdentity.findMany({
          where: {
            contactId: { in: lockedContacts.map((contact) => contact.id) },
            retiredAt: null,
          },
          select: { contactId: true, kind: true, normalizedValue: true },
        });
        for (const identity of currentIdentities) {
          const map = activeIdentitiesByContact.get(identity.contactId) ?? new Map();
          map.set(`${identity.kind}:${identity.normalizedValue}`, identity.kind);
          activeIdentitiesByContact.set(identity.contactId, map);
        }
      }
      const resolved: Array<{ id: string; pairKey: string; created: boolean }> = [];
      for (const [pairKey, entry] of sortedPairs) {
        if (resolved.length >= limit) break;
        const existing = await tx.identityMergeCandidate.findFirst({
          where: { pairKey, status: { in: ["PENDING", "MERGED", "REJECTED"] } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        if (existing) {
          if (existing.status === "PENDING") {
            resolved.push({ id: existing.id, pairKey, created: false });
          }
          continue;
        }
        const leftContact = activeContactsById.get(entry.leftId);
        const rightContact = activeContactsById.get(entry.rightId);
        if (!leftContact || !rightContact) continue;
        const leftIdentities = activeIdentitiesByContact.get(leftContact.id);
        const rightIdentities = activeIdentitiesByContact.get(rightContact.id);
        if (!leftIdentities || !rightIdentities) continue;
        const verifiedReasons = new Set<string>();
        for (const [identityKey, kind] of leftIdentities.entries()) {
          if (rightIdentities.has(identityKey)) {
            verifiedReasons.add(`${kind}_EXACT`);
          }
        }
        if (verifiedReasons.size === 0) continue;
        const contacts = [leftContact, rightContact];
        contacts.sort(
          (left, right) =>
            verificationRank[right.verificationLevel] - verificationRank[left.verificationLevel] ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
        const target = contacts[0]!;
        const source = contacts[1]!;
        const candidate = await tx.identityMergeCandidate.create({
          data: {
            pairKey,
            sourceContactId: source.id,
            targetContactId: target.id,
            matchScore: 10000,
            matchReasons: [...verifiedReasons].sort(),
          },
        });
        resolved.push({ id: candidate.id, pairKey, created: true });
      }
      if (resolved.length > 0) {
        let selfDealing = false;
        for (const candidate of resolved) {
          const pair = pairs.get(candidate.pairKey)!;
          selfDealing =
            (await crmSelfDealing(tx, audit, "Contact", pair.leftId)) ||
            (await crmSelfDealing(tx, audit, "Contact", pair.rightId));
          if (selfDealing) break;
        }
        await crmLog(
          tx,
          audit,
          "CRM_DUPLICATES_DETECTED",
          options.contactId ? "Contact" : "IdentityMergeCandidate",
          options.contactId ?? resolved[0]!.id,
          {
            candidateCount: resolved.length,
            createdCount: resolved.filter((item) => item.created).length,
          },
          selfDealing,
        );
      }
      return { candidates: resolved, created: resolved.filter((item) => item.created).length };
    });
  }
}
