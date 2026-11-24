import type { Contact, PrismaClient } from "./generated/client.js";
import { AccountService, AccountError } from "./account-service.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import {
  CrmError,
  crmActor,
  crmLog,
  crmNow,
  crmRetentionMonths,
  crmVersion,
  redactCrmActivitiesInTransaction,
  redactCrmMergeHistoryInTransaction,
  redactCrmOpportunitiesInTransaction,
  type CrmAudit,
} from "./crm-shared.js";

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
    if (!input.privacyPolicyVersion || input.privacyPolicyVersion.length > 50) {
      throw new CrmError("VALIDATION", "A valid privacy policy version is required.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:suppress");
      await acquireOperationLocks(tx, [`crm-contact:${input.contactId}`]);
      const requestedRows = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" = ${input.contactId}::uuid FOR UPDATE`;
      const requested = requestedRows[0];
      if (!requested) throw new CrmError("NOT_FOUND", "Contact not found.");
      if (requested.status === "ANONYMIZED") {
        return {
          contactId: requested.id,
          lineage: [] as string[],
          customers: [] as string[],
          replayed: true,
        };
      }
      if (requested.status !== "ACTIVE" || requested.deletedAt) {
        throw new CrmError("CONFLICT", "Only an active contact can be suppressed directly.");
      }
      if (requested.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The contact changed in another session.");
      }
      const lineageRows = await tx.$queryRaw<Array<{ id: string }>>`
        WITH RECURSIVE lineage AS (
          SELECT "id" FROM "Contact" WHERE "id" = ${requested.id}::uuid
          UNION ALL
          SELECT contact."id" FROM "Contact" contact
          JOIN lineage parent ON contact."mergedIntoContactId" = parent."id"
        )
        SELECT "id" FROM lineage ORDER BY "id"
      `;
      const lineageIds = lineageRows.map((item) => item.id);
      await acquireOperationLocks(
        tx,
        lineageIds.map((id) => `crm-contact:${id}`),
      );
      const contacts = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" IN (SELECT * FROM unnest(${lineageIds}::uuid[])) ORDER BY "id" FOR UPDATE`;
      if (contacts.length !== lineageIds.length) {
        throw new CrmError("CONFLICT", "The contact lineage changed during suppression.");
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
      const customerIds = [
        ...new Set(
          contacts
            .map((contact) => contact.customerId)
            .filter((value): value is string => value !== null),
        ),
      ].sort();
      const accounts = new AccountService(this.db, {
        privacyPolicyVersion: input.privacyPolicyVersion,
      });
      if (input.reason === "RETENTION_EXPIRED" && customerIds.length > 0) {
        const openSupport = await tx.supportTicket.findFirst({
          where: {
            requesterCustomerId: { in: customerIds },
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
      const anonymizedCustomers: string[] = [];
      for (const customerId of customerIds) {
        const customer = await tx.customer.findUnique({
          where: { id: customerId },
          select: { status: true, deletedAt: true },
        });
        if (!customer || customer.status === "ANONYMIZED" || customer.deletedAt) continue;
        await accounts.anonymizeInTransaction(tx, customerId, audit, { skipCrmCascade: true });
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
        data: { resolutionNote: "[contenido suprimido por retención]" },
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
      await crmLog(tx, audit, "CRM_CONTACT_SUPPRESSED", "Contact", requested.id, {
        reason: input.reason,
        lineageCount: contacts.length,
        anonymizedCustomerCount: anonymizedCustomers.length,
        redactedMergeCount,
      });
      return {
        contactId: requested.id,
        lineage: lineageIds,
        customers: anonymizedCustomers,
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
    for (const contact of due) {
      try {
        await this.suppress(
          {
            contactId: contact.id,
            expectedVersion: contact.version,
            reason: "RETENTION_EXPIRED",
            privacyPolicyVersion: input.privacyPolicyVersion,
          },
          audit,
        );
        suppressed.push(contact.id);
      } catch (error) {
        if (
          !(error instanceof CrmError && error.code === "CONFLICT") &&
          !(error instanceof AccountError && error.code === "CONFLICT")
        ) {
          throw error;
        }
        await inInventoryTransaction(this.db, async (tx) => {
          await crmActor(tx, audit, "crm:suppress");
          await acquireOperationLocks(tx, [`crm-contact:${contact.id}`]);
          const rows = await tx.$queryRaw<
            Contact[]
          >`SELECT * FROM "Contact" WHERE "id" = ${contact.id}::uuid FOR UPDATE`;
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
      }
    }
    return { suppressed, deferred, scanned: due.length };
  }
}
