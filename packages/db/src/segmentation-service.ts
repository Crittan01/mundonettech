import { maskEmail, type CustomerSegmentDefinition } from "@mundonettech/core";

import { cancelLifecycleEnrollment } from "./lifecycle-cancellation.js";
import {
  LifecycleError,
  databaseNow,
  lifecycleActor,
  lifecycleDescription,
  lifecycleLog,
  lifecycleName,
  lifecycleReader,
  lifecycleVersion,
  normalizedSegmentDefinition,
  segmentDefinitionHash,
  type LifecycleAudit,
} from "./lifecycle-shared.js";
import { Prisma, type CustomerSegment } from "./generated/client.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import type { DatabaseExecutor } from "./primitives.js";
import { customerRfmCte } from "./rfm-analytics-service.js";

export interface CustomerSegmentInput {
  readonly name: string;
  readonly description?: string | null;
  readonly definition: unknown;
}

export interface CustomerSegmentMutation extends CustomerSegmentInput {
  readonly segmentId: string;
  readonly expectedVersion: number;
}

function definitionJson(definition: CustomerSegmentDefinition): Prisma.InputJsonObject {
  return {
    minFrequency: definition.minFrequency,
    maxFrequency: definition.maxFrequency,
    minNetLtvCents: definition.minNetLtvCents,
    maxNetLtvCents: definition.maxNetLtvCents,
    lastPurchaseWithinDays: definition.lastPurchaseWithinDays,
    lastPurchaseOlderThanDays: definition.lastPurchaseOlderThanDays,
    rfmClass: definition.rfmClass,
  };
}

function segmentView(segment: CustomerSegment) {
  return {
    id: segment.id,
    name: segment.name,
    description: segment.description,
    status: segment.status,
    definition: normalizedSegmentDefinition(segment.definition),
    version: segment.version,
    lastRefreshedAt: segment.lastRefreshedAt,
    activatedAt: segment.activatedAt,
    archivedAt: segment.archivedAt,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
  };
}

function metricsView(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LifecycleError("CONFLICT", "Stored segment metrics are invalid.");
  }
  const input = value as Record<string, unknown>;
  const scores =
    typeof input.scores === "object" && input.scores !== null && !Array.isArray(input.scores)
      ? (input.scores as Record<string, unknown>)
      : null;
  if (
    (input.recencyDays !== null && typeof input.recencyDays !== "number") ||
    typeof input.frequency !== "string" ||
    typeof input.ltvCents !== "string" ||
    typeof input.refundExcessCents !== "string" ||
    typeof input.rfmClass !== "string" ||
    !scores ||
    typeof scores.recency !== "number" ||
    typeof scores.frequency !== "number" ||
    typeof scores.monetary !== "number"
  ) {
    throw new LifecycleError("CONFLICT", "Stored segment metrics do not match their contract.");
  }
  return {
    recencyDays: input.recencyDays as number | null,
    frequency: input.frequency,
    ltvCents: input.ltvCents,
    refundExcessCents: input.refundExcessCents,
    rfmClass: input.rfmClass,
    scores: {
      recency: scores.recency,
      frequency: scores.frequency,
      monetary: scores.monetary,
    },
  };
}

function metricsSql(alias: string): Prisma.Sql {
  return Prisma.sql`jsonb_build_object(
    'recencyDays', ${Prisma.raw(`"${alias}"."recencyDays"`)},
    'frequency', ${Prisma.raw(`"${alias}"."frequency"`)}::text,
    'ltvCents', ${Prisma.raw(`"${alias}"."ltvCents"`)}::text,
    'refundExcessCents', ${Prisma.raw(`"${alias}"."refundExcessCents"`)}::text,
    'rfmClass', ${Prisma.raw(`"${alias}"."rfmClass"`)},
    'scores', jsonb_build_object(
      'recency', ${Prisma.raw(`"${alias}"."recencyScore"`)},
      'frequency', ${Prisma.raw(`"${alias}"."frequencyScore"`)},
      'monetary', ${Prisma.raw(`"${alias}"."monetaryScore"`)}
    )
  )`;
}

function eligibilityCtes(
  _segment: CustomerSegment,
  definition: CustomerSegmentDefinition,
): Prisma.Sql {
  const filters: Prisma.Sql[] = [];
  if (definition.minFrequency !== null) {
    filters.push(Prisma.sql`rfm."frequency" >= ${definition.minFrequency}::bigint`);
  }
  if (definition.maxFrequency !== null) {
    filters.push(Prisma.sql`rfm."frequency" <= ${definition.maxFrequency}::bigint`);
  }
  if (definition.minNetLtvCents !== null) {
    filters.push(Prisma.sql`rfm."ltvCents" >= ${definition.minNetLtvCents}::bigint`);
  }
  if (definition.maxNetLtvCents !== null) {
    filters.push(Prisma.sql`rfm."ltvCents" <= ${definition.maxNetLtvCents}::bigint`);
  }
  if (definition.lastPurchaseWithinDays !== null) {
    filters.push(Prisma.sql`rfm."recencyDays" <= ${definition.lastPurchaseWithinDays}::int`);
  }
  if (definition.lastPurchaseOlderThanDays !== null) {
    filters.push(Prisma.sql`rfm."recencyDays" > ${definition.lastPurchaseOlderThanDays}::int`);
  }
  if (definition.rfmClass !== null) {
    filters.push(Prisma.sql`rfm."rfmClass" = ${definition.rfmClass}`);
  }
  const additional =
    filters.length > 0 ? Prisma.sql`AND ${Prisma.join(filters, " AND ")}` : Prisma.empty;
  return Prisma.sql`
    consent_evidence AS (
      SELECT customer."id" AS "customerId", consent."id" AS "consentId", consent."status",
        (revocation."id" IS NULL) AS "unrevoked"
      FROM "Customer" customer
      JOIN LATERAL (
        SELECT candidate.* FROM "Consent" candidate
        WHERE candidate."customerId" = customer."id" AND candidate."purpose" = 'MARKETING_EMAIL'
        ORDER BY candidate."occurredAt" DESC, candidate."id" DESC LIMIT 1
      ) consent ON TRUE
      LEFT JOIN "Consent" revocation ON revocation."revokesId" = consent."id"
    ),
    eligible_members AS (
      SELECT rfm.*, evidence."consentId"
      FROM customer_rfm rfm
      JOIN "Customer" customer ON customer."id" = rfm."customerId" AND customer."status" = 'ACTIVE' AND customer."deletedAt" IS NULL
      JOIN consent_evidence evidence ON evidence."customerId" = customer."id" AND evidence."status" = 'GRANTED' AND evidence."unrevoked"
      WHERE NOT EXISTS (
        SELECT 1 FROM "EmailSuppression" suppression
        WHERE suppression."recipientHash" = digest(customer."email"::text, 'sha256'::text) AND suppression."topic" = 'lifecycle'
      ) ${additional}
    )
  `;
}

export class SegmentationService {
  constructor(private readonly db: DatabaseExecutor) {}

  private input(input: CustomerSegmentInput) {
    const definition = normalizedSegmentDefinition(input.definition);
    return {
      name: lifecycleName(input.name),
      description: lifecycleDescription(input.description),
      definition,
      definitionHash: segmentDefinitionHash(definition),
    };
  }

  async createSegment(input: CustomerSegmentInput, audit: LifecycleAudit) {
    const values = this.input(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      const segment = await tx.customerSegment.create({
        data: {
          ...values,
          definition: definitionJson(values.definition),
          createdByAdminUserId: audit.actorAdminUserId,
          updatedByAdminUserId: audit.actorAdminUserId,
        },
      });
      await lifecycleLog(tx, audit, "CUSTOMER_SEGMENT_CREATED", "CustomerSegment", segment.id, {
        version: segment.version,
      });
      return segmentView(segment);
    });
  }

  async updateSegment(input: CustomerSegmentMutation, audit: LifecycleAudit) {
    assertUuid(input.segmentId, "segmentId");
    lifecycleVersion(input.expectedVersion);
    const values = this.input(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`customer-segment:${input.segmentId}`]);
      const current = await tx.customerSegment.findUnique({ where: { id: input.segmentId } });
      if (!current) throw new LifecycleError("NOT_FOUND", "Customer segment not found.");
      if (current.status !== "DRAFT" || current.version !== input.expectedVersion) {
        throw new LifecycleError("CONFLICT", "The segment changed or is no longer a draft.");
      }
      const segment = await tx.customerSegment.update({
        where: { id: input.segmentId },
        data: {
          ...values,
          definition: definitionJson(values.definition),
          version: { increment: 1 },
          updatedByAdminUserId: audit.actorAdminUserId,
        },
      });
      await lifecycleLog(tx, audit, "CUSTOMER_SEGMENT_UPDATED", "CustomerSegment", segment.id, {
        previousVersion: input.expectedVersion,
        version: segment.version,
      });
      return segmentView(segment);
    });
  }

  async transitionSegment(
    input: { segmentId: string; expectedVersion: number; action: "ACTIVATE" | "ARCHIVE" },
    audit: LifecycleAudit,
  ) {
    assertUuid(input.segmentId, "segmentId");
    lifecycleVersion(input.expectedVersion);
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      await acquireOperationLocks(tx, [`customer-segment:${input.segmentId}`]);
      const current = await tx.customerSegment.findUnique({ where: { id: input.segmentId } });
      if (!current) throw new LifecycleError("NOT_FOUND", "Customer segment not found.");
      if (current.version !== input.expectedVersion || current.status === "ARCHIVED") {
        throw new LifecycleError("CONFLICT", "The segment changed or is already archived.");
      }
      if (input.action === "ACTIVATE" && current.status !== "DRAFT") {
        throw new LifecycleError("CONFLICT", "Only a draft segment can be activated.");
      }
      if (input.action === "ARCHIVE") {
        const activeJourneys = await tx.lifecycleJourney.count({
          where: { segmentId: current.id, status: { in: ["ACTIVE", "PAUSED"] } },
        });
        if (activeJourneys > 0) {
          throw new LifecycleError(
            "CONFLICT",
            "Archive or reassign active journeys before archiving their segment.",
          );
        }
        const activeMembers = await tx.$queryRaw<Array<{ customerId: string }>>`
          WITH latest AS (
            SELECT DISTINCT ON (membership."segmentId", membership."customerId")
              membership."customerId", membership."status"
            FROM "CustomerSegmentMembership" membership
            WHERE membership."segmentId" = ${current.id}::uuid
            ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
          )
          SELECT "customerId" FROM latest WHERE "status" = 'ENTERED' ORDER BY "customerId"
        `;
        if (activeMembers.length > 0) {
          await acquireOperationLocks(
            tx,
            activeMembers.map((row) => `growth-customer:${row.customerId}`),
          );
        }
      }
      const now = await databaseNow(tx);
      const segment = await tx.customerSegment.update({
        where: { id: current.id },
        data: {
          status: input.action === "ACTIVATE" ? "ACTIVE" : "ARCHIVED",
          version: { increment: 1 },
          updatedByAdminUserId: audit.actorAdminUserId,
          ...(input.action === "ACTIVATE" ? { activatedAt: now } : { archivedAt: now }),
        },
      });
      let exited = 0;
      if (input.action === "ARCHIVE") {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          WITH latest AS (
            SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
            FROM "CustomerSegmentMembership" membership WHERE membership."segmentId" = ${segment.id}::uuid
            ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
          ), changes AS (
            INSERT INTO "CustomerSegmentMembership" (
              "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
              "reason", "metrics", "definitionHash"
            )
            SELECT latest."segmentId", latest."customerId", latest."consentId", latest."sequence" + 1,
              ${segment.version}::int, 'EXITED', 'SEGMENT_ARCHIVED', latest."metrics", ${segment.definitionHash}::bytea
            FROM latest WHERE latest."status" = 'ENTERED' ORDER BY latest."customerId"
            RETURNING "id"
          ) SELECT "id" FROM changes
        `;
        exited = rows.length;
      }
      await lifecycleLog(
        tx,
        audit,
        input.action === "ACTIVATE" ? "CUSTOMER_SEGMENT_ACTIVATED" : "CUSTOMER_SEGMENT_ARCHIVED",
        "CustomerSegment",
        segment.id,
        { previousVersion: input.expectedVersion, version: segment.version, exited },
      );
      return { ...segmentView(segment), exited };
    });
  }

  private async refreshInTransaction(tx: Prisma.TransactionClient, segmentId: string) {
    await acquireOperationLocks(tx, [`customer-segment:${segmentId}`]);
    const segment = await tx.customerSegment.findUnique({ where: { id: segmentId } });
    if (!segment) throw new LifecycleError("NOT_FOUND", "Customer segment not found.");
    if (segment.status !== "ACTIVE") {
      throw new LifecycleError("CONFLICT", "Only active segments can be refreshed.");
    }
    const definition = normalizedSegmentDefinition(segment.definition);
    const ctes = eligibilityCtes(segment, definition);
    const candidates = await tx.$queryRaw<Array<{ customerId: string }>>(Prisma.sql`
      ${customerRfmCte()}, ${ctes},
      latest AS (
        SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
        FROM "CustomerSegmentMembership" membership WHERE membership."segmentId" = ${segment.id}::uuid
        ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
      )
      SELECT DISTINCT "customerId" FROM (
        SELECT eligible."customerId" FROM eligible_members eligible
        LEFT JOIN latest ON latest."segmentId" = ${segment.id}::uuid AND latest."customerId" = eligible."customerId"
        WHERE latest."id" IS NULL OR latest."status" = 'EXITED'
        UNION
        SELECT latest."customerId" FROM latest WHERE latest."status" = 'ENTERED'
      ) candidate_ids
      ORDER BY "customerId"
    `);
    const lockedCustomerIds = candidates.map((row) => row.customerId);
    if (lockedCustomerIds.length > 0) {
      await acquireOperationLocks(
        tx,
        lockedCustomerIds.map((id) => `growth-customer:${id}`),
      );
    }
    const entered =
      lockedCustomerIds.length === 0
        ? []
        : await tx.$queryRaw<Array<{ id: string; customerId: string }>>(Prisma.sql`
      ${customerRfmCte()}, ${ctes},
      latest AS (
        SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
        FROM "CustomerSegmentMembership" membership
        WHERE membership."segmentId" = ${segment.id}::uuid
          AND membership."customerId" = ANY(${lockedCustomerIds}::uuid[])
        ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
      ), changes AS (
        INSERT INTO "CustomerSegmentMembership" (
          "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
          "reason", "metrics", "definitionHash"
        )
        SELECT ${segment.id}::uuid, eligible."customerId", eligible."consentId",
          COALESCE(latest."sequence", 0) + 1, ${segment.version}::int, 'ENTERED', 'QUALIFIED',
          ${metricsSql("eligible")}, ${segment.definitionHash}::bytea
        FROM eligible_members eligible
        LEFT JOIN latest ON latest."segmentId" = ${segment.id}::uuid AND latest."customerId" = eligible."customerId"
        WHERE eligible."customerId" = ANY(${lockedCustomerIds}::uuid[])
          AND (latest."id" IS NULL OR latest."status" = 'EXITED')
        ORDER BY eligible."customerId"
        RETURNING "id", "customerId"
      ) SELECT "id", "customerId" FROM changes
    `);
    const exited =
      lockedCustomerIds.length === 0
        ? []
        : await tx.$queryRaw<
            Array<{ id: string; entryMembershipId: string; customerId: string; reason: string }>
          >(Prisma.sql`
      ${customerRfmCte()}, ${ctes},
      latest AS (
        SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
        FROM "CustomerSegmentMembership" membership
        WHERE membership."segmentId" = ${segment.id}::uuid
          AND membership."customerId" = ANY(${lockedCustomerIds}::uuid[])
        ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
      ), changes AS (
        INSERT INTO "CustomerSegmentMembership" (
          "segmentId", "customerId", "consentId", "sequence", "segmentVersion", "status",
          "reason", "metrics", "definitionHash"
        )
        SELECT latest."segmentId", latest."customerId", latest."consentId", latest."sequence" + 1,
          ${segment.version}::int, 'EXITED',
          CASE
            WHEN customer."status" <> 'ACTIVE' OR customer."deletedAt" IS NOT NULL THEN 'CUSTOMER_INACTIVE'
            WHEN NOT EXISTS (
              SELECT 1 FROM consent_evidence evidence
              WHERE evidence."customerId" = latest."customerId" AND evidence."status" = 'GRANTED' AND evidence."unrevoked"
            ) THEN 'CONSENT_REVOKED'
            ELSE 'FILTER_CHANGED'
          END,
          ${metricsSql("rfm")}, ${segment.definitionHash}::bytea
        FROM latest
        JOIN "Customer" customer ON customer."id" = latest."customerId"
        JOIN customer_rfm rfm ON rfm."customerId" = latest."customerId"
        WHERE latest."customerId" = ANY(${lockedCustomerIds}::uuid[])
          AND latest."status" = 'ENTERED'
          AND NOT EXISTS (
            SELECT 1 FROM eligible_members eligible WHERE eligible."customerId" = latest."customerId"
          )
        ORDER BY latest."customerId"
        RETURNING "id", "customerId", "reason", (
          SELECT prior."id" FROM "CustomerSegmentMembership" prior
          WHERE prior."segmentId" = "CustomerSegmentMembership"."segmentId"
            AND prior."customerId" = "CustomerSegmentMembership"."customerId"
            AND prior."sequence" = "CustomerSegmentMembership"."sequence" - 1
        ) AS "entryMembershipId"
      ) SELECT "id", "entryMembershipId", "customerId", "reason" FROM changes
    `);
    const now = await databaseNow(tx);
    let cancelled = 0;
    for (const change of exited) {
      if (!change.entryMembershipId) {
        throw new LifecycleError("CONFLICT", "Segment exit does not reference its entry evidence.");
      }
      const cancelReason =
        change.reason === "CONSENT_REVOKED"
          ? "CONSENT_REVOKED"
          : change.reason === "CUSTOMER_INACTIVE"
            ? "CUSTOMER_INACTIVE"
            : "SEGMENT_EXITED";
      const enrollments = await tx.lifecycleEnrollment.findMany({
        where: { entryMembershipId: change.entryMembershipId, status: "ACTIVE" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const enrollment of enrollments) {
        if (await cancelLifecycleEnrollment(tx, enrollment.id, now, cancelReason)) {
          cancelled += 1;
        }
      }
    }
    await tx.customerSegment.update({
      where: { id: segment.id },
      data: { lastRefreshedAt: now },
    });
    return { entered: entered.length, exited: exited.length, cancelled };
  }

  async refreshSegment(segmentId: string, audit: LifecycleAudit) {
    assertUuid(segmentId, "segmentId");
    return inInventoryTransaction(this.db, async (tx) => {
      await lifecycleActor(tx, audit, "crm:write");
      const result = await this.refreshInTransaction(tx, segmentId);
      await lifecycleLog(
        tx,
        audit,
        "CUSTOMER_SEGMENT_REFRESHED",
        "CustomerSegment",
        segmentId,
        result,
      );
      return result;
    });
  }

  async refreshActiveSegments(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new LifecycleError("VALIDATION", "Segment refresh limit must be between 1 and 100.");
    }
    const totals = { segments: 0, entered: 0, exited: 0, cancelled: 0 };
    const attempted = new Set<string>();
    while (totals.segments < limit && attempted.size < limit * 2) {
      const remaining = limit - totals.segments;
      const segments = await this.db.customerSegment.findMany({
        where: {
          status: "ACTIVE",
          ...(attempted.size > 0 ? { id: { notIn: [...attempted] } } : {}),
        },
        select: { id: true },
        orderBy: [{ lastRefreshedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: remaining,
      });
      if (segments.length === 0) break;
      for (const segment of segments) {
        attempted.add(segment.id);
        try {
          const result = await inInventoryTransaction(this.db, async (tx) => {
            const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
              SELECT pg_try_advisory_xact_lock(hashtextextended(${`customer-segment:${segment.id}`}, 0)) AS locked
            `;
            if (!lockRows[0]?.locked) return null;
            return this.refreshInTransaction(tx, segment.id);
          });
          if (!result) continue;
          totals.segments += 1;
          totals.entered += result.entered;
          totals.exited += result.exited;
          totals.cancelled += result.cancelled;
        } catch (error) {
          if (
            (error instanceof LifecycleError && error.code === "CONFLICT") ||
            (error as { code?: unknown } | null)?.code === "40001"
          ) {
            continue;
          }
          throw error;
        }
      }
    }
    return totals;
  }

  async listSegments(actorAdminUserId: string, options: { cursor?: string; limit?: number } = {}) {
    await lifecycleReader(this.db, actorAdminUserId);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new LifecycleError("VALIDATION", "limit must be between 1 and 100.");
    }
    if (options.cursor) assertUuid(options.cursor, "cursor");
    const segments = await this.db.customerSegment.findMany({
      where: options.cursor ? { id: { gt: options.cursor } } : {},
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = segments.slice(0, limit);
    const counts = await this.db.$queryRaw<Array<{ segmentId: string; members: number }>>`
      WITH latest AS (
        SELECT DISTINCT ON (membership."segmentId", membership."customerId") membership.*
        FROM "CustomerSegmentMembership" membership
        ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
      ) SELECT latest."segmentId", count(*)::int AS members FROM latest WHERE latest."status" = 'ENTERED' GROUP BY latest."segmentId"
    `;
    const memberCounts = new Map(counts.map((row) => [row.segmentId, row.members]));
    return {
      items: page.map((segment) => ({
        ...segmentView(segment),
        members: memberCounts.get(segment.id) ?? 0,
      })),
      nextCursor: segments.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getSegmentDetail(actorAdminUserId: string, segmentId: string) {
    await lifecycleReader(this.db, actorAdminUserId);
    assertUuid(segmentId, "segmentId");
    const segment = await this.db.customerSegment.findUnique({ where: { id: segmentId } });
    if (!segment) throw new LifecycleError("NOT_FOUND", "Customer segment not found.");
    const history = await this.db.customerSegmentMembership.findMany({
      where: { segmentId },
      include: { customer: { select: { email: true, status: true } } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return {
      segment: segmentView(segment),
      history: history.map((entry) => ({
        id: entry.id,
        customerId: entry.customerId,
        customerEmail:
          entry.customer.status === "ANONYMIZED"
            ? "Cuenta anonimizada"
            : maskEmail(entry.customer.email),
        sequence: entry.sequence,
        segmentVersion: entry.segmentVersion,
        status: entry.status,
        reason: entry.reason,
        metrics: metricsView(entry.metrics),
        consentId: entry.consentId,
        occurredAt: entry.occurredAt,
      })),
    };
  }
}
