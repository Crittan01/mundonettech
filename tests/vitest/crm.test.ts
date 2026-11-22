import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  adminRoles,
  assertCrmRetentionMonths,
  contactPairKey,
  deriveContactVerificationLevel,
  hasAdminPermission,
  normalizeContactIdentity,
  strongestContactVerificationLevel,
} from "../../packages/core/dist/index.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("F4B.1 — CRM identity and authorization contracts", () => {
  it("normalizes identities and rejects malformed channels", () => {
    expect(normalizeContactIdentity("EMAIL", " Persona@Example.CO ")).toBe("persona@example.co");
    expect(normalizeContactIdentity("PHONE", "+573001234567")).toBe("+573001234567");
    expect(normalizeContactIdentity("DOCUMENT", "cc-1020304050")).toBe("CC-1020304050");
    expect(() => normalizeContactIdentity("PHONE", "3001234567")).toThrow(TypeError);
    expect(() => normalizeContactIdentity("DOCUMENT", "  ")).toThrow(TypeError);
    expect(() => normalizeContactIdentity("EMAIL", "not-an-email")).toThrow();
  });

  it("derives exactly four verification levels without skipping dual-channel evidence", () => {
    expect(deriveContactVerificationLevel({ emailVerified: false, phoneVerified: false })).toBe(
      "UNVERIFIED",
    );
    expect(deriveContactVerificationLevel({ emailVerified: true, phoneVerified: false })).toBe(
      "SINGLE_CHANNEL_VERIFIED",
    );
    expect(deriveContactVerificationLevel({ emailVerified: false, phoneVerified: true })).toBe(
      "SINGLE_CHANNEL_VERIFIED",
    );
    expect(deriveContactVerificationLevel({ emailVerified: true, phoneVerified: true })).toBe(
      "DUAL_CHANNEL_VERIFIED",
    );
    expect(
      deriveContactVerificationLevel({
        emailVerified: true,
        phoneVerified: true,
        identityVerified: true,
      }),
    ).toBe("IDENTITY_VERIFIED");
    expect(
      deriveContactVerificationLevel({
        emailVerified: true,
        phoneVerified: false,
        identityVerified: true,
      }),
    ).toBe("SINGLE_CHANNEL_VERIFIED");
    expect(strongestContactVerificationLevel("SINGLE_CHANNEL_VERIFIED", "IDENTITY_VERIFIED")).toBe(
      "IDENTITY_VERIFIED",
    );
  });

  it("canonicalizes pair locks and retention limits", () => {
    expect(contactPairKey(secondId, firstId)).toBe(`${firstId}:${secondId}`);
    expect(contactPairKey(firstId, secondId)).toBe(`${firstId}:${secondId}`);
    expect(() => contactPairKey(firstId, firstId)).toThrow(TypeError);
    expect(assertCrmRetentionMonths(24)).toBe(24);
    expect(() => assertCrmRetentionMonths(0)).toThrow(RangeError);
    expect(() => assertCrmRetentionMonths(121)).toThrow(RangeError);
    expect(() => assertCrmRetentionMonths(1.5)).toThrow(RangeError);
  });

  it("separates CRM readers, writers and Ring 1 sensitive operations", () => {
    const readers = [
      "SUPERADMIN",
      "OPERATIONS_MANAGER",
      "STORE_MANAGER",
      "CUSTOMER_SUPPORT",
      "FINANCE_ANALYST",
    ];
    const writers = ["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER", "CUSTOMER_SUPPORT"];
    const sensitive = ["SUPERADMIN", "OPERATIONS_MANAGER"];
    for (const role of adminRoles) {
      expect(hasAdminPermission(role, "crm:read")).toBe(readers.includes(role));
      expect(hasAdminPermission(role, "crm:write")).toBe(writers.includes(role));
      expect(hasAdminPermission(role, "crm:merge")).toBe(sensitive.includes(role));
      expect(hasAdminPermission(role, "crm:suppress")).toBe(sensitive.includes(role));
      expect(adminNavigation(role).some((item) => item.href === "/admin/crm")).toBe(
        readers.includes(role),
      );
    }
  });
});
