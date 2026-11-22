import { describe, expect, it } from "vitest";

import {
  adminNavigation,
  adminRoles,
  formatCopCents,
  formatSignedCopCents,
  hasAdminPermission,
} from "../../packages/core/dist/index.js";
import {
  bogotaDayStart,
  canReadNotificationCategory,
  currentYearRange,
} from "../../packages/db/dist/index.js";

describe("F4A.1 — RBAC for operational and finance surfaces", () => {
  it("keeps finance restricted, scopes notification categories by role, and blocks CMS order access", () => {
    for (const role of adminRoles) {
      const navigation = adminNavigation(role);
      expect(navigation.some((item) => item.href === "/admin/hoy")).toBe(true);
      expect(navigation.some((item) => item.href === "/admin/dashboard")).toBe(true);
      expect(hasAdminPermission(role, "finance:read")).toBe(
        ["SUPERADMIN", "OPERATIONS_MANAGER", "FINANCE_ANALYST"].includes(role),
      );
      expect(navigation.some((item) => item.href === "/admin/finanzas")).toBe(
        hasAdminPermission(role, "finance:read"),
      );
      expect(canReadNotificationCategory(role, "orders.fulfillment")).toBe(
        hasAdminPermission(role, "orders:read"),
      );
      expect(canReadNotificationCategory(role, "shipping.promise")).toBe(
        hasAdminPermission(role, "orders:read"),
      );
      expect(canReadNotificationCategory(role, "postsale.returns")).toBe(
        hasAdminPermission(role, "postsale:read"),
      );
      expect(canReadNotificationCategory(role, "postsale.support")).toBe(
        hasAdminPermission(role, "postsale:read"),
      );
      expect(canReadNotificationCategory(role, "reviews.moderation")).toBe(
        hasAdminPermission(role, "reviews:read"),
      );
      expect(canReadNotificationCategory(role, "payments.review")).toBe(
        hasAdminPermission(role, "payments:read"),
      );
      expect(canReadNotificationCategory(role, "refunds.review")).toBe(
        hasAdminPermission(role, "payments:read"),
      );
      expect(canReadNotificationCategory(role, "fiscal.threshold")).toBe(
        hasAdminPermission(role, "finance:read"),
      );
      expect(canReadNotificationCategory(role, "outbox.failed")).toBe(
        hasAdminPermission(role, "audit:read"),
      );
      expect(canReadNotificationCategory(role, "operations.general")).toBe(true);
    }
    expect(hasAdminPermission("FULFILLMENT", "orders:read")).toBe(true);
    expect(hasAdminPermission("CUSTOMER_SUPPORT", "orders:read")).toBe(true);
    expect(hasAdminPermission("CMS_EDITOR", "orders:read")).toBe(false);
    expect(hasAdminPermission("CMS_EDITOR", "finance:read")).toBe(false);
    expect(adminNavigation("CMS_EDITOR").some((item) => item.href === "/admin/pedidos")).toBe(
      false,
    );
  });
});

describe("F4A.1 — exact local dates and signed financial presentation", () => {
  it("uses fixed UTC-5 Bogota boundaries without floating point arithmetic", () => {
    expect(bogotaDayStart("2026-01-01").toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(bogotaDayStart("2024-02-29").toISOString()).toBe("2024-02-29T05:00:00.000Z");
    expect(() => bogotaDayStart("2023-02-29")).toThrow(RangeError);
    const range = currentYearRange(2026);
    expect(range.from.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(range.to.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("formats negative margins without weakening the non-negative COP formatter", () => {
    expect(formatSignedCopCents(-123_456n)).toBe(`-${formatCopCents(123_456n)}`);
    expect(formatSignedCopCents(0n)).toBe(formatCopCents(0n));
    expect(() => formatCopCents(-1n)).toThrow(RangeError);
    expect(() => formatSignedCopCents(-9_223_372_036_854_775_808n)).toThrow(RangeError);
  });
});
