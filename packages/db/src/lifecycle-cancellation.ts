import type { LifecycleEnrollmentStatus, Prisma } from "./generated/client.js";
import { acquireOperationLocks, assertUuid } from "./inventory-shared.js";

export type LifecycleCancellationReason =
  | "CONSENT_REVOKED"
  | "CUSTOMER_INACTIVE"
  | "SEGMENT_EXITED"
  | "SEGMENT_ARCHIVED"
  | "JOURNEY_ARCHIVED"
  | "SUPPRESSED"
  | "ANONYMIZED";

export async function cancelLifecycleEnrollment(
  tx: Prisma.TransactionClient,
  enrollmentId: string,
  now: Date,
  reason: LifecycleCancellationReason,
): Promise<boolean> {
  assertUuid(enrollmentId, "enrollmentId");
  const peek = await tx.lifecycleEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, customerId: true },
  });
  if (!peek) return false;
  await acquireOperationLocks(tx, [`growth-customer:${peek.customerId}`]);
  const lockedEnrollments = await tx.$queryRaw<
    Array<{ id: string; status: LifecycleEnrollmentStatus }>
  >`
    SELECT "id", "status"::text AS "status"
    FROM "LifecycleEnrollment"
    WHERE "id" = ${enrollmentId}::uuid
    FOR UPDATE
  `;
  const enrollment = lockedEnrollments[0];
  if (!enrollment) return false;
  if (enrollment.status !== ("ACTIVE" satisfies LifecycleEnrollmentStatus)) return false;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LifecycleMessage"
    WHERE "enrollmentId" = ${enrollmentId}::uuid
    ORDER BY "id"
    FOR UPDATE
  `;
  const targetEmailStatus =
    reason === "SUPPRESSED" || reason === "CONSENT_REVOKED" ? "SUPPRESSED" : "CANCELLED";
  if (targetEmailStatus === "SUPPRESSED") {
    await tx.lifecycleMessage.updateMany({
      where: {
        enrollmentId,
        status: { in: ["DISPATCHING", "QUEUED"] },
        emailEvent: {
          status: { notIn: ["SENT", "DELIVERY_DELAYED", "DELIVERED"] },
        },
      },
      data: { status: "SUPPRESSED", processedAt: now, lastError: null },
    });
  }
  await tx.lifecycleMessage.updateMany({
    where: {
      enrollmentId,
      OR: [
        { status: { in: ["SCHEDULED", "DISPATCHING"] } },
        {
          status: "QUEUED",
          OR: [
            { emailEvent: null },
            { emailEvent: { status: { notIn: ["SENT", "DELIVERY_DELAYED", "DELIVERED"] } } },
          ],
        },
      ],
    },
    data: { status: "CANCELLED", processedAt: now, lastError: null },
  });
  await tx.emailEvent.updateMany({
    where: {
      lifecycleMessage: { enrollmentId },
      status: { in: ["QUEUED", "SENDING"] },
    },
    data: { status: targetEmailStatus, statusRank: 70, finalAt: now, nextAttemptAt: null },
  });
  await tx.lifecycleEnrollment.update({
    where: { id: enrollmentId },
    data: { status: "CANCELLED", exitReason: reason, cancelledAt: now },
  });
  return true;
}

export async function suppressCustomerLifecycleTopicInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  now: Date,
  reason: "SUPPRESSED" | "CONSENT_REVOKED" | "CUSTOMER_INACTIVE",
): Promise<number> {
  assertUuid(customerId, "customerId");
  await acquireOperationLocks(tx, [`growth-customer:${customerId}`]);
  const enrollments = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LifecycleEnrollment"
    WHERE "customerId" = ${customerId}::uuid AND "status" = 'ACTIVE'
    ORDER BY "id"
    FOR UPDATE
  `;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LifecycleMessage"
    WHERE "customerId" = ${customerId}::uuid AND "status" IN ('SCHEDULED', 'DISPATCHING', 'QUEUED')
    ORDER BY "id"
    FOR UPDATE
  `;
  let cancelled = 0;
  for (const enrollment of enrollments) {
    if (await cancelLifecycleEnrollment(tx, enrollment.id, now, reason)) {
      cancelled += 1;
    }
  }
  await tx.lifecycleMessage.updateMany({
    where: {
      customerId,
      status: { in: ["DISPATCHING", "QUEUED"] },
      emailEvent: { status: { in: ["QUEUED", "SENDING", "SUPPRESSED", "BOUNCED", "COMPLAINED"] } },
    },
    data: { status: "SUPPRESSED", processedAt: now, lastError: null },
  });
  await tx.emailEvent.updateMany({
    where: {
      customerId,
      templateKey: "lifecycle.campaign",
      status: { in: ["QUEUED", "SENDING"] },
    },
    data: { status: "SUPPRESSED", statusRank: 70, finalAt: now, nextAttemptAt: null },
  });
  return cancelled;
}

export async function revokeCustomerLifecycleConsentInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  now: Date,
): Promise<void> {
  assertUuid(customerId, "customerId");
  await suppressCustomerLifecycleTopicInTransaction(tx, customerId, now, "CONSENT_REVOKED");
  await tx.$executeRaw`
    WITH latest AS (
      SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
      FROM "CustomerSegmentMembership" membership
      WHERE membership."customerId" = ${customerId}::uuid
      ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
    )
    INSERT INTO "CustomerSegmentMembership" (
      "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
      "reason", "metrics", "definitionHash"
    )
    SELECT latest."segmentId", latest."customerId", latest."consentId", latest."sequence" + 1,
      segment."version", 'EXITED', 'CONSENT_REVOKED', latest."metrics", segment."definitionHash"
    FROM latest
    JOIN "CustomerSegment" segment ON segment."id" = latest."segmentId"
    WHERE latest."status" = 'ENTERED'
    ORDER BY latest."segmentId"
  `;
}

export async function suppressLifecycleCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  now: Date,
): Promise<void> {
  assertUuid(customerId, "customerId");
  await acquireOperationLocks(tx, [`growth-customer:${customerId}`]);
  const enrollments = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LifecycleEnrollment"
    WHERE "customerId" = ${customerId}::uuid AND "status" = 'ACTIVE'
    ORDER BY "id"
    FOR UPDATE
  `;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LifecycleMessage"
    WHERE "customerId" = ${customerId}::uuid AND "status" IN ('SCHEDULED', 'DISPATCHING', 'QUEUED')
    ORDER BY "id"
    FOR UPDATE
  `;
  for (const enrollment of enrollments) {
    await cancelLifecycleEnrollment(tx, enrollment.id, now, "ANONYMIZED");
  }
  await tx.lifecycleMessage.updateMany({
    where: {
      customerId,
      status: { in: ["DISPATCHING", "QUEUED"] },
      emailEvent: { status: { in: ["QUEUED", "SENDING", "SUPPRESSED", "BOUNCED", "COMPLAINED"] } },
    },
    data: { status: "SUPPRESSED", processedAt: now, lastError: null },
  });
  await tx.emailEvent.updateMany({
    where: {
      customerId,
      templateKey: "lifecycle.campaign",
      status: { in: ["QUEUED", "SENDING"] },
    },
    data: { status: "SUPPRESSED", statusRank: 70, finalAt: now, nextAttemptAt: null },
  });
  await tx.$executeRaw`
    WITH latest AS (
      SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
      FROM "CustomerSegmentMembership" membership
      WHERE membership."customerId" = ${customerId}::uuid
      ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
    )
    INSERT INTO "CustomerSegmentMembership" (
      "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
      "reason", "metrics", "definitionHash"
    )
    SELECT latest."segmentId", latest."customerId", latest."consentId", latest."sequence" + 1,
      segment."version", 'EXITED', 'ANONYMIZED', latest."metrics", segment."definitionHash"
    FROM latest
    JOIN "CustomerSegment" segment ON segment."id" = latest."segmentId"
    WHERE latest."status" = 'ENTERED'
    ORDER BY latest."segmentId"
  `;
}
