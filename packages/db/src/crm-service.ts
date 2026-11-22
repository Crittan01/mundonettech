import {
  contactPairKey,
  deriveContactVerificationLevel,
  normalizeContactIdentity,
  strongestContactVerificationLevel,
  type ContactIdentityKindValue,
} from "@mundonettech/core";

import type {
  Contact,
  ContactIdentity,
  ContactVerificationLevel,
  Customer,
  Prisma,
  PrismaClient,
} from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
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
  crmText,
  crmVersion,
  normalizeCrmContactInput,
  normalizeCrmOrganizationInput,
  type CrmAudit,
  type CrmContactInput,
  type CrmOrganizationInput,
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
    const organization = await tx.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!organization) throw new CrmError("NOT_FOUND", "Active organization not found.");
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
    await tx.contactIdentity.updateMany({
      where: { contactId, kind, normalizedValue, retiredAt: null },
      data: { retiredAt: now },
    });
  }

  private async verificationLevel(
    tx: Prisma.TransactionClient,
    contactId: string,
  ): Promise<ContactVerificationLevel> {
    const identities = await tx.contactIdentity.findMany({
      where: { contactId, retiredAt: null },
      select: { kind: true, verifiedAt: true },
    });
    return deriveContactVerificationLevel({
      emailVerified: identities.some((item) => item.kind === "EMAIL" && item.verifiedAt !== null),
      phoneVerified: identities.some((item) => item.kind === "PHONE" && item.verifiedAt !== null),
      identityVerified: identities.some(
        (item) => item.kind === "DOCUMENT" && item.verifiedAt !== null,
      ),
    });
  }

  async createOrganization(input: CrmOrganizationInput, audit: CrmAudit) {
    const values = normalizeCrmOrganizationInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      const organization = await tx.organization.create({ data: values });
      await crmLog(tx, audit, "CRM_ORGANIZATION_CREATED", "Organization", organization.id, {
        version: organization.version,
      });
      return organization;
    });
  }

  async updateOrganization(
    input: CrmOrganizationInput & {
      readonly organizationId: string;
      readonly expectedVersion: number;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.organizationId, "organizationId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const values = normalizeCrmOrganizationInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`crm-organization:${input.organizationId}`]);
      const rows = await tx.$queryRaw<
        Array<{ id: string; version: number; deletedAt: Date | null }>
      >`
        SELECT "id", "version", "deletedAt" FROM "Organization" WHERE "id" = ${input.organizationId}::uuid FOR UPDATE
      `;
      const current = rows[0];
      if (!current || current.deletedAt) throw new CrmError("NOT_FOUND", "Organization not found.");
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The organization changed in another session.");
      }
      const organization = await tx.organization.update({
        where: { id: current.id },
        data: { ...values, version: { increment: 1 } },
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
      const current = await tx.organization.findFirst({
        where: { id: input.organizationId, deletedAt: null },
      });
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
    const emailVerifiedAt = customer.authUserId && customer.status === "ACTIVE" ? now : null;
    const existing = await tx.contact.findFirst({
      where: { customerId, deletedAt: null },
      include: { identities: true },
    });
    const contact = existing
      ? await tx.contact.update({
          where: { id: existing.id },
          data: {
            givenName: customer.givenName,
            familyName: customer.familyName,
            email: customer.email,
            phoneE164: customer.phoneE164,
            lastActivityAt: now,
            retentionReviewAt,
            version: { increment: 1 },
          },
        })
      : await tx.contact.create({
          data: {
            customerId,
            givenName: customer.givenName,
            familyName: customer.familyName,
            email: customer.email,
            phoneE164: customer.phoneE164,
            source: "checkout",
            retentionReviewAt,
            lastActivityAt: now,
          },
        });
    await this.upsertIdentity(tx, contact.id, "EMAIL", customer.email, emailVerifiedAt);
    if (existing?.email && existing.email !== customer.email) {
      await this.retireIdentity(tx, contact.id, "EMAIL", existing.email, customer.email, now);
    }
    if (customer.phoneE164) {
      await this.upsertIdentity(tx, contact.id, "PHONE", customer.phoneE164, null);
    }
    if (existing?.phoneE164 && existing.phoneE164 !== customer.phoneE164) {
      await this.retireIdentity(tx, contact.id, "PHONE", existing.phoneE164, null, now);
    }
    const derivedLevel = await this.verificationLevel(tx, contact.id);
    const verificationLevel = existing
      ? strongestContactVerificationLevel(existing.verificationLevel, derivedLevel)
      : derivedLevel;
    if (verificationLevel !== contact.verificationLevel) {
      return tx.contact.update({ where: { id: contact.id }, data: { verificationLevel } });
    }
    return contact;
  }

  async syncCustomerContact(customerId: string): Promise<Contact> {
    return inInventoryTransaction(this.db, async (tx) =>
      this.syncCustomerContactInTransaction(tx, customerId),
    );
  }

  async updateContact(
    input: CrmContactInput & { readonly contactId: string; readonly expectedVersion: number },
    audit: CrmAudit,
  ) {
    assertUuid(input.contactId, "contactId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const values = normalizeCrmContactInput(input);
    if (values.customerId) throw new CrmError("VALIDATION", "Customer links are system managed.");
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const rows = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" = ${input.contactId}::uuid FOR UPDATE`;
      const current = rows[0];
      if (!current || current.status !== "ACTIVE" || current.deletedAt) {
        throw new CrmError("NOT_FOUND", "Active contact not found.");
      }
      if (current.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The contact changed in another session.");
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
      const contact = await tx.contact.update({
        where: { id: current.id },
        data: {
          organizationId: values.organizationId,
          givenName: values.givenName,
          familyName: values.familyName,
          email: values.email,
          phoneE164: values.phoneE164,
          source: values.source,
          lastActivityAt: now,
          retentionReviewAt: await crmRetentionReviewAt(tx, this.retentionMonths),
          version: { increment: 1 },
        },
      });
      const verificationLevel = await this.verificationLevel(tx, current.id);
      const updated =
        verificationLevel === contact.verificationLevel
          ? contact
          : await tx.contact.update({ where: { id: contact.id }, data: { verificationLevel } });
      await crmLog(tx, audit, "CRM_CONTACT_UPDATED", "Contact", contact.id, {
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
        await this.upsertIdentity(tx, contact.id, "DOCUMENT", input.document, now);
      }
      const verificationLevel = await this.verificationLevel(tx, contact.id);
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
    const contacts = await this.db.contact.findMany({
      where: {
        status: options.status ?? "ACTIVE",
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        ...(query
          ? {
              OR: [
                { givenName: { contains: query, mode: "insensitive" } },
                { familyName: { contains: query, mode: "insensitive" } },
                { email: { contains: query.toLowerCase(), mode: "insensitive" } },
                { phoneE164: { contains: query } },
                { organization: { legalName: { contains: query, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: {
        organization: true,
        identities: { where: { retiredAt: null }, orderBy: [{ kind: "asc" }, { id: "asc" }] },
        _count: { select: { tasks: true, activities: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
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
      identities: contact.identities.map(maskCrmIdentity),
      activities: contact.activities,
      tasks: contact.tasks,
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
    const admin = await tx.adminUser.findFirst({
      where: { id: adminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (
      !admin ||
      ![
        "SUPERADMIN",
        "OPERATIONS_MANAGER",
        "STORE_MANAGER",
        "CUSTOMER_SUPPORT",
        "FINANCE_ANALYST",
      ].includes(admin.role)
    ) {
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
    return this.db.adminUser.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        role: {
          in: [
            "SUPERADMIN",
            "OPERATIONS_MANAGER",
            "STORE_MANAGER",
            "CUSTOMER_SUPPORT",
            "FINANCE_ANALYST",
          ],
        },
      },
      select: { id: true, displayName: true, role: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: 500,
    });
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
      const pairs = new Map<string, { contactIds: Set<string>; reasons: Set<string> }>();
      for (const group of groups) {
        for (const contactId of group.contactIds) {
          const pair = pairs.get(contactId) ?? {
            contactIds: new Set<string>(),
            reasons: new Set<string>(),
          };
          for (const otherId of group.contactIds)
            if (otherId !== contactId) pair.contactIds.add(otherId);
          pair.reasons.add(`${group.kind}_EXACT`);
          pairs.set(contactId, pair);
        }
      }
      const resolved: Array<{ id: string; pairKey: string; created: boolean }> = [];
      for (const [contactId, matches] of pairs) {
        for (const otherId of matches.contactIds) {
          if (resolved.length >= limit) break;
          const pairKey = contactPairKey(contactId, otherId);
          if (resolved.some((item) => item.pairKey === pairKey)) continue;
          await acquireOperationLocks(tx, [`crm-merge:${pairKey}`]);
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
          const contacts = await tx.contact.findMany({
            where: { id: { in: [contactId, otherId] }, status: "ACTIVE", deletedAt: null },
          });
          if (contacts.length !== 2) continue;
          contacts.sort(
            (left, right) =>
              verificationRank[right.verificationLevel] -
                verificationRank[left.verificationLevel] ||
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
              matchReasons: [...matches.reasons].sort(),
            },
          });
          resolved.push({ id: candidate.id, pairKey, created: true });
        }
      }
      if (resolved.length > 0) {
        await crmLog(
          tx,
          audit,
          "CRM_DUPLICATES_DETECTED",
          "Contact",
          options.contactId ?? resolved[0]!.id,
          {
            candidateCount: resolved.length,
            createdCount: resolved.filter((item) => item.created).length,
          },
        );
      }
      return { candidates: resolved, created: resolved.filter((item) => item.created).length };
    });
  }
}
