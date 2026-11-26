import { createHash } from "node:crypto";

import {
  assertCartQuantity,
  assertMoney,
  normalizeContactPhone,
  normalizeEmail,
  type AdminPermission,
} from "@mundonettech/core";

import type { OpportunityProposal, OpportunityProposalItem, Prisma } from "./generated/client.js";
import { assertUuid } from "./inventory-shared.js";
import {
  AdminActorAuthorizationError,
  assertAdminActorInTransaction,
  databaseNow,
  recordAdminAction,
  type DatabaseExecutor,
} from "./primitives.js";
import type { B2bAudit } from "./b2b-types.js";

export type B2bErrorCode = "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "FORBIDDEN" | "EXPIRED";
export type B2bPermission = Extract<AdminPermission, "b2b:read" | "b2b:write">;
export type ProposalContentSource = Pick<
  OpportunityProposal,
  | "opportunityId"
  | "version"
  | "priceListId"
  | "priceListCodeSnapshot"
  | "priceListVersionSnapshot"
  | "currency"
  | "subtotalCents"
  | "discountCents"
  | "taxCents"
  | "shippingCents"
  | "totalCents"
  | "taxRegime"
  | "uvtValueCents"
  | "uvtYear"
  | "deliveryPromiseDays"
  | "reservationMinutes"
  | "commercialNotes"
  | "expiresAt"
> & {
  readonly items: readonly Pick<
    OpportunityProposalItem,
    | "variantId"
    | "quantity"
    | "titleSnapshot"
    | "productSlugSnapshot"
    | "skuSnapshot"
    | "catalogUnitPriceCents"
    | "unitPriceCents"
    | "discountCents"
    | "lineTotalCents"
    | "taxGroupCode"
    | "taxGroupName"
    | "treatment"
    | "taxRule"
    | "catalogRateBps"
    | "appliedRateBps"
    | "uvtLimit"
    | "unitValueCents"
    | "taxableBaseCents"
    | "taxCents"
  >[];
};
export type ProposalWithItems = OpportunityProposal & {
  readonly items: readonly OpportunityProposalItem[];
};

const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class B2bError extends Error {
  constructor(
    readonly code: B2bErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "B2bError";
  }
}

export function b2bText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    controlPattern.test(value)
  ) {
    throw new B2bError(
      "VALIDATION",
      `${field} must contain ${minimum} to ${maximum} trimmed printable characters.`,
    );
  }
  return value;
}

export function b2bOptionalText(value: unknown, field: string, maximum: number): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : b2bText(value, field, 1, maximum);
}

export function b2bHash(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new B2bError("VALIDATION", `${field} must contain exactly 32 bytes.`);
  }
  return Uint8Array.from(value);
}

export function b2bOptionalHash(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  return value === undefined || value === null ? null : b2bHash(value, field);
}

export function b2bVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new B2bError("VALIDATION", "Version must be a nonnegative 32-bit integer.");
  }
  return value;
}

export function b2bMoney(value: string | bigint, field: string, positive = false): bigint {
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(value);
    assertMoney(parsed, field, positive);
    return parsed;
  } catch {
    throw new B2bError("VALIDATION", `${field} is outside the permitted INT8 monetary range.`);
  }
}

export function b2bEmail(value: string): string {
  try {
    return normalizeEmail(value);
  } catch {
    throw new B2bError("VALIDATION", "A valid email address is required.");
  }
}

export function b2bPhone(value: string): string {
  try {
    const compact = value.replace(/[\s()-]/g, "");
    const colombian = /^(?:\+57)?([36][0-9]{9})$/.exec(compact);
    return normalizeContactPhone(colombian?.[1] ? `+57${colombian[1]}` : compact);
  } catch {
    throw new B2bError("VALIDATION", "A valid E.164 phone number is required.");
  }
}

export function b2bDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new B2bError("VALIDATION", `${field} must be a valid date.`);
  }
  return value;
}

export async function b2bNow(tx: DatabaseExecutor): Promise<Date> {
  return databaseNow(tx);
}

export async function b2bActor(
  tx: Prisma.TransactionClient,
  audit: B2bAudit,
  permission: B2bPermission,
): Promise<void> {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  b2bHash(audit.ipHash, "ipHash");
  if (audit.userAgentHash !== null) b2bHash(audit.userAgentHash, "userAgentHash");
  try {
    await assertAdminActorInTransaction(tx, audit.actorAdminUserId, permission);
  } catch (error) {
    if (error instanceof AdminActorAuthorizationError) {
      throw new B2bError("FORBIDDEN", "The administrator is not authorized for B2B operations.");
    }
    throw error;
  }
}

export async function b2bLog(
  tx: Prisma.TransactionClient,
  audit: B2bAudit,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.JsonObject = {},
): Promise<void> {
  await recordAdminAction(tx, audit, action, targetType, targetId, metadata);
}

function canonicalProposal(proposal: ProposalContentSource): string {
  return JSON.stringify({
    opportunityId: proposal.opportunityId,
    version: proposal.version,
    priceListId: proposal.priceListId,
    priceListCodeSnapshot: proposal.priceListCodeSnapshot,
    priceListVersionSnapshot: proposal.priceListVersionSnapshot,
    currency: proposal.currency,
    subtotalCents: proposal.subtotalCents.toString(),
    discountCents: proposal.discountCents.toString(),
    taxCents: proposal.taxCents.toString(),
    shippingCents: proposal.shippingCents.toString(),
    totalCents: proposal.totalCents.toString(),
    taxRegime: proposal.taxRegime,
    uvtValueCents: proposal.uvtValueCents.toString(),
    uvtYear: proposal.uvtYear,
    deliveryPromiseDays: proposal.deliveryPromiseDays,
    reservationMinutes: proposal.reservationMinutes,
    commercialNotes: proposal.commercialNotes,
    expiresAt: proposal.expiresAt.toISOString(),
    items: [...proposal.items]
      .sort((left, right) => left.variantId.localeCompare(right.variantId))
      .map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
        titleSnapshot: item.titleSnapshot,
        productSlugSnapshot: item.productSlugSnapshot,
        skuSnapshot: item.skuSnapshot,
        catalogUnitPriceCents: item.catalogUnitPriceCents.toString(),
        unitPriceCents: item.unitPriceCents.toString(),
        discountCents: item.discountCents.toString(),
        lineTotalCents: item.lineTotalCents.toString(),
        taxGroupCode: item.taxGroupCode,
        taxGroupName: item.taxGroupName,
        treatment: item.treatment,
        taxRule: item.taxRule,
        catalogRateBps: item.catalogRateBps,
        appliedRateBps: item.appliedRateBps,
        uvtLimit: item.uvtLimit,
        unitValueCents: item.unitValueCents.toString(),
        taxableBaseCents: item.taxableBaseCents.toString(),
        taxCents: item.taxCents.toString(),
      })),
  });
}

export function proposalContentHash(proposal: ProposalContentSource): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(canonicalProposal(proposal)).digest());
}

export function assertProposalIntegrity(proposal: ProposalWithItems): void {
  const expected = proposalContentHash(proposal);
  const actual = Uint8Array.from(proposal.contentHash);
  if (
    actual.length !== 32 ||
    (proposal.anonymizedAt === null && !actual.every((value, index) => value === expected[index]))
  ) {
    throw new B2bError("CONFLICT", "Proposal content hash does not match its persisted snapshots.");
  }
  if (proposal.items.length === 0 || proposal.items.length > 100) {
    throw new B2bError("CONFLICT", "Proposal item count is invalid.");
  }
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  const variants = new Set<string>();
  for (const item of proposal.items) {
    if (variants.has(item.variantId)) throw new B2bError("CONFLICT", "Duplicate proposal variant.");
    variants.add(item.variantId);
    assertCartQuantity(item.quantity);
    const gross =
      b2bMoney(item.catalogUnitPriceCents, "catalogUnitPriceCents") * BigInt(item.quantity);
    const unit = b2bMoney(item.unitPriceCents, "unitPriceCents");
    const net = b2bMoney(item.lineTotalCents, "lineTotalCents");
    const itemDiscount = b2bMoney(item.discountCents, "discountCents");
    const itemTax = b2bMoney(item.taxCents, "taxCents");
    if (
      unit > item.catalogUnitPriceCents ||
      net !== unit * BigInt(item.quantity) ||
      itemDiscount !== gross - net ||
      item.taxableBaseCents !== net ||
      item.unitValueCents * BigInt(item.quantity) !== net
    ) {
      throw new B2bError("CONFLICT", "Proposal item commercial totals do not balance.");
    }
    subtotal += gross;
    discount += itemDiscount;
    tax += itemTax;
  }
  if (
    proposal.subtotalCents !== subtotal ||
    proposal.discountCents !== discount ||
    proposal.taxCents !== tax ||
    proposal.totalCents !== subtotal - discount + tax + proposal.shippingCents
  ) {
    throw new B2bError("CONFLICT", "Proposal totals do not balance.");
  }
}

export function sha256(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}
