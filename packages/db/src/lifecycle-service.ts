import { createHash } from "node:crypto";

import { maskEmail, normalizeLifecycleSteps, type LifecycleStepInput } from "@mundonettech/core";

import {
  cancelLifecycleEnrollment,
  suppressCustomerLifecycleTopicInTransaction,
  type LifecycleCancellationReason,
} from "./lifecycle-cancellation.js";
import {
  LifecycleError,
  databaseNow,
  lifecycleActor,
  lifecycleDescription,
  lifecycleLog,
  lifecycleName,
  lifecycleReader,
  lifecycleVersion,
  type LifecycleAudit,
} from "./lifecycle-shared.js";
import {
  Prisma,
  type LifecycleEnrollmentStatus,
  type LifecycleMessage,
} from "./generated/client.js";
import { retryableLockDivergenceError } from "./crm-shared.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import type { DatabaseExecutor } from "./primitives.js";
import { marketingEmailConsentGranted } from "./growth-service.js";
import { SegmentationService } from "./segmentation-service.js";

export interface LifecycleJourneyInput {
  readonly name: string;
  readonly description?: string | null;
  readonly segmentId: string;
  readonly steps: unknown;
}

export interface LifecycleJourneyMutation extends LifecycleJourneyInput {
  readonly journeyId: string;
  readonly expectedVersion: number;
}

export type LifecycleEligibilityReason =
  | "ELIGIBLE"
  | "MISSING"
  | "PAUSED"
  | "JOURNEY_ARCHIVED"
  | "ENROLLMENT_INACTIVE"
  | "CUSTOMER_INACTIVE"
  | "CONSENT_REVOKED"
  | "SEGMENT_EXITED"
  | "SUPPRESSED";

function stepsInput(value: unknown): LifecycleStepInput[] {
  try {
    return normalizeLifecycleSteps(value);
  } catch (error) {
    throw new LifecycleError(
      "VALIDATION",
      error instanceof Error ? error.message : "Invalid lifecycle steps.",
    );
  }
}

function stepData(steps: readonly LifecycleStepInput[]) {
  return steps.map((step) => ({
    position: step.position,
    offsetMinutes: step.offsetMinutes,
    subject: step.subject,
    htmlBody: step.htmlBody,
    textBody: step.textBody,
    variables: [...step.variables],
  }));
}

function storedSteps(value: unknown): LifecycleStepInput[] {
  if (!Array.isArray(value))
    throw new LifecycleError("CONFLICT", "Stored journey steps are invalid.");
  return stepsInput(
    value.map((step) => {
      if (typeof step !== "object" || step === null) return step;
      const record = step as Record<string, unknown>;
      return {
        position: record.position,
        offsetMinutes: record.offsetMinutes,
        subject: record.subject,
        htmlBody: record.htmlBody,
        textBody: record.textBody,
        variables: record.variables,
      };
    }),
  );
}

function consentRevocationReason(reason: LifecycleEligibilityReason): LifecycleCancellationReason {
  switch (reason) {
    case "JOURNEY_ARCHIVED":
      return "JOURNEY_ARCHIVED";
    case "CUSTOMER_INACTIVE":
      return "CUSTOMER_INACTIVE";
    case "SEGMENT_EXITED":
      return "SEGMENT_EXITED";
    case "SUPPRESSED":
      return "SUPPRESSED";
    default:
      return "CONSENT_REVOKED";
  }
}

export class LifecycleService {
  constructor(private readonly db: DatabaseExecutor) {}

  private input(input: LifecycleJourneyInput) {
    assertUuid(input.segmentId, "segmentId");
    return {
      name: lifecycleName(input.name),
      description: lifecycleDescription(input.description),
      segmentId: input.segmentId,
      steps: stepsInput(input.steps),
    };
  }

  private async assertSegment(tx: Prisma.TransactionClient, segmentId: string, active: boolean) {
    const segment = await tx.customerSegment.findUnique({ where: { id: segmentId } });
    if (!segment) throw new LifecycleError("NOT_FOUND", "Customer segment not found.");
    if (segment.status === "ARCHIVED") {
      throw new LifecycleError("CONFLICT", "Archived segments cannot be assigned to a journey.");
    }
    if (active && segment.status !== "ACTIVE") {
      throw new LifecycleError("CONFLICT", "A lifecycle journey requires an active segment.");
    }
    return segment;
  }

  async createJourney(input: LifecycleJourneyInput, audit: LifecycleAudit) {
    const values = this.input(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`customer-segment:${values.segmentId}`]);
      await this.assertSegment(tx, values.segmentId, false);
      const journey = await tx.lifecycleJourney.create({
        data: {
          name: values.name,
          description: values.description,
          segmentId: values.segmentId,
          createdByAdminUserId: audit.actorAdminUserId,
          updatedByAdminUserId: audit.actorAdminUserId,
          steps: { create: stepData(values.steps) },
        },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      await lifecycleLog(tx, audit, "LIFECYCLE_JOURNEY_CREATED", "LifecycleJourney", journey.id, {
        version: journey.version,
        steps: journey.steps.length,
      });
      return journey;
    });
  }

  async updateJourney(input: LifecycleJourneyMutation, audit: LifecycleAudit) {
    assertUuid(input.journeyId, "journeyId");
    lifecycleVersion(input.expectedVersion);
    const values = this.input(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [
        `customer-segment:${values.segmentId}`,
        `lifecycle-journey:${input.journeyId}`,
      ]);
      const current = await tx.lifecycleJourney.findUnique({ where: { id: input.journeyId } });
      if (!current) throw new LifecycleError("NOT_FOUND", "Lifecycle journey not found.");
      if (current.status !== "DRAFT" || current.version !== input.expectedVersion) {
        throw new LifecycleError("CONFLICT", "The journey changed or is no longer a draft.");
      }
      await this.assertSegment(tx, values.segmentId, false);
      await tx.lifecycleStep.deleteMany({ where: { journeyId: current.id } });
      const journey = await tx.lifecycleJourney.update({
        where: { id: current.id },
        data: {
          name: values.name,
          description: values.description,
          segmentId: values.segmentId,
          version: { increment: 1 },
          updatedByAdminUserId: audit.actorAdminUserId,
          steps: { create: stepData(values.steps) },
        },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      await lifecycleLog(tx, audit, "LIFECYCLE_JOURNEY_UPDATED", "LifecycleJourney", journey.id, {
        previousVersion: input.expectedVersion,
        version: journey.version,
        steps: journey.steps.length,
      });
      return journey;
    });
  }

  async transitionJourney(
    input: {
      journeyId: string;
      expectedVersion: number;
      action: "ACTIVATE" | "PAUSE" | "RESUME" | "ARCHIVE";
    },
    audit: LifecycleAudit,
  ) {
    assertUuid(input.journeyId, "journeyId");
    lifecycleVersion(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      const peek = await tx.lifecycleJourney.findUnique({
        where: { id: input.journeyId },
        select: { segmentId: true },
      });
      if (!peek) throw new LifecycleError("NOT_FOUND", "Lifecycle journey not found.");
      const locks = [
        `lifecycle-journey:${input.journeyId}`,
        `customer-segment:${peek.segmentId}`,
      ].sort();
      await acquireOperationLocks(tx, locks);
      const current = await tx.lifecycleJourney.findUnique({
        where: { id: input.journeyId },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      if (!current) throw new LifecycleError("NOT_FOUND", "Lifecycle journey not found.");
      if (current.segmentId !== peek.segmentId) {
        throw new LifecycleError("CONFLICT", "The journey segment changed concurrently.");
      }
      if (current.version !== input.expectedVersion || current.status === "ARCHIVED") {
        throw new LifecycleError("CONFLICT", "The journey changed or is already archived.");
      }
      const expectedStatus = {
        ACTIVATE: "DRAFT",
        PAUSE: "ACTIVE",
        RESUME: "PAUSED",
        ARCHIVE: current.status,
      }[input.action];
      if (current.status !== expectedStatus) {
        throw new LifecycleError("CONFLICT", "The requested journey transition is not valid.");
      }
      const now = await databaseNow(tx);
      let segmentVersion = current.segmentVersion;
      if (input.action === "ACTIVATE") {
        storedSteps(current.steps);
        const segment = await this.assertSegment(tx, current.segmentId, true);
        segmentVersion = segment.version;
      }
      const status = {
        ACTIVATE: "ACTIVE",
        PAUSE: "PAUSED",
        RESUME: "ACTIVE",
        ARCHIVE: "ARCHIVED",
      }[input.action] as "ACTIVE" | "PAUSED" | "ARCHIVED";
      const journey = await tx.lifecycleJourney.update({
        where: { id: current.id },
        data: {
          status,
          version: { increment: 1 },
          updatedByAdminUserId: audit.actorAdminUserId,
          ...(input.action === "ACTIVATE" ? { segmentVersion, activatedAt: now } : {}),
          ...(input.action === "ARCHIVE" ? { archivedAt: now } : {}),
        },
      });
      let cancelled = 0;
      if (input.action === "RESUME") {
        const deferredEmails = await tx.emailEvent.findMany({
          where: {
            lifecycleMessage: {
              enrollment: { journeyId: current.id, status: "ACTIVE" },
            },
            status: { in: ["QUEUED", "SENDING"] },
            lastError: null,
            nextAttemptAt: { gt: now },
          },
          select: { id: true },
        });
        if (deferredEmails.length > 0) {
          const emailIds = deferredEmails.map((item) => item.id);
          await tx.emailEvent.updateMany({
            where: { id: { in: emailIds }, status: { in: ["QUEUED", "SENDING"] }, lastError: null },
            data: { nextAttemptAt: now },
          });
          await tx.domainOutbox.updateMany({
            where: {
              eventType: "email.requested.v1",
              aggregateType: "EmailEvent",
              aggregateId: { in: emailIds },
              processedAt: null,
              failedAt: null,
              claimedBy: null,
              availableAt: { gt: now },
            },
            data: { availableAt: now },
          });
        }
      }
      if (input.action === "ARCHIVE") {
        const enrollments = await tx.lifecycleEnrollment.findMany({
          where: { journeyId: current.id, status: "ACTIVE" },
          select: { id: true, customerId: true },
          orderBy: { id: "asc" },
        });
        if (enrollments.length > 0) {
          await acquireOperationLocks(
            tx,
            enrollments.map((enrollment) => `growth-customer:${enrollment.customerId}`),
          );
        }
        for (const enrollment of enrollments) {
          if (await cancelLifecycleEnrollment(tx, enrollment.id, now, "JOURNEY_ARCHIVED")) {
            cancelled += 1;
          }
        }
      }
      await lifecycleLog(
        tx,
        audit,
        `LIFECYCLE_JOURNEY_${input.action}D`,
        "LifecycleJourney",
        journey.id,
        {
          previousVersion: input.expectedVersion,
          version: journey.version,
          cancelled,
        },
      );
      return { ...journey, cancelled };
    });
  }

  async listJourneys(actorAdminUserId: string, options: { cursor?: string; limit?: number } = {}) {
    await lifecycleReader(this.db, actorAdminUserId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new LifecycleError("VALIDATION", "limit must be between 1 and 100.");
    }
    if (options.cursor) assertUuid(options.cursor, "cursor");
    const journeys = await this.db.lifecycleJourney.findMany({
      where: options.cursor ? { id: { gt: options.cursor } } : {},
      include: {
        segment: { select: { name: true, status: true } },
        _count: { select: { steps: true, enrollments: true } },
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = journeys.slice(0, limit);
    return {
      items: page,
      nextCursor: journeys.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getJourneyDetail(actorAdminUserId: string, journeyId: string) {
    await lifecycleReader(this.db, actorAdminUserId);
    assertUuid(journeyId, "journeyId");
    const journey = await this.db.lifecycleJourney.findUnique({
      where: { id: journeyId },
      include: {
        segment: true,
        steps: { orderBy: { position: "asc" } },
        enrollments: {
          include: {
            customer: { select: { email: true, status: true } },
            messages: {
              include: {
                step: { select: { position: true } },
                emailEvent: { select: { status: true } },
              },
              orderBy: { scheduledAt: "asc" },
            },
          },
          orderBy: [{ enteredAt: "desc" }, { id: "desc" }],
          take: 100,
        },
      },
    });
    if (!journey) throw new LifecycleError("NOT_FOUND", "Lifecycle journey not found.");
    return {
      ...journey,
      steps: storedSteps(journey.steps),
      enrollments: journey.enrollments.map((enrollment) => ({
        ...enrollment,
        customer: undefined,
        customerEmail:
          enrollment.customer.status === "ANONYMIZED"
            ? "Cuenta anonimizada"
            : maskEmail(enrollment.customer.email),
      })),
    };
  }

  private async enrollForJourney(journeyId: string, limit: number) {
    return inInventoryTransaction(this.db, async (tx) => {
      const peek = await tx.lifecycleJourney.findUnique({
        where: { id: journeyId },
        select: { segmentId: true },
      });
      if (!peek) return { enrolled: 0 };
      await acquireOperationLocks(tx, [
        `customer-segment:${peek.segmentId}`,
        `lifecycle-journey:${journeyId}`,
      ]);
      const journey = await tx.lifecycleJourney.findUnique({
        where: { id: journeyId },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      if (!journey || journey.status !== "ACTIVE" || journey.segmentVersion === null) {
        return { enrolled: 0 };
      }
      if (journey.segmentId !== peek.segmentId) {
        throw retryableLockDivergenceError("The lifecycle journey segment changed concurrently.");
      }
      if (journey.steps.length === 0) {
        throw new LifecycleError("CONFLICT", "An active journey has no steps.");
      }
      const segment = await tx.customerSegment.findUnique({
        where: { id: journey.segmentId },
        select: { status: true, version: true },
      });
      if (!segment || segment.status !== "ACTIVE" || segment.version !== journey.segmentVersion) {
        return { enrolled: 0 };
      }
      const initialCandidates = await tx.$queryRaw<Array<{ customerId: string }>>`
        WITH latest AS (
          SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
          FROM "CustomerSegmentMembership" membership
          WHERE membership."segmentId" = ${journey.segmentId}::uuid
          ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
        )
        SELECT latest."customerId"
        FROM latest
        JOIN "Customer" customer ON customer."id" = latest."customerId" AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
        JOIN "Consent" consent ON consent."id" = latest."consentId" AND consent."status" = 'GRANTED'
        WHERE latest."status" = 'ENTERED' AND latest."segmentVersion" = ${journey.segmentVersion}::int
          AND NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id")
          AND NOT EXISTS (
            SELECT 1 FROM "EmailSuppression" suppression
            WHERE suppression."recipientHash" = digest(customer."email"::text, 'sha256'::text) AND suppression."topic" = 'lifecycle'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "LifecycleEnrollment" enrollment
            WHERE enrollment."journeyId" = ${journey.id}::uuid AND enrollment."customerId" = latest."customerId"
          )
        ORDER BY latest."customerId" LIMIT ${limit}::int
      `;
      const lockedCustomerIds = initialCandidates.map((row) => row.customerId);
      if (lockedCustomerIds.length === 0) {
        return { enrolled: 0 };
      }
      await acquireOperationLocks(
        tx,
        lockedCustomerIds.map((id) => `growth-customer:${id}`),
      );
      const candidates = await tx.$queryRaw<
        Array<{ membershipId: string; customerId: string; consentId: string }>
      >`
        WITH latest AS (
          SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
          FROM "CustomerSegmentMembership" membership
          WHERE membership."segmentId" = ${journey.segmentId}::uuid
            AND membership."customerId" = ANY(${lockedCustomerIds}::uuid[])
          ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
        )
        SELECT latest."id" AS "membershipId", latest."customerId", latest."consentId"
        FROM latest
        JOIN "Customer" customer ON customer."id" = latest."customerId" AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
        JOIN "Consent" consent ON consent."id" = latest."consentId" AND consent."status" = 'GRANTED'
        WHERE latest."customerId" = ANY(${lockedCustomerIds}::uuid[])
          AND latest."status" = 'ENTERED' AND latest."segmentVersion" = ${journey.segmentVersion}::int
          AND NOT EXISTS (SELECT 1 FROM "Consent" revocation WHERE revocation."revokesId" = consent."id")
          AND NOT EXISTS (
            SELECT 1 FROM "EmailSuppression" suppression
            WHERE suppression."recipientHash" = digest(customer."email"::text, 'sha256'::text) AND suppression."topic" = 'lifecycle'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "LifecycleEnrollment" enrollment
            WHERE enrollment."journeyId" = ${journey.id}::uuid AND enrollment."customerId" = latest."customerId"
          )
        ORDER BY latest."customerId" LIMIT ${limit}::int
      `;
      const now = await databaseNow(tx);
      for (const candidate of candidates) {
        const enrollment = await tx.lifecycleEnrollment.create({
          data: {
            journeyId: journey.id,
            customerId: candidate.customerId,
            entryMembershipId: candidate.membershipId,
            consentId: candidate.consentId,
            enteredAt: now,
          },
        });
        await tx.lifecycleMessage.createMany({
          data: journey.steps.map((step) => ({
            enrollmentId: enrollment.id,
            stepId: step.id,
            customerId: candidate.customerId,
            scheduledAt: new Date(now.getTime() + step.offsetMinutes * 60_000),
          })),
        });
        await tx.domainOutbox.create({
          data: {
            eventType: "lifecycle.enrollment.started.v1",
            aggregateType: "LifecycleEnrollment",
            aggregateId: enrollment.id,
            deduplicationKey: `lifecycle:enrollment:${enrollment.id}:started:v1`,
            payload: { enrollmentId: enrollment.id, journeyId: journey.id },
          },
        });
      }
      return { enrolled: candidates.length };
    });
  }

  private async messageWithRelations(tx: DatabaseExecutor, messageId: string) {
    return tx.lifecycleMessage.findUnique({
      where: { id: messageId },
      include: {
        step: true,
        customer: true,
        enrollment: { include: { journey: true, entryMembership: true } },
      },
    });
  }

  private async eligibilityInTransaction(
    tx: DatabaseExecutor,
    messageId: string,
  ): Promise<{ reason: LifecycleEligibilityReason; enrollmentId: string | null }> {
    const message = await this.messageWithRelations(tx, messageId);
    if (!message) return { reason: "MISSING", enrollmentId: null };
    const enrollment = message.enrollment;
    if (enrollment.journey.status === "PAUSED") {
      return { reason: "PAUSED", enrollmentId: enrollment.id };
    }
    if (enrollment.journey.status === "ARCHIVED") {
      return { reason: "JOURNEY_ARCHIVED", enrollmentId: enrollment.id };
    }
    if (enrollment.status !== "ACTIVE") {
      return { reason: "ENROLLMENT_INACTIVE", enrollmentId: enrollment.id };
    }
    if (message.customer.status !== "ACTIVE" || message.customer.deletedAt !== null) {
      return { reason: "CUSTOMER_INACTIVE", enrollmentId: enrollment.id };
    }
    if (!(await marketingEmailConsentGranted(tx, message.customerId))) {
      return { reason: "CONSENT_REVOKED", enrollmentId: enrollment.id };
    }
    const latestMembership = await tx.customerSegmentMembership.findFirst({
      where: {
        segmentId: enrollment.entryMembership.segmentId,
        customerId: message.customerId,
      },
      orderBy: { sequence: "desc" },
      select: { id: true, status: true },
    });
    if (
      latestMembership?.id !== enrollment.entryMembershipId ||
      latestMembership.status !== "ENTERED"
    ) {
      return { reason: "SEGMENT_EXITED", enrollmentId: enrollment.id };
    }
    const recipientHash = createHash("sha256").update(message.customer.email).digest();
    const suppression = await tx.emailSuppression.findUnique({
      where: { recipientHash_topic: { recipientHash, topic: "lifecycle" } },
      select: { id: true },
    });
    if (suppression) return { reason: "SUPPRESSED", enrollmentId: enrollment.id };
    return { reason: "ELIGIBLE", enrollmentId: enrollment.id };
  }

  async messageEligibility(messageId: string) {
    assertUuid(messageId, "messageId");
    return this.eligibilityInTransaction(this.db, messageId);
  }

  private async lockMessageChain(
    tx: Prisma.TransactionClient,
    messageId: string,
  ): Promise<{
    readonly enrollment: { readonly id: string; readonly status: LifecycleEnrollmentStatus };
    readonly message: LifecycleMessage;
  } | null> {
    const peek = await tx.lifecycleMessage.findUnique({
      where: { id: messageId },
      select: { id: true, customerId: true, enrollmentId: true },
    });
    if (!peek) return null;
    await acquireOperationLocks(tx, [`growth-customer:${peek.customerId}`]);
    const enrollments = await tx.$queryRaw<
      Array<{ id: string; status: LifecycleEnrollmentStatus }>
    >`
      SELECT "id", "status"::text AS "status"
      FROM "LifecycleEnrollment"
      WHERE "id" = ${peek.enrollmentId}::uuid
      FOR UPDATE
    `;
    const enrollment = enrollments[0];
    if (!enrollment) return null;
    const messages = await tx.$queryRaw<LifecycleMessage[]>`
      SELECT * FROM "LifecycleMessage" WHERE "id" = ${messageId}::uuid FOR UPDATE
    `;
    const message = messages[0];
    if (!message) return null;
    return { enrollment, message };
  }

  async dispatchDueMessages(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new LifecycleError("VALIDATION", "Dispatch limit must be between 1 and 500.");
    }
    const now = await databaseNow(this.db);
    const result = { dispatched: 0, cancelled: 0, held: 0 };
    const attempted = new Set<string>();
    while (
      result.dispatched + result.cancelled + result.held < limit &&
      attempted.size < limit * 2
    ) {
      const remaining = limit - (result.dispatched + result.cancelled + result.held);
      const candidates = await this.db.lifecycleMessage.findMany({
        where: {
          status: "SCHEDULED",
          scheduledAt: { lte: now },
          enrollment: { status: "ACTIVE", journey: { status: "ACTIVE" } },
          customer: { status: "ACTIVE", deletedAt: null },
          ...(attempted.size > 0 ? { id: { notIn: [...attempted] } } : {}),
        },
        select: { id: true, customerId: true, enrollmentId: true },
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        take: remaining,
      });
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        attempted.add(candidate.id);
        try {
          const outcome = await inInventoryTransaction(this.db, async (tx) => {
            const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
              SELECT pg_try_advisory_xact_lock(hashtextextended(${`growth-customer:${candidate.customerId}`}, 0)) AS locked
            `;
            if (!lockRows[0]?.locked) return "SKIPPED" as const;
            const enrollmentRows = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "LifecycleEnrollment"
              WHERE "id" = ${candidate.enrollmentId}::uuid
              FOR UPDATE SKIP LOCKED
            `;
            if (!enrollmentRows[0]) return "SKIPPED" as const;
            const messageRows = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "LifecycleMessage"
              WHERE "id" = ${candidate.id}::uuid
              FOR UPDATE SKIP LOCKED
            `;
            if (!messageRows[0]) return "SKIPPED" as const;
            const eligibility = await this.eligibilityInTransaction(tx, candidate.id);
            if (eligibility.reason === "PAUSED") return "HELD" as const;
            if (eligibility.reason === "MISSING" || eligibility.reason === "ENROLLMENT_INACTIVE") {
              return "HELD" as const;
            }
            if (eligibility.reason !== "ELIGIBLE") {
              if (eligibility.enrollmentId) {
                await cancelLifecycleEnrollment(
                  tx,
                  eligibility.enrollmentId,
                  await databaseNow(tx),
                  consentRevocationReason(eligibility.reason),
                );
                return "CANCELLED" as const;
              }
              return "HELD" as const;
            }
            const claimed = await tx.lifecycleMessage.updateMany({
              where: { id: candidate.id, status: "SCHEDULED", scheduledAt: { lte: now } },
              data: { status: "DISPATCHING", dispatchVersion: { increment: 1 } },
            });
            if (claimed.count === 0) return "HELD" as const;
            const dispatch = await tx.lifecycleMessage.findUniqueOrThrow({
              where: { id: candidate.id },
              select: { dispatchVersion: true },
            });
            await tx.domainOutbox.create({
              data: {
                eventType: "lifecycle.message.dispatch.v1",
                aggregateType: "LifecycleMessage",
                aggregateId: candidate.id,
                deduplicationKey: `lifecycle:message:${candidate.id}:dispatch:v${dispatch.dispatchVersion}`,
                payload: {
                  lifecycleMessageId: candidate.id,
                  dispatchVersion: dispatch.dispatchVersion,
                },
              },
            });
            return "DISPATCHED" as const;
          });
          if (outcome === "DISPATCHED") result.dispatched += 1;
          if (outcome === "CANCELLED") result.cancelled += 1;
          if (outcome === "HELD") result.held += 1;
        } catch {
          continue;
        }
      }
    }
    return result;
  }

  private async enrollDueJourneys(limit: number): Promise<number> {
    let enrolled = 0;
    let cursor: string | null = null;
    for (;;) {
      const journeys: Array<{ id: string }> = await this.db.lifecycleJourney.findMany({
        where: { status: "ACTIVE", ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 20,
      });
      for (const journey of journeys) {
        enrolled += (await this.enrollForJourney(journey.id, limit)).enrolled;
      }
      if (journeys.length < 20) return enrolled;
      cursor = journeys[journeys.length - 1]!.id;
    }
  }

  async runScheduledWork(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new LifecycleError("VALIDATION", "Lifecycle batch limit must be between 1 and 500.");
    }
    const segments = await new SegmentationService(this.db).refreshActiveSegments(20);
    const enrolled = await this.enrollDueJourneys(limit);
    const messages = await this.dispatchDueMessages(limit);
    return { segments, enrolled, ...messages };
  }

  async dispatch(messageId: string, dispatchVersion?: number) {
    assertUuid(messageId, "messageId");
    if (
      dispatchVersion !== undefined &&
      (!Number.isInteger(dispatchVersion) || dispatchVersion < 1)
    ) {
      throw new LifecycleError("VALIDATION", "dispatchVersion must be a positive integer.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) return null;
      const message = await this.messageWithRelations(tx, messageId);
      if (
        !message ||
        (dispatchVersion !== undefined && message.dispatchVersion !== dispatchVersion)
      ) {
        return null;
      }
      const eligibility = await this.eligibilityInTransaction(tx, messageId);
      const now = await databaseNow(tx);
      if (eligibility.reason === "PAUSED") {
        await tx.lifecycleMessage.updateMany({
          where: {
            id: messageId,
            status: "DISPATCHING",
            ...(dispatchVersion !== undefined ? { dispatchVersion } : {}),
          },
          data: { status: "SCHEDULED" },
        });
        return null;
      }
      if (eligibility.reason !== "ELIGIBLE") {
        if (eligibility.enrollmentId && eligibility.reason !== "ENROLLMENT_INACTIVE") {
          await cancelLifecycleEnrollment(
            tx,
            eligibility.enrollmentId,
            now,
            consentRevocationReason(eligibility.reason),
          );
        }
        return null;
      }
      if (message.status !== "DISPATCHING") return null;
      return {
        id: message.id,
        customerId: message.customerId,
        recipientEmail: message.customer.email,
        customerFirstName: message.customer.givenName ?? "",
        step: {
          subject: message.step.subject,
          htmlBody: message.step.htmlBody,
          textBody: message.step.textBody,
          variables: message.step.variables as string[],
        },
      };
    });
  }

  async markQueued(messageId: string, emailEventId: string, emailStatus: string) {
    assertUuid(messageId, "messageId");
    assertUuid(emailEventId, "emailEventId");
    const validStatuses = new Set([
      "QUEUED",
      "SENDING",
      "SENT",
      "DELIVERY_DELAYED",
      "DELIVERED",
      "SUPPRESSED",
      "BOUNCED",
      "COMPLAINED",
      "CANCELLED",
      "FAILED",
    ]);
    if (!validStatuses.has(emailStatus)) {
      throw new LifecycleError("VALIDATION", "Lifecycle email queue outcome is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) {
        const emailCheck = await tx.emailEvent.findUnique({ where: { id: emailEventId } });
        if (!emailCheck || emailCheck.lifecycleMessageId !== messageId) {
          throw new LifecycleError(
            "CONFLICT",
            "Email event does not belong to the lifecycle message.",
          );
        }
        throw new LifecycleError("NOT_FOUND", "Lifecycle message not found.");
      }
      const { enrollment, message } = locked;
      const email = await tx.emailEvent.findUnique({ where: { id: emailEventId } });
      if (!email || email.lifecycleMessageId !== messageId) {
        throw new LifecycleError(
          "CONFLICT",
          "Email event does not belong to the lifecycle message.",
        );
      }
      const effectiveStatus = email.status;
      const now = await databaseNow(tx);
      if (["SUPPRESSED", "BOUNCED", "COMPLAINED"].includes(effectiveStatus)) {
        await tx.lifecycleMessage.updateMany({
          where: { id: messageId, status: { in: ["DISPATCHING", "QUEUED"] } },
          data: { status: "SUPPRESSED", processedAt: now },
        });
        await suppressCustomerLifecycleTopicInTransaction(
          tx,
          message.customerId,
          now,
          "SUPPRESSED",
        );
        return "SUPPRESSED" as const;
      }
      if (effectiveStatus === "CANCELLED") {
        await tx.lifecycleMessage.updateMany({
          where: { id: messageId, status: { in: ["SCHEDULED", "DISPATCHING", "QUEUED"] } },
          data: { status: "CANCELLED", processedAt: now },
        });
        await cancelLifecycleEnrollment(tx, message.enrollmentId, now, "CUSTOMER_INACTIVE");
        return "CANCELLED" as const;
      }
      if (effectiveStatus === "FAILED") {
        const failed = await tx.lifecycleMessage.updateMany({
          where: { id: messageId, status: { in: ["DISPATCHING", "QUEUED"] } },
          data: {
            status: "FAILED",
            processedAt: now,
            lastError: (email.lastError ?? "PROVIDER_FAILURE").slice(0, 500),
          },
        });
        if (failed.count === 1) {
          await tx.lifecycleEnrollment.updateMany({
            where: { id: message.enrollmentId, status: "ACTIVE" },
            data: { status: "FAILED", failedAt: now, exitReason: "DELIVERY_FAILED" },
          });
          await tx.lifecycleMessage.updateMany({
            where: {
              enrollmentId: message.enrollmentId,
              status: { in: ["SCHEDULED", "DISPATCHING"] },
            },
            data: { status: "CANCELLED", processedAt: now },
          });
        }
        return "FAILED" as const;
      }
      if (enrollment.status !== "ACTIVE") {
        if (message.status === "SUPPRESSED") return "SUPPRESSED" as const;
        if (message.status === "FAILED") return "FAILED" as const;
        return "CANCELLED" as const;
      }
      const queued = await tx.lifecycleMessage.updateMany({
        where: { id: messageId, status: "DISPATCHING", enrollment: { status: "ACTIVE" } },
        data: { status: "QUEUED", processedAt: now },
      });
      if (
        (queued.count === 1 || message.status === "QUEUED") &&
        ["SENT", "DELIVERY_DELAYED", "DELIVERED"].includes(effectiveStatus)
      ) {
        await new LifecycleService(tx).markEmailSent(messageId, email.id);
      }
      return "QUEUED" as const;
    });
  }

  async markEmailSent(messageId: string, emailEventId: string): Promise<boolean> {
    assertUuid(messageId, "messageId");
    assertUuid(emailEventId, "emailEventId");
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) return false;
      const { enrollment, message } = locked;
      const email = await tx.emailEvent.findUnique({ where: { id: emailEventId } });
      if (
        !email ||
        email.lifecycleMessageId !== messageId ||
        !["SENT", "DELIVERY_DELAYED", "DELIVERED"].includes(email.status)
      ) {
        return false;
      }
      if (message.status !== "QUEUED" || enrollment.status !== "ACTIVE") {
        return false;
      }
      const [remainingMessages, pendingEmails] = await Promise.all([
        tx.lifecycleMessage.count({
          where: { enrollmentId: message.enrollmentId, status: { not: "QUEUED" } },
        }),
        tx.emailEvent.count({
          where: {
            lifecycleMessage: { enrollmentId: message.enrollmentId },
            status: { notIn: ["SENT", "DELIVERY_DELAYED", "DELIVERED"] },
          },
        }),
      ]);
      if (remainingMessages > 0 || pendingEmails > 0) return false;
      const completed = await tx.lifecycleEnrollment.updateMany({
        where: { id: message.enrollmentId, status: "ACTIVE" },
        data: { status: "COMPLETED", completedAt: await databaseNow(tx) },
      });
      return completed.count === 1;
    });
  }

  async markEmailFailed(messageId: string, emailEventId: string, error: string): Promise<boolean> {
    assertUuid(messageId, "messageId");
    assertUuid(emailEventId, "emailEventId");
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) return false;
      const { message } = locked;
      const email = await tx.emailEvent.findUnique({ where: { id: emailEventId } });
      if (!email || email.lifecycleMessageId !== messageId || email.status !== "FAILED")
        return false;
      if (message.status !== "QUEUED") return false;
      const now = await databaseNow(tx);
      await tx.lifecycleEnrollment.updateMany({
        where: { id: message.enrollmentId, status: "ACTIVE" },
        data: { status: "FAILED", failedAt: now, exitReason: "DELIVERY_FAILED" },
      });
      await tx.lifecycleMessage.updateMany({
        where: { id: messageId, status: "QUEUED" },
        data: { status: "FAILED", processedAt: now, lastError: error.slice(0, 500) },
      });
      await tx.lifecycleMessage.updateMany({
        where: { enrollmentId: message.enrollmentId, status: { in: ["SCHEDULED", "DISPATCHING"] } },
        data: { status: "CANCELLED", processedAt: now },
      });
      return true;
    });
  }

  async markDispatchFailed(messageId: string, error: string) {
    assertUuid(messageId, "messageId");
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) return false;
      const { message } = locked;
      if (message.status !== "DISPATCHING") return false;
      const now = await databaseNow(tx);
      await tx.lifecycleEnrollment.updateMany({
        where: { id: message.enrollmentId, status: "ACTIVE" },
        data: { status: "FAILED", failedAt: now, exitReason: "DELIVERY_DISPATCH_FAILED" },
      });
      await tx.lifecycleMessage.updateMany({
        where: { id: messageId, status: "DISPATCHING" },
        data: { status: "FAILED", processedAt: now, lastError: error.slice(0, 500) },
      });
      await tx.lifecycleMessage.updateMany({
        where: { enrollmentId: message.enrollmentId, status: { in: ["SCHEDULED", "DISPATCHING"] } },
        data: { status: "CANCELLED", processedAt: now },
      });
      await tx.emailEvent.updateMany({
        where: { lifecycleMessageId: messageId, status: { in: ["QUEUED", "SENDING"] } },
        data: { status: "CANCELLED", statusRank: 70, finalAt: now, nextAttemptAt: null },
      });
      return true;
    });
  }

  async deferEmailIfPaused(messageId: string): Promise<Date | null> {
    assertUuid(messageId, "messageId");
    const eligibility = await this.eligibilityInTransaction(this.db, messageId);
    if (eligibility.reason !== "PAUSED") return null;
    const now = await databaseNow(this.db);
    return new Date(now.getTime() + 5 * 60_000);
  }

  async markEmailSuppressed(messageId: string, reason: LifecycleCancellationReason) {
    assertUuid(messageId, "messageId");
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await this.lockMessageChain(tx, messageId);
      if (!locked) return;
      const { message } = locked;
      const now = await databaseNow(tx);
      if (["QUEUED", "DISPATCHING"].includes(message.status)) {
        await tx.lifecycleMessage.updateMany({
          where: { id: messageId, status: { in: ["QUEUED", "DISPATCHING"] } },
          data: { status: "SUPPRESSED", processedAt: now },
        });
      } else if (message.status === "SCHEDULED") {
        await tx.lifecycleMessage.updateMany({
          where: { id: messageId, status: "SCHEDULED" },
          data: { status: "CANCELLED", processedAt: now },
        });
      }
      await cancelLifecycleEnrollment(tx, message.enrollmentId, now, reason);
      if (
        reason === "SUPPRESSED" ||
        reason === "CONSENT_REVOKED" ||
        reason === "CUSTOMER_INACTIVE"
      ) {
        await suppressCustomerLifecycleTopicInTransaction(tx, message.customerId, now, reason);
      }
    });
  }

  async suppressCustomerTopic(
    customerId: string,
    reason: "SUPPRESSED" | "CONSENT_REVOKED" | "CUSTOMER_INACTIVE" = "SUPPRESSED",
  ): Promise<number> {
    assertUuid(customerId, "customerId");
    return inInventoryTransaction(this.db, async (tx) =>
      suppressCustomerLifecycleTopicInTransaction(tx, customerId, await databaseNow(tx), reason),
    );
  }
}
