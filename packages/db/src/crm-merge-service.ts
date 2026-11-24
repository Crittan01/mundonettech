import {
  deriveContactVerificationLevel,
  hasAdminPermission,
  isAdminRole,
  strongestContactVerificationLevel,
} from "@mundonettech/core";

import type {
  Contact,
  ContactVerificationLevel,
  IdentityMergeCandidate,
  Prisma,
  PrismaClient,
} from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import { maskCrmContact } from "./crm-presenters.js";
import {
  CrmError,
  crmActor,
  crmContactSnapshot,
  crmJsonStringArray,
  crmLog,
  crmNow,
  crmText,
  crmVersion,
  type CrmAudit,
} from "./crm-shared.js";

function candidateSnapshot(
  value: Prisma.JsonValue | null,
  expectedId: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrmError("CONFLICT", "The merge snapshot is unavailable or redacted.");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.id !== expectedId)
    throw new CrmError("CONFLICT", "The merge snapshot does not match.");
  return snapshot;
}

function snapshotString(
  snapshot: Record<string, unknown>,
  key: string,
  nullable = false,
): string | null {
  const value = snapshot[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new CrmError("CONFLICT", `Snapshot field ${key} is invalid.`);
  }
  return value;
}

function snapshotDate(snapshot: Record<string, unknown>, key: string): Date {
  const value = snapshotString(snapshot, key);
  const date = new Date(value!);
  if (!Number.isFinite(date.getTime()))
    throw new CrmError("CONFLICT", `Snapshot ${key} is invalid.`);
  return date;
}

function snapshotNullableDate(snapshot: Record<string, unknown>, key: string): Date | null {
  return snapshot[key] === null ? null : snapshotDate(snapshot, key);
}

function snapshotVerification(snapshot: Record<string, unknown>): ContactVerificationLevel {
  const value = snapshotString(snapshot, "verificationLevel");
  if (
    ![
      "UNVERIFIED",
      "SINGLE_CHANNEL_VERIFIED",
      "DUAL_CHANNEL_VERIFIED",
      "IDENTITY_VERIFIED",
    ].includes(value!)
  ) {
    throw new CrmError("CONFLICT", "Snapshot verification level is invalid.");
  }
  return value as ContactVerificationLevel;
}

function restoredContactFields(snapshot: Record<string, unknown>) {
  for (const key of ["organizationId", "customerId"]) {
    const value = snapshotString(snapshot, key, true);
    if (value) assertUuid(value, key);
  }
  return {
    organizationId: snapshotString(snapshot, "organizationId", true),
    customerId: snapshotString(snapshot, "customerId", true),
    givenName: snapshotString(snapshot, "givenName", true),
    familyName: snapshotString(snapshot, "familyName", true),
    email: snapshotString(snapshot, "email", true),
    phoneE164: snapshotString(snapshot, "phoneE164", true),
    verificationLevel: snapshotVerification(snapshot),
    source: snapshotString(snapshot, "source")!,
    retentionReviewAt: snapshotDate(snapshot, "retentionReviewAt"),
    lastActivityAt: snapshotNullableDate(snapshot, "lastActivityAt"),
  };
}

export class CrmMergeService {
  constructor(private readonly db: PrismaClient) {}

  async listCandidates(
    actorAdminUserId: string,
    status: "PENDING" | "MERGED" | "REJECTED" | "REVERSED" = "PENDING",
  ) {
    assertUuid(actorAdminUserId, "actorAdminUserId");
    const actor = await this.db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "crm:merge")) {
      throw new CrmError("FORBIDDEN", "The administrator is not authorized to read CRM merges.");
    }
    const candidates = await this.db.identityMergeCandidate.findMany({
      where: { status },
      select: {
        id: true,
        pairKey: true,
        status: true,
        matchScore: true,
        matchReasons: true,
        resolutionNote: true,
        version: true,
        mergedAt: true,
        rejectedAt: true,
        reversedAt: true,
        createdAt: true,
        updatedAt: true,
        sourceContact: { include: { organization: true, identities: true } },
        targetContact: { include: { organization: true, identities: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
    return candidates.map((candidate) => ({
      ...candidate,
      sourceContact: maskCrmContact(candidate.sourceContact),
      targetContact: maskCrmContact(candidate.targetContact),
    }));
  }

  private async lockedCandidate(
    tx: Prisma.TransactionClient,
    candidateId: string,
  ): Promise<IdentityMergeCandidate> {
    const rows = await tx.$queryRaw<
      IdentityMergeCandidate[]
    >`SELECT * FROM "IdentityMergeCandidate" WHERE "id" = ${candidateId}::uuid FOR UPDATE`;
    const candidate = rows[0];
    if (!candidate) throw new CrmError("NOT_FOUND", "Identity merge candidate not found.");
    return candidate;
  }

  private async lockPair(
    tx: Prisma.TransactionClient,
    candidateId: string,
  ): Promise<IdentityMergeCandidate> {
    const peek = await tx.identityMergeCandidate.findUnique({
      where: { id: candidateId },
      select: { pairKey: true, sourceContactId: true, targetContactId: true },
    });
    if (!peek) throw new CrmError("NOT_FOUND", "Identity merge candidate not found.");
    await acquireOperationLocks(tx, [
      `crm-contact:${peek.sourceContactId}`,
      `crm-contact:${peek.targetContactId}`,
      `crm-merge:${peek.pairKey}`,
      `crm-merge-candidate:${candidateId}`,
    ]);
    return this.lockedCandidate(tx, candidateId);
  }

  async reject(
    input: {
      readonly candidateId: string;
      readonly expectedVersion: number;
      readonly note: string;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.candidateId, "candidateId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const note = crmText(input.note, "note", 10, 500);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:merge");
      const candidate = await this.lockPair(tx, input.candidateId);
      if (candidate.status !== "PENDING") {
        throw new CrmError("CONFLICT", "The candidate is no longer pending.");
      }
      if (candidate.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The candidate changed in another session.");
      }
      const now = await crmNow(tx);
      const updated = await tx.identityMergeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "REJECTED",
          rejectedByAdminUserId: audit.actorAdminUserId,
          rejectedAt: now,
          resolutionNote: note,
          version: { increment: 1 },
        },
      });
      await crmLog(
        tx,
        audit,
        "CRM_IDENTITY_MERGE_REJECTED",
        "IdentityMergeCandidate",
        candidate.id,
        {
          sourceContactId: candidate.sourceContactId,
          targetContactId: candidate.targetContactId,
        },
      );
      return updated;
    });
  }

  async merge(
    input: {
      readonly candidateId: string;
      readonly expectedVersion: number;
      readonly expectedSourceVersion: number;
      readonly expectedTargetVersion: number;
      readonly note: string;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.candidateId, "candidateId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const expectedSourceVersion = crmVersion(input.expectedSourceVersion);
    const expectedTargetVersion = crmVersion(input.expectedTargetVersion);
    const note = crmText(input.note, "note", 10, 500);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:merge");
      const candidate = await this.lockPair(tx, input.candidateId);
      if (candidate.status !== "PENDING" || candidate.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The candidate is no longer available for merge.");
      }
      const contacts = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" IN (${candidate.sourceContactId}::uuid, ${candidate.targetContactId}::uuid) ORDER BY "id" FOR UPDATE`;
      const source = contacts.find((item) => item.id === candidate.sourceContactId);
      const target = contacts.find((item) => item.id === candidate.targetContactId);
      if (
        !source ||
        !target ||
        source.status !== "ACTIVE" ||
        target.status !== "ACTIVE" ||
        source.deletedAt ||
        target.deletedAt
      ) {
        throw new CrmError("CONFLICT", "Both contacts must remain active before merging.");
      }
      if (source.version !== expectedSourceVersion || target.version !== expectedTargetVersion) {
        throw new CrmError("CONFLICT", "A contact changed after the candidate was opened.");
      }
      if (source.customerId && target.customerId && source.customerId !== target.customerId) {
        throw new CrmError(
          "CONFLICT",
          "Contacts linked to different Customer accounts cannot merge.",
        );
      }
      const now = await crmNow(tx);
      const [
        sourceIdentities,
        targetIdentities,
        sourceActivities,
        sourceTasks,
        sourceOpportunities,
      ] = await Promise.all([
        tx.contactIdentity.findMany({ where: { contactId: source.id, retiredAt: null } }),
        tx.contactIdentity.findMany({ where: { contactId: target.id, retiredAt: null } }),
        tx.contactActivity.findMany({ where: { contactId: source.id }, select: { id: true } }),
        tx.task.findMany({ where: { contactId: source.id }, select: { id: true } }),
        tx.opportunity.findMany({ where: { contactId: source.id }, select: { id: true } }),
      ]);
      const targetIdentityKeys = new Set(
        targetIdentities.map((item) => `${item.kind}:${item.normalizedValue}`),
      );
      if (
        !sourceIdentities.some((identity) =>
          targetIdentityKeys.has(`${identity.kind}:${identity.normalizedValue}`),
        )
      ) {
        throw new CrmError("CONFLICT", "The original duplicate evidence no longer exists.");
      }
      const movedIdentityIds: string[] = [];
      const retiredIdentityIds: string[] = [];
      for (const identity of sourceIdentities) {
        if (targetIdentityKeys.has(`${identity.kind}:${identity.normalizedValue}`)) {
          await tx.contactIdentity.update({
            where: { id: identity.id },
            data: { retiredAt: now },
          });
          retiredIdentityIds.push(identity.id);
        } else {
          await tx.contactIdentity.update({
            where: { id: identity.id },
            data: { contactId: target.id, retiredAt: null },
          });
          movedIdentityIds.push(identity.id);
        }
      }
      const movedActivityIds = sourceActivities.map((item) => item.id);
      const movedTaskIds = sourceTasks.map((item) => item.id);
      if (movedActivityIds.length > 0) {
        await tx.contactActivity.updateMany({
          where: { id: { in: movedActivityIds }, contactId: source.id },
          data: { contactId: target.id },
        });
      }
      if (movedTaskIds.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: movedTaskIds }, contactId: source.id },
          data: { contactId: target.id },
        });
      }
      const movedOpportunityIds = sourceOpportunities.map((item) => item.id);
      if (movedOpportunityIds.length > 0) {
        await tx.opportunity.updateMany({
          where: { id: { in: movedOpportunityIds }, contactId: source.id },
          data: { contactId: target.id },
        });
      }
      const sourceSnapshot = crmContactSnapshot(source);
      const targetSnapshot = crmContactSnapshot(target);
      const mergedSource = await tx.contact.update({
        where: { id: source.id },
        data: {
          status: "MERGED",
          mergedIntoContactId: target.id,
          deletedAt: now,
          version: { increment: 1 },
        },
      });
      const remainingIdentities = await tx.contactIdentity.findMany({
        where: { contactId: target.id, retiredAt: null },
        select: { kind: true, verifiedAt: true },
      });
      const mergedEmail = target.email ?? source.email;
      const mergedPhone = target.phoneE164 ?? source.phoneE164;
      const combinedIdentities = [...remainingIdentities, ...sourceIdentities];
      const combinedDerived = deriveContactVerificationLevel({
        emailVerified: combinedIdentities.some(
          (item) => item.kind === "EMAIL" && item.verifiedAt !== null,
        ),
        phoneVerified: combinedIdentities.some(
          (item) => item.kind === "PHONE" && item.verifiedAt !== null,
        ),
        identityVerified: combinedIdentities.some(
          (item) => item.kind === "DOCUMENT" && item.verifiedAt !== null,
        ),
      });
      let derivedLevel = strongestContactVerificationLevel(
        strongestContactVerificationLevel(source.verificationLevel, target.verificationLevel),
        combinedDerived,
      );
      if (!mergedEmail && !mergedPhone) {
        derivedLevel = "UNVERIFIED";
      } else if (
        (!mergedEmail || !mergedPhone) &&
        (derivedLevel === "DUAL_CHANNEL_VERIFIED" || derivedLevel === "IDENTITY_VERIFIED")
      ) {
        derivedLevel = "SINGLE_CHANNEL_VERIFIED";
      }
      const mergedTarget = await tx.contact.update({
        where: { id: target.id },
        data: {
          organizationId: target.organizationId ?? source.organizationId,
          customerId: target.customerId ?? source.customerId,
          givenName: target.givenName ?? source.givenName,
          familyName: target.familyName ?? source.familyName,
          email: mergedEmail,
          phoneE164: mergedPhone,
          verificationLevel: derivedLevel,
          lastActivityAt:
            source.lastActivityAt && target.lastActivityAt
              ? new Date(Math.max(source.lastActivityAt.getTime(), target.lastActivityAt.getTime()))
              : (target.lastActivityAt ?? source.lastActivityAt),
          retentionReviewAt: new Date(
            Math.max(source.retentionReviewAt.getTime(), target.retentionReviewAt.getTime()),
          ),
          version: { increment: 1 },
        },
      });
      const updated = await tx.identityMergeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "MERGED",
          sourceSnapshot,
          targetSnapshot,
          movedIdentityIds,
          retiredIdentityIds,
          movedActivityIds,
          movedTaskIds,
          movedOpportunityIds,
          mergedSourceVersion: mergedSource.version,
          mergedTargetVersion: mergedTarget.version,
          mergedByAdminUserId: audit.actorAdminUserId,
          mergedAt: now,
          resolutionNote: note,
          version: { increment: 1 },
        },
      });
      await crmLog(tx, audit, "CRM_CONTACTS_MERGED", "IdentityMergeCandidate", candidate.id, {
        sourceContactId: source.id,
        targetContactId: target.id,
        movedIdentityCount: movedIdentityIds.length,
        retiredIdentityCount: retiredIdentityIds.length,
        movedActivityCount: movedActivityIds.length,
        movedTaskCount: movedTaskIds.length,
      });
      return { candidate: updated, sourceContactId: source.id, targetContactId: target.id };
    });
  }

  async reverse(
    input: {
      readonly candidateId: string;
      readonly expectedVersion: number;
      readonly note: string;
    },
    audit: CrmAudit,
  ) {
    assertUuid(input.candidateId, "candidateId");
    const expectedVersion = crmVersion(input.expectedVersion);
    const note = crmText(input.note, "note", 10, 500);
    return inInventoryTransaction(this.db, async (tx) => {
      await crmActor(tx, audit, "crm:merge");
      const candidate = await this.lockPair(tx, input.candidateId);
      if (candidate.status !== "MERGED" || candidate.version !== expectedVersion) {
        throw new CrmError("CONFLICT", "The merge is no longer reversible from this candidate.");
      }
      const sourceSnapshot = candidateSnapshot(candidate.sourceSnapshot, candidate.sourceContactId);
      const targetSnapshot = candidateSnapshot(candidate.targetSnapshot, candidate.targetContactId);
      const movedIdentityIds = crmJsonStringArray(candidate.movedIdentityIds, "movedIdentityIds");
      const retiredIdentityIds = crmJsonStringArray(
        candidate.retiredIdentityIds,
        "retiredIdentityIds",
      );
      const movedActivityIds = crmJsonStringArray(candidate.movedActivityIds, "movedActivityIds");
      const movedTaskIds = crmJsonStringArray(candidate.movedTaskIds, "movedTaskIds");
      const movedOpportunityIds = crmJsonStringArray(
        candidate.movedOpportunityIds,
        "movedOpportunityIds",
      );
      const contacts = await tx.$queryRaw<
        Contact[]
      >`SELECT * FROM "Contact" WHERE "id" IN (${candidate.sourceContactId}::uuid, ${candidate.targetContactId}::uuid) ORDER BY "id" FOR UPDATE`;
      const source = contacts.find((item) => item.id === candidate.sourceContactId);
      const target = contacts.find((item) => item.id === candidate.targetContactId);
      if (
        !source ||
        !target ||
        source.status !== "MERGED" ||
        target.status !== "ACTIVE" ||
        source.mergedIntoContactId !== target.id ||
        source.version !== candidate.mergedSourceVersion ||
        target.version !== candidate.mergedTargetVersion
      ) {
        throw new CrmError(
          "CONFLICT",
          "A later contact mutation or retention redaction makes this merge irreversible.",
        );
      }
      if (movedIdentityIds.length > 0) {
        const moved = await tx.contactIdentity.updateMany({
          where: { id: { in: movedIdentityIds }, contactId: target.id, retiredAt: null },
          data: { contactId: source.id },
        });
        if (moved.count !== movedIdentityIds.length) {
          throw new CrmError("CONFLICT", "A merged identity changed before reversal.");
        }
      }
      if (retiredIdentityIds.length > 0) {
        const restored = await tx.contactIdentity.updateMany({
          where: { id: { in: retiredIdentityIds }, contactId: source.id, retiredAt: { not: null } },
          data: { retiredAt: null },
        });
        if (restored.count !== retiredIdentityIds.length) {
          throw new CrmError("CONFLICT", "A retired identity changed before reversal.");
        }
      }
      if (movedActivityIds.length > 0) {
        const moved = await tx.contactActivity.updateMany({
          where: { id: { in: movedActivityIds }, contactId: target.id },
          data: { contactId: source.id },
        });
        if (moved.count !== movedActivityIds.length) {
          throw new CrmError("CONFLICT", "A merged activity changed before reversal.");
        }
      }
      if (movedTaskIds.length > 0) {
        const moved = await tx.task.updateMany({
          where: { id: { in: movedTaskIds }, contactId: target.id },
          data: { contactId: source.id },
        });
        if (moved.count !== movedTaskIds.length) {
          throw new CrmError("CONFLICT", "A merged task changed before reversal.");
        }
      }
      if (movedOpportunityIds.length > 0) {
        const moved = await tx.opportunity.updateMany({
          where: { id: { in: movedOpportunityIds }, contactId: target.id },
          data: { contactId: source.id },
        });
        if (moved.count !== movedOpportunityIds.length) {
          throw new CrmError("CONFLICT", "A merged opportunity changed before reversal.");
        }
      }
      const targetFields = restoredContactFields(targetSnapshot);
      const sourceFields = restoredContactFields(sourceSnapshot);
      const requiredOrgIds = [
        ...new Set(
          [targetFields.organizationId, sourceFields.organizationId].filter(
            (id): id is string => id !== null,
          ),
        ),
      ];
      if (requiredOrgIds.length > 0) {
        const activeOrgs = await tx.organization.count({
          where: { id: { in: requiredOrgIds }, deletedAt: null },
        });
        if (activeOrgs !== requiredOrgIds.length) {
          throw new CrmError(
            "CONFLICT",
            "Cannot reverse merge because an associated organization was archived.",
          );
        }
      }
      const restoredTarget = await tx.contact.update({
        where: { id: target.id },
        data: { ...targetFields, version: { increment: 1 } },
      });
      const restoredSource = await tx.contact.update({
        where: { id: source.id },
        data: {
          ...sourceFields,
          status: "ACTIVE",
          mergedIntoContactId: null,
          deletedAt: null,
          version: { increment: 1 },
        },
      });
      const now = await crmNow(tx);
      const updated = await tx.identityMergeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "REVERSED",
          reversedByAdminUserId: audit.actorAdminUserId,
          reversedAt: now,
          resolutionNote: note,
          version: { increment: 1 },
        },
      });
      await crmLog(
        tx,
        audit,
        "CRM_CONTACT_MERGE_REVERSED",
        "IdentityMergeCandidate",
        candidate.id,
        {
          sourceContactId: restoredSource.id,
          targetContactId: restoredTarget.id,
        },
      );
      return { candidate: updated, sourceContactId: source.id, targetContactId: target.id };
    });
  }
}
