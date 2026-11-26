import { createHash } from "node:crypto";

import {
  assertCrmRetentionMonths,
  hasAdminPermission,
  isAdminRole,
  normalizeContactIdentity,
  normalizeContactPhone,
  normalizeEmail,
  type AdminPermission,
} from "@mundonettech/core";

import type { AdminUser, Contact, Prisma } from "./generated/client.js";
import { acquireOperationLocks, assertUuid } from "./inventory-shared.js";
import { databaseNow, isAdminSelfDealingCustomer, recordAdminAction } from "./primitives.js";

export type CrmErrorCode = "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "FORBIDDEN";
export type CrmPermission = Extract<
  AdminPermission,
  "crm:read" | "crm:write" | "crm:merge" | "crm:suppress"
>;

export class CrmError extends Error {
  constructor(
    readonly code: CrmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

export interface CrmAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
  readonly requestId?: string;
}

export interface CrmOrganizationInput {
  readonly legalName: string;
  readonly commercialName?: string | null;
  readonly taxId?: string | null;
}

export interface CrmOrganizationUpdateInput {
  readonly organizationId: string;
  readonly expectedVersion: number;
  readonly legalName: string;
  readonly commercialName?: string | null;
  readonly taxId?: string | null;
}

export interface CrmContactInput {
  readonly organizationId?: string | null;
  readonly customerId?: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly source: string;
}

export interface CrmContactUpdateInput {
  readonly contactId: string;
  readonly expectedVersion: number;
  readonly organizationId?: string | null;
  readonly customerId?: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly source?: string;
}

export interface NormalizedCrmContactInput {
  readonly organizationId: string | null;
  readonly customerId: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly source: string;
}

const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const sourcePattern = /^[a-z][a-z0-9.-]{1,59}$/;

export function crmText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    controlPattern.test(value)
  ) {
    throw new CrmError(
      "VALIDATION",
      `${field} must contain ${minimum} to ${maximum} trimmed printable characters.`,
    );
  }
  return value;
}

export function crmOptionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return crmText(value, field, 1, maximum);
}

export function crmVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new CrmError("VALIDATION", "expectedVersion must be a nonnegative 32-bit integer.");
  }
  return value;
}

export function crmLimit(value: number | undefined, maximum = 100): number {
  const resolved = value ?? 50;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new CrmError("VALIDATION", `limit must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

export function crmRetentionMonths(value: number): number {
  try {
    return assertCrmRetentionMonths(value);
  } catch (error) {
    throw new CrmError("VALIDATION", error instanceof Error ? error.message : "Invalid retention.");
  }
}

export function crmSource(value: unknown): string {
  const normalized = crmText(value, "source", 2, 60);
  if (!sourcePattern.test(normalized)) {
    throw new CrmError(
      "VALIDATION",
      "source must start with a lowercase letter and use lowercase letters, digits, dots or hyphens.",
    );
  }
  return normalized;
}

export function normalizeCrmContactInput(input: CrmContactInput): NormalizedCrmContactInput {
  let email: string | null = null;
  let phoneE164: string | null = null;
  try {
    email = input.email ? normalizeEmail(input.email) : null;
    phoneE164 = input.phoneE164 ? normalizeContactPhone(input.phoneE164) : null;
  } catch (error) {
    throw new CrmError("VALIDATION", error instanceof Error ? error.message : "Invalid identity.");
  }
  if (!email && !phoneE164) {
    throw new CrmError("VALIDATION", "A contact requires at least one email or phone identity.");
  }
  if (input.organizationId) assertUuid(input.organizationId, "organizationId");
  if (input.customerId) assertUuid(input.customerId, "customerId");
  return {
    organizationId: input.organizationId ?? null,
    customerId: input.customerId ?? null,
    givenName: crmText(input.givenName, "givenName", 1, 100),
    familyName: crmText(input.familyName, "familyName", 1, 100),
    email,
    phoneE164,
    source: crmSource(input.source),
  };
}

export function normalizeCrmOrganizationInput(input: CrmOrganizationInput) {
  let taxId: string | null = null;
  try {
    taxId = input.taxId ? normalizeContactIdentity("DOCUMENT", input.taxId) : null;
  } catch (error) {
    throw new CrmError("VALIDATION", error instanceof Error ? error.message : "Invalid taxId.");
  }
  return {
    legalName: crmText(input.legalName, "legalName", 2, 200),
    commercialName: input.commercialName
      ? crmText(input.commercialName, "commercialName", 2, 200)
      : null,
    taxId,
  };
}

export function crmIdentityHash(
  kind: "EMAIL" | "PHONE" | "DOCUMENT",
  value: string,
): Uint8Array<ArrayBuffer> {
  const normalized = normalizeContactIdentity(kind, value);
  return Uint8Array.from(createHash("sha256").update(`${kind}:${normalized}`).digest());
}

export async function crmActor(
  tx: Prisma.TransactionClient,
  audit: CrmAudit,
  permission: CrmPermission,
): Promise<AdminUser> {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (
    !(audit.ipHash instanceof Uint8Array) ||
    audit.ipHash.length !== 32 ||
    (audit.userAgentHash !== null &&
      (!(audit.userAgentHash instanceof Uint8Array) || audit.userAgentHash.length !== 32))
  ) {
    throw new CrmError("VALIDATION", "Audit hashes must contain exactly 32 bytes.");
  }
  const actors = await tx.$queryRaw<AdminUser[]>`
    SELECT * FROM "AdminUser"
    WHERE "id" = ${audit.actorAdminUserId}::uuid
      AND "status" = 'ACTIVE'
      AND "deletedAt" IS NULL
    FOR SHARE
  `;
  const actor = actors[0];
  if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
    throw new CrmError("FORBIDDEN", "The administrator is not authorized for this CRM operation.");
  }
  return actor;
}

type CrmAuditContact = Pick<Contact, "id" | "customerId" | "email">;

async function crmAuditContacts(
  tx: Prisma.TransactionClient,
  targetType: string,
  targetId: string,
): Promise<CrmAuditContact[]> {
  const selection = { id: true, customerId: true, email: true } as const;
  if (targetType === "Contact") {
    const contact = await tx.contact.findUnique({ where: { id: targetId }, select: selection });
    return contact ? [contact] : [];
  }
  if (targetType === "ContactActivity") {
    const activity = await tx.contactActivity.findUnique({
      where: { id: targetId },
      select: { contact: { select: selection } },
    });
    return activity ? [activity.contact] : [];
  }
  if (targetType === "Task") {
    const task = await tx.task.findUnique({
      where: { id: targetId },
      select: { contact: { select: selection } },
    });
    return task ? [task.contact] : [];
  }
  if (targetType === "IdentityMergeCandidate") {
    const candidate = await tx.identityMergeCandidate.findUnique({
      where: { id: targetId },
      select: {
        sourceContact: { select: selection },
        targetContact: { select: selection },
      },
    });
    return candidate ? [candidate.sourceContact, candidate.targetContact] : [];
  }
  return [];
}

export async function crmSelfDealingContacts(
  tx: Prisma.TransactionClient,
  audit: CrmAudit,
  contactIds: readonly string[],
): Promise<boolean> {
  if (contactIds.length === 0) return false;
  const actor = await tx.adminUser.findUnique({
    where: { id: audit.actorAdminUserId },
    select: { authUserId: true, email: true },
  });
  if (!actor) return false;
  const contacts = await tx.contact.findMany({
    where: { id: { in: [...contactIds] } },
    select: { id: true, customerId: true, email: true },
  });
  for (const contact of contacts) {
    if (await isAdminSelfDealingCustomer(tx, actor, contact)) return true;
  }
  const previousActorIdentity = await tx.contactIdentity.findFirst({
    where: {
      contactId: { in: [...contactIds] },
      kind: "EMAIL",
      normalizedValue: normalizeEmail(actor.email),
    },
    select: { id: true },
  });
  return previousActorIdentity !== null;
}

export async function crmSelfDealing(
  tx: Prisma.TransactionClient,
  audit: CrmAudit,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  const actor = await tx.adminUser.findUnique({
    where: { id: audit.actorAdminUserId },
    select: { authUserId: true, email: true },
  });
  if (!actor) return false;
  const contacts = await crmAuditContacts(tx, targetType, targetId);
  for (const contact of contacts) {
    if (await isAdminSelfDealingCustomer(tx, actor, contact)) return true;
  }
  if (contacts.length > 0) {
    const previousActorIdentity = await tx.contactIdentity.findFirst({
      where: {
        contactId: { in: contacts.map((contact) => contact.id) },
        kind: "EMAIL",
        normalizedValue: normalizeEmail(actor.email),
      },
      select: { id: true },
    });
    return previousActorIdentity !== null;
  }
  return false;
}

export async function crmLog(
  tx: Prisma.TransactionClient,
  audit: CrmAudit,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.JsonObject = {},
  selfDealing?: boolean,
): Promise<void> {
  const resolvedSelfDealing =
    selfDealing ?? (await crmSelfDealing(tx, audit, targetType, targetId));
  await recordAdminAction(tx, audit, action, targetType, targetId, metadata, {
    selfDealing: resolvedSelfDealing,
  });
}

export async function crmNow(tx: Prisma.TransactionClient): Promise<Date> {
  return databaseNow(tx);
}

export async function crmRetentionReviewAt(
  tx: Prisma.TransactionClient,
  months: number,
): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ retentionReviewAt: Date }>>`
    SELECT CURRENT_TIMESTAMP + make_interval(months => ${crmRetentionMonths(months)}) AS "retentionReviewAt"
  `;
  return rows[0]!.retentionReviewAt;
}

export function crmContactSnapshot(contact: Contact): Prisma.JsonObject {
  return JSON.parse(JSON.stringify(contact)) as Prisma.JsonObject;
}

export function crmJsonStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new CrmError("CONFLICT", `${field} is not a unique string array.`);
  }
  for (const entry of value as string[]) assertUuid(entry, field);
  return value as string[];
}

export async function redactCrmActivitiesInTransaction(
  tx: Prisma.TransactionClient,
  lineageIds: readonly string[],
  now: Date,
): Promise<void> {
  await tx.contactActivity.updateMany({
    where: { contactId: { in: [...lineageIds] }, redactedAt: null },
    data: {
      subject: null,
      body: "[contenido suprimido por retención]",
      redactedAt: now,
    },
  });
}

export async function redactCrmMergeHistoryInTransaction(
  tx: Prisma.TransactionClient,
  lineageIds: readonly string[],
): Promise<number> {
  const mergeHistory = await tx.identityMergeCandidate.findMany({
    where: {
      status: { in: ["MERGED", "REVERSED"] },
      OR: [
        { sourceContactId: { in: [...lineageIds] } },
        { targetContactId: { in: [...lineageIds] } },
      ],
    },
    select: { id: true },
  });
  for (const candidate of mergeHistory) {
    await tx.identityMergeCandidate.update({
      where: { id: candidate.id },
      data: {
        sourceSnapshot: { redacted: true },
        targetSnapshot: { redacted: true },
        movedIdentityIds: [],
        retiredIdentityIds: [],
        movedActivityIds: [],
        movedTaskIds: [],
        movedOpportunityIds: [],
        resolutionNote: "[contenido suprimido por retención]",
        version: { increment: 1 },
      },
    });
  }
  return mergeHistory.length;
}

export async function redactCrmOpportunitiesInTransaction(
  tx: Prisma.TransactionClient,
  lineageIds: readonly string[],
  now: Date,
): Promise<void> {
  const opportunities = await tx.opportunity.findMany({
    where: { contactId: { in: [...lineageIds] }, anonymizedAt: null },
    select: { id: true },
  });
  const opportunityIds = opportunities.map((opportunity) => opportunity.id);
  if (opportunityIds.length > 0) {
    await tx.opportunity.updateMany({
      where: { id: { in: opportunityIds } },
      data: {
        requirements: "[contenido suprimido por retención]",
        acceptanceIpHash: null,
        acceptanceUserAgentHash: null,
        anonymizedAt: now,
      },
    });
    await tx.opportunityProposal.updateMany({
      where: { opportunityId: { in: opportunityIds }, anonymizedAt: null },
      data: {
        commercialNotes: null,
        signerName: null,
        signerDocumentType: null,
        signerDocumentNumber: null,
        acceptanceIpHash: null,
        acceptanceUserAgentHash: null,
        anonymizedAt: now,
      },
    });
  }
}

export function retryableLockDivergenceError(message: string): Error & { readonly code: "40001" } {
  const error = new Error(message) as Error & { code: "40001" };
  error.code = "40001";
  return error;
}

export async function findCustomerCrmLineageIds(
  tx: Prisma.TransactionClient,
  customerIds: readonly string[],
): Promise<string[]> {
  if (customerIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE seed AS (
      SELECT "id", "mergedIntoContactId" FROM "Contact" WHERE "customerId" = ANY(${[...customerIds]}::uuid[])
    ),
    ancestors AS (
      SELECT "id", "mergedIntoContactId" FROM seed
      UNION
      SELECT parent."id", parent."mergedIntoContactId"
      FROM "Contact" parent
      JOIN ancestors child ON child."mergedIntoContactId" = parent."id"
    ),
    full_lineage AS (
      SELECT "id" FROM ancestors
      UNION
      SELECT child."id"
      FROM "Contact" child
      JOIN full_lineage parent ON child."mergedIntoContactId" = parent."id"
    )
    SELECT "id" FROM full_lineage ORDER BY "id"
  `;
  return rows.map((item) => item.id);
}

export async function suppressCustomerCrmLineageInTransaction(
  tx: Prisma.TransactionClient,
  customerId: string,
  now: Date,
): Promise<string[]> {
  assertUuid(customerId, "customerId");
  const lineageIds = await findCustomerCrmLineageIds(tx, [customerId]);
  if (lineageIds.length === 0) return [];
  await acquireOperationLocks(
    tx,
    lineageIds.map((id) => `crm-contact:${id}`),
  );
  const contacts = await tx.$queryRaw<
    Contact[]
  >`SELECT * FROM "Contact" WHERE "id" IN (SELECT * FROM unnest(${lineageIds}::uuid[])) ORDER BY "id" FOR UPDATE`;
  const verifiedLineageIds = await findCustomerCrmLineageIds(tx, [customerId]);
  if (
    contacts.length !== lineageIds.length ||
    verifiedLineageIds.length !== lineageIds.length ||
    verifiedLineageIds.some((id, index) => id !== lineageIds[index])
  ) {
    throw retryableLockDivergenceError("The customer CRM lineage changed concurrently.");
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
  await redactCrmActivitiesInTransaction(tx, lineageIds, now);
  await tx.task.updateMany({
    where: { contactId: { in: lineageIds }, status: { in: ["PENDING", "IN_PROGRESS"] } },
    data: {
      status: "CANCELLED",
      title: "[tarea suprimida por retención]",
      description: null,
      redactedAt: now,
      version: { increment: 1 },
    },
  });
  await tx.task.updateMany({
    where: { contactId: { in: lineageIds }, redactedAt: null },
    data: {
      title: "[tarea suprimida por retención]",
      description: null,
      redactedAt: now,
      version: { increment: 1 },
    },
  });
  await redactCrmMergeHistoryInTransaction(tx, lineageIds);
  await tx.identityMergeCandidate.updateMany({
    where: {
      status: "PENDING",
      OR: [{ sourceContactId: { in: lineageIds } }, { targetContactId: { in: lineageIds } }],
    },
    data: {
      status: "REJECTED",
      rejectedAt: now,
      resolutionNote: "[contenido suprimido por retención]",
      version: { increment: 1 },
    },
  });
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
        suppressionReason: "DATA_SUBJECT_REQUEST",
        suppressedAt: now,
        anonymizedAt: now,
        deletedAt: now,
        version: { increment: 1 },
      },
    });
  }
  await tx.contactIdentity.deleteMany({ where: { contactId: { in: lineageIds } } });
  return lineageIds;
}
