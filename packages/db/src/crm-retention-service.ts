import type { Contact, Prisma, PrismaClient } from "./generated/client.js";
import {
  AccountError,
  AccountService,
  acquireCustomerContactLockHierarchy,
  hasNewIds,
  peekCustomerAnonymizationScope,
  sameSortedIds,
} from "./account-service.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  inInventoryTransaction,
} from "./inventory-shared.js";
import {
  CrmError,
  crmActor,
  crmLog,
  crmNow,
  crmRetentionMonths,
  crmSelfDealing,
  crmVersion,
  redactCrmActivitiesInTransaction,
  redactCrmMergeHistoryInTransaction,
  redactCrmOpportunitiesInTransaction,
  retryableLockDivergenceError,
  type CrmAudit,
} from "./crm-shared.js";

async function findContactLineageIds(
  tx: Prisma.TransactionClient,
  contactId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE lineage AS (
      SELECT "id" FROM "Contact" WHERE "id" = ${contactId}::uuid
      UNION
      SELECT contact."id" FROM "Contact" contact
      JOIN lineage parent ON contact."mergedIntoContactId" = parent."id"
    )
    SELECT "id" FROM lineage ORDER BY "id"
  `;
  return rows.map((item) => item.id);
}

export type CrmSuppressionReason =
  "DATA_SUBJECT_REQUEST" | "RETENTION_EXPIRED" | "OPERATIONAL_REVIEW";

const suppressionReasons = new Set<CrmSuppressionReason>([
  "DATA_SUBJECT_REQUEST",
  "RETENTION_EXPIRED",
  "OPERATIONAL_REVIEW",
]);

export class CrmRetentionService {
  private readonly retentionMonths: number;

  constructor(
    private readonly db: PrismaClient,
    options: { readonly retentionMonths?: number } = {},
  ) {
    this.retentionMonths = crmRetentionMonths(options.retentionMonths ?? 24);
  }

  async suppress(
    input: {
      readonly contactId: string;
      readonly expectedVersion: number;
      readonly reason: CrmSuppressionReason;
      readonly privacyPolicyVersion: string;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.contactId, "contactId");
    const expectedVersion = crmVersion(input.expectedVersion);
    if (!suppressionReasons.has(input.reason)) {
      throw new CrmError("VALIDATION", "The suppression reason is invalid.");
    }
    if (
      !input.privacyPolicyVersion ||
      input.privacyPolicyVersion.trim() !== input.privacyPolicyVersion ||
      input.privacyPolicyVersion.length > 50
    ) {
      throw new CrmError("VALIDATION", "A valid privacy policy version is required.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:suppress");
      const peekRequested = await tx.contact.findUnique({
        where: { id: input.contactId },
        select: { id: true },
      });
      if (!peekRequested) throw new CrmError("NOT_FOUND", "Contact not found.");
      const initialLineageIds = await findContactLineageIds(tx, input.contactId);
      const initialContacts =
        initialLineageIds.length > 0
          ? await tx.contact.findMany({
              where: { id: { in: initialLineageIds } },
              select: { id: true, customerId: true },
            })
          : [];
      const initialCustomerIds = [
        ...new Set(
          initialContacts
            .map((contact) => contact.customerId)
            .filter((value): value is string => value !== null),
        ),
      ].sort(compareStrings);
      const customerLinkedContacts =
        initialCustomerIds.length > 0
          ? await tx.contact.findMany({
              where: { customerId: { in: initialCustomerIds } },
              select: { id: true },
            })
          : [];
      const peekLineageIds = [
        ...new Set([...initialLineageIds, ...customerLinkedContacts.map((item) => item.id)]),
      ].sort(compareStrings);
      const peekCustomerIds = initialCustomerIds;
      const peekScope = await peekCustomerAnonymizationScope(tx, peekCustomerIds);
      const locked = await acquireCustomerContactLockHierarchy(tx, {
        customerIds: peekCustomerIds,
        contactIds: peekLineageIds,
        scope: peekScope,
      });
      const contacts = locked.contacts;
      const requested = contacts.find((contact) => contact.id === input.contactId);
      if (!requested) throw new CrmError("NOT_FOUND", "Contact not found.");
      if (requested.status === "ANONYMIZED") {
        return {
          contactId: requested.id,
          lineage: [] as string[],
          customers: [] as string[],
          affectedReviewProductSlugs: [] as string[],
          replayed: true,
        };
      }
      if (requested.status !== "ACTIVE" || requested.deletedAt) {
        throw new CrmError("CONFLICT", "Only an active contact can be suppressed directly.");
      }
      if (requested.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The contact changed in another session.");
      }
      const directLineageIds = await findContactLineageIds(tx, requested.id);
      const customerIds = [
        ...new Set(
          contacts
            .map((contact) => contact.customerId)
            .filter((value): value is string => value !== null),
        ),
      ].sort(compareStrings);
      const verifiedLinkedContacts =
        customerIds.length > 0
          ? await tx.contact.findMany({
              where: { customerId: { in: customerIds } },
              select: { id: true },
            })
          : [];
      const lineageIds = [
        ...new Set([...directLineageIds, ...verifiedLinkedContacts.map((item) => item.id)]),
      ].sort(compareStrings);
      if (contacts.length !== lineageIds.length || !sameSortedIds(peekLineageIds, lineageIds)) {
        throw retryableLockDivergenceError("The contact lineage changed during suppression.");
      }
      const verifiedScope = await peekCustomerAnonymizationScope(tx, customerIds);
      if (
        hasNewIds(peekCustomerIds, customerIds) ||
        hasNewIds(peekScope.cartIds, verifiedScope.cartIds) ||
        hasNewIds(peekScope.couponIds, verifiedScope.couponIds) ||
        hasNewIds(peekScope.orderIds, verifiedScope.orderIds) ||
        hasNewIds(peekScope.ticketIds, verifiedScope.ticketIds) ||
        hasNewIds(peekScope.reviewIds, verifiedScope.reviewIds)
      ) {
        throw retryableLockDivergenceError(
          "The contact suppression dependencies changed concurrently.",
        );
      }
      const openTask = await tx.task.findFirst({
        where: { contactId: { in: lineageIds }, status: { in: ["PENDING", "IN_PROGRESS"] } },
        select: { id: true },
      });
      if (openTask) {
        throw new CrmError("CONFLICT", "Resolve open CRM tasks before suppressing this lineage.");
      }
      const pendingMerge = await tx.identityMergeCandidate.findFirst({
        where: {
          status: "PENDING",
          OR: [{ sourceContactId: { in: lineageIds } }, { targetContactId: { in: lineageIds } }],
        },
        select: { id: true },
      });
      if (pendingMerge) {
        throw new CrmError("CONFLICT", "Resolve pending identity merges before suppression.");
      }
      const openOpportunity = await tx.opportunity.findFirst({
        where: {
          contactId: { in: lineageIds },
          status: { in: ["NEW", "QUALIFYING", "PROPOSAL_SENT"] },
        },
        select: { id: true },
      });
      if (openOpportunity) {
        throw new CrmError(
          "CONFLICT",
          "Close active B2B opportunities and proposals before suppressing this lineage.",
        );
      }
      const accounts = new AccountService(this.db, {
        privacyPolicyVersion: input.privacyPolicyVersion,
      });
      if (input.reason === "RETENTION_EXPIRED" && customerIds.length > 0) {
        const openSupport = await tx.supportTicket.findFirst({
          where: {
            OR: [
              { requesterCustomerId: { in: customerIds } },
              { order: { customerId: { in: customerIds } } },
            ],
            status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
          },
          select: { id: true },
        });
        if (openSupport) {
          throw new CrmError(
            "CONFLICT",
            "Resolve open support tickets before automatic retention suppression.",
          );
        }
      }
      const selfDealing = await crmSelfDealing(tx, audit, "Contact", requested.id);
      const lockedCustomerMap = new Map(
        locked.customers.map((customer) => [customer.id, customer]),
      );
      const anonymizedCustomers: string[] = [];
      const affectedReviewSlugSet = new Set<string>();
      for (const customerId of customerIds) {
        const customer = lockedCustomerMap.get(customerId);
        if (!customer || customer.status === "ANONYMIZED" || customer.deletedAt) continue;
        const anonymized = await accounts.anonymizeInTransaction(tx, customerId, audit, {
          skipCrmCascade: true,
          alreadyLocked: true,
        });
        for (const slug of anonymized.affectedReviewProductSlugs) {
          affectedReviewSlugSet.add(slug);
        }
        anonymizedCustomers.push(customerId);
      }
      const now = await crmNow(tx);
      await redactCrmActivitiesInTransaction(tx, lineageIds, now);
      await tx.task.updateMany({
        where: { contactId: { in: lineageIds }, redactedAt: null },
        data: {
          title: "[tarea suprimida por retención]",
          description: null,
          redactedAt: now,
        },
      });
      const redactedMergeCount = await redactCrmMergeHistoryInTransaction(tx, lineageIds);
      await tx.identityMergeCandidate.updateMany({
        where: {
          status: "REJECTED",
          OR: [{ sourceContactId: { in: lineageIds } }, { targetContactId: { in: lineageIds } }],
        },
        data: {
          resolutionNote: "[contenido suprimido por retención]",
          version: { increment: 1 },
        },
      });
      await redactCrmOpportunitiesInTransaction(tx, lineageIds, now);
      for (const contact of contacts) {
        if (contact.status === "ANONYMIZED") continue;
        await tx.contact.update({
          where: { id: contact.id },
          data: {
            organizationId: null,
            customerId: null,
            givenName: null,
            familyName: null,
            email: null,
            phoneE164: null,
            status: "ANONYMIZED",
            verificationLevel: "UNVERIFIED",
            mergedIntoContactId: null,
            suppressionReason: input.reason,
            suppressedAt: now,
            anonymizedAt: now,
            deletedAt: now,
            version: { increment: 1 },
          },
        });
      }
      await tx.contactIdentity.deleteMany({ where: { contactId: { in: lineageIds } } });
      await crmLog(
        tx,
        audit,
        "CRM_CONTACT_SUPPRESSED",
        "Contact",
        requested.id,
        {
          reason: input.reason,
          lineageCount: contacts.length,
          anonymizedCustomerCount: anonymizedCustomers.length,
          redactedMergeCount,
        },
        selfDealing,
      );
      return {
        contactId: requested.id,
        lineage: lineageIds,
        customers: anonymizedCustomers,
        affectedReviewProductSlugs: [...affectedReviewSlugSet],
        replayed: false,
      };
    });
  }

  async runDue(
    input: {
      readonly limit?: number;
      readonly privacyPolicyVersion: string;
    },
    audit: CrmAudit,
  ) {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CrmError("VALIDATION", "Retention batch limit must be between 1 and 100.");
    }
    if (
      !input.privacyPolicyVersion ||
      input.privacyPolicyVersion.trim() !== input.privacyPolicyVersion ||
      input.privacyPolicyVersion.length > 50
    ) {
      throw new CrmError("VALIDATION", "A valid privacy policy version is required.");
    }
    await inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:suppress");
    });
    const due = await this.db.$queryRaw<Array<{ id: string; version: number }>>`
      SELECT "id", "version" FROM "Contact"
      WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL AND "retentionReviewAt" <= CURRENT_TIMESTAMP
      ORDER BY "retentionReviewAt", "id"
      LIMIT ${limit}
    `;
    const suppressed: string[] = [];
    const deferred: string[] = [];
    const affectedReviewSlugSet = new Set<string>();
    const attempted = new Set<string>();
    for (const contact of due) {
      if (attempted.has(contact.id)) continue;
      attempted.add(contact.id);
      try {
        const outcome = await this.suppress(
          {
            contactId: contact.id,
            expectedVersion: contact.version,
            reason: "RETENTION_EXPIRED",
            privacyPolicyVersion: input.privacyPolicyVersion,
          },
          audit,
        );
        if (!outcome.replayed) {
          suppressed.push(contact.id);
          for (const slug of outcome.affectedReviewProductSlugs) {
            affectedReviewSlugSet.add(slug);
          }
        }
      } catch (error) {
        if (error instanceof CrmError && error.code === "FORBIDDEN") {
          throw error;
        }
        if (
          (error instanceof CrmError || error instanceof AccountError) &&
          error.code === "NOT_FOUND"
        ) {
          continue;
        }
        if (
          !(error instanceof CrmError && error.code === "CONFLICT") &&
          !(error instanceof AccountError && error.code === "CONFLICT")
        ) {
          throw error;
        }
        try {
          await inInventoryTransaction(this.db, async (tx) => {
            await crmActor(tx, audit, "crm:suppress");
            await acquireOperationLocks(tx, [`crm-contact:${contact.id}`]);
            const rows = await tx.$queryRaw<
              Contact[]
            >`SELECT * FROM "Contact" WHERE "id" = ${contact.id}::uuid FOR UPDATE SKIP LOCKED`;
            const current = rows[0];
            if (!current || current.status !== "ACTIVE" || current.version !== contact.version)
              return;
            const reviewRows = await tx.$queryRaw<Array<{ retentionReviewAt: Date }>>`
              SELECT CURRENT_TIMESTAMP + INTERVAL '30 days' AS "retentionReviewAt"
            `;
            await tx.contact.update({
              where: { id: current.id },
              data: {
                retentionReviewAt: reviewRows[0]!.retentionReviewAt,
                version: { increment: 1 },
              },
            });
            await crmLog(tx, audit, "CRM_RETENTION_DEFERRED", "Contact", current.id, {
              reason: "ACTIVE_OBLIGATIONS",
              retentionMonths: this.retentionMonths,
            });
            deferred.push(current.id);
          });
        } catch (deferError) {
          if (deferError instanceof CrmError && deferError.code === "FORBIDDEN") {
            throw deferError;
          }
          if (
            (deferError instanceof CrmError || deferError instanceof AccountError) &&
            deferError.code === "NOT_FOUND"
          ) {
            continue;
          }
          throw deferError;
        }
      }
    }
    return {
      suppressed,
      deferred,
      scanned: due.length,
      affectedReviewProductSlugs: [...affectedReviewSlugSet],
    };
  }
}
