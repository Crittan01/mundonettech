import { createHash, randomUUID } from "node:crypto";

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
import { assertUuid } from "./inventory-shared.js";

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

export interface CrmContactInput {
  readonly organizationId?: string | null;
  readonly customerId?: string | null;
  readonly givenName: string;
  readonly familyName: string;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly source: string;
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

export function normalizeCrmContactInput(input: CrmContactInput): NormalizedCrmContactInput {
  const email = input.email ? normalizeEmail(input.email) : null;
  const phoneE164 = input.phoneE164 ? normalizeContactPhone(input.phoneE164) : null;
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
    source: crmText(input.source, "source", 2, 60),
  };
}

export function normalizeCrmOrganizationInput(input: CrmOrganizationInput) {
  const taxId = input.taxId ? normalizeContactIdentity("DOCUMENT", input.taxId) : null;
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
  const actor = await tx.adminUser.findFirst({
    where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
  });
  if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
    throw new CrmError("FORBIDDEN", "The administrator is not authorized for this CRM operation.");
  }
  return actor;
}

export async function crmLog(
  tx: Prisma.TransactionClient,
  audit: CrmAudit,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.JsonObject = {},
): Promise<void> {
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      requestId: audit.requestId ?? randomUUID(),
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      metadata,
    },
  });
}

export async function crmNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  return rows[0]!.now;
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
