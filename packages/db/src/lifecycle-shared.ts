import { createHash } from "node:crypto";

import {
  hasAdminPermission,
  isAdminRole,
  lifecycleSingleLineText,
  lifecycleText,
  normalizeCustomerSegmentDefinition,
  type AdminPermission,
} from "@mundonettech/core";

import type { Prisma } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import type { DatabaseExecutor } from "./primitives.js";
export { databaseNow } from "./primitives.js";

export type LifecycleErrorCode = "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "FORBIDDEN";

export class LifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface LifecycleAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
  readonly requestId?: string;
}

export type LifecyclePermission = Extract<AdminPermission, "crm:read" | "crm:write">;

export function lifecycleVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_646) {
    throw new LifecycleError("VALIDATION", "expectedVersion must be a nonnegative 32-bit integer.");
  }
  return value;
}

export function lifecycleName(value: unknown): string {
  try {
    return lifecycleSingleLineText(value, "name", 2, 120);
  } catch (error) {
    throw new LifecycleError(
      "VALIDATION",
      error instanceof Error ? error.message : "Invalid name.",
    );
  }
}

export function lifecycleDescription(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return lifecycleText(value, "description", 1, 500);
  } catch (error) {
    throw new LifecycleError(
      "VALIDATION",
      error instanceof Error ? error.message : "Invalid description.",
    );
  }
}

export function normalizedSegmentDefinition(value: unknown) {
  try {
    return normalizeCustomerSegmentDefinition(value);
  } catch (error) {
    throw new LifecycleError(
      "VALIDATION",
      error instanceof Error ? error.message : "Invalid segment definition.",
    );
  }
}

export function segmentDefinitionHash(definition: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    createHash("sha256")
      .update(JSON.stringify(normalizedSegmentDefinition(definition)))
      .digest(),
  );
}

function auditHash(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new LifecycleError("VALIDATION", `${field} must contain exactly 32 bytes.`);
  }
  return Uint8Array.from(value);
}

export async function lifecycleActor(
  tx: DatabaseExecutor,
  audit: LifecycleAudit,
  permission: LifecyclePermission,
) {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  auditHash(audit.ipHash, "ipHash");
  if (audit.userAgentHash !== null) auditHash(audit.userAgentHash, "userAgentHash");
  const actor = await tx.adminUser.findFirst({
    where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
  });
  if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, permission)) {
    throw new LifecycleError(
      "FORBIDDEN",
      "The administrator is not authorized for this lifecycle operation.",
    );
  }
  return actor;
}

export async function lifecycleLog(
  tx: Prisma.TransactionClient,
  audit: LifecycleAudit,
  action: string,
  targetType: "CustomerSegment" | "LifecycleJourney",
  targetId: string,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      requestId: audit.requestId ?? null,
      ipHash: auditHash(audit.ipHash, "ipHash"),
      userAgentHash: audit.userAgentHash ? auditHash(audit.userAgentHash, "userAgentHash") : null,
      metadata,
    },
  });
}

export async function lifecycleReader(
  db: DatabaseExecutor,
  actorAdminUserId: string,
): Promise<void> {
  assertUuid(actorAdminUserId, "actorAdminUserId");
  const actor = await db.adminUser.findFirst({
    where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
    select: { role: true },
  });
  if (!actor || !isAdminRole(actor.role) || !hasAdminPermission(actor.role, "crm:read")) {
    throw new LifecycleError(
      "FORBIDDEN",
      "The administrator is not authorized to read lifecycle data.",
    );
  }
}
