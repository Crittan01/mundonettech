import type { LifecycleEnrollmentStatus, Prisma } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";

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
  const enrollment = await tx.lifecycleEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, status: true },
  });
  if (!enrollment) return false;
  if (enrollment.status !== ("ACTIVE" satisfies LifecycleEnrollmentStatus)) return false;
  await tx.emailEvent.updateMany({
    where: {
      lifecycleMessage: { enrollmentId },
      status: { in: ["QUEUED", "SENDING"] },
    },
    data: { status: "CANCELLED", statusRank: 70, finalAt: now, nextAttemptAt: null },
  });
  await tx.lifecycleMessage.updateMany({
    where: { enrollmentId, status: { in: ["SCHEDULED", "DISPATCHING", "QUEUED"] } },
    data: { status: "CANCELLED", processedAt: now, lastError: null },
  });
  await tx.lifecycleEnrollment.update({
    where: { id: enrollmentId },
    data: { status: "CANCELLED", exitReason: reason, cancelledAt: now },
  });
  return true;
}

export async function suppressLifecycleCustomerInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  now: Date,
): Promise<void> {
  assertUuid(customerId, "customerId");
  const enrollments = await tx.lifecycleEnrollment.findMany({
    where: { customerId, status: "ACTIVE" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const enrollment of enrollments) {
    await cancelLifecycleEnrollment(tx, enrollment.id, now, "ANONYMIZED");
  }
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
