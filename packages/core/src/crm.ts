import { normalizeEmail } from "./password-policy.js";

export const contactVerificationLevels = [
  "UNVERIFIED",
  "SINGLE_CHANNEL_VERIFIED",
  "DUAL_CHANNEL_VERIFIED",
  "IDENTITY_VERIFIED",
] as const;

export type ContactVerificationLevelValue = (typeof contactVerificationLevels)[number];
export type ContactIdentityKindValue = "EMAIL" | "PHONE" | "DOCUMENT";

const phonePattern = /^\+[1-9][0-9]{7,14}$/;
const documentPattern = /^[A-Z0-9.-]{5,30}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeContactPhone(value: string): string {
  const normalized = value.trim();
  if (!phonePattern.test(normalized)) {
    throw new TypeError("Contact phone must use E.164 format.");
  }
  return normalized;
}

export function normalizeContactIdentity(kind: ContactIdentityKindValue, value: string): string {
  if (typeof value !== "string") throw new TypeError("Contact identity must be a string.");
  if (kind === "EMAIL") return normalizeEmail(value);
  if (kind === "PHONE") return normalizeContactPhone(value);
  const normalized = value.trim().toUpperCase();
  if (!documentPattern.test(normalized)) {
    throw new TypeError("Contact document must contain 5 to 30 uppercase identifier characters.");
  }
  return normalized;
}

export function deriveContactVerificationLevel(input: {
  readonly emailVerified: boolean;
  readonly phoneVerified: boolean;
  readonly identityVerified?: boolean;
}): ContactVerificationLevelValue {
  const channels = Number(input.emailVerified) + Number(input.phoneVerified);
  if (input.identityVerified === true && channels === 2) return "IDENTITY_VERIFIED";
  if (channels === 2) return "DUAL_CHANNEL_VERIFIED";
  if (channels === 1) return "SINGLE_CHANNEL_VERIFIED";
  return "UNVERIFIED";
}

export function strongestContactVerificationLevel(
  left: ContactVerificationLevelValue,
  right: ContactVerificationLevelValue,
): ContactVerificationLevelValue {
  return contactVerificationLevels[
    Math.max(contactVerificationLevels.indexOf(left), contactVerificationLevels.indexOf(right))
  ]!;
}

export function contactPairKey(leftContactId: string, rightContactId: string): string {
  if (
    !uuidPattern.test(leftContactId) ||
    !uuidPattern.test(rightContactId) ||
    leftContactId === rightContactId
  ) {
    throw new TypeError("A contact pair requires two distinct canonical UUIDs.");
  }
  return [leftContactId, rightContactId].sort().join(":");
}

export function assertCrmRetentionMonths(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120) {
    throw new RangeError("CRM retention must be an integer between 1 and 120 months.");
  }
  return value;
}
