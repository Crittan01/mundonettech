import { describe, expect, it, vi } from "vitest";

import {
  adminNavigation,
  adminRoles,
  formatCopCents,
  formatSignedCopCents,
  hasAdminPermission,
  parseCsv,
  serializeCsv,
} from "../../packages/core/dist/index.js";
import {
  FinanceService,
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
      expect(canReadNotificationCategory(role, "crm.tasks")).toBe(
        hasAdminPermission(role, "crm:read"),
      );
      expect(canReadNotificationCategory(role, "crm.merges")).toBe(
        hasAdminPermission(role, "crm:merge"),
      );
      expect(canReadNotificationCategory(role, "b2b.opportunities")).toBe(
        hasAdminPermission(role, "b2b:read"),
      );
      expect(canReadNotificationCategory(role, "channels.reauth")).toBe(
        hasAdminPermission(role, "integrations:read"),
      );
      expect(canReadNotificationCategory(role, "channels.sync")).toBe(
        hasAdminPermission(role, "integrations:read"),
      );
      expect(canReadNotificationCategory(role, "channels.orders")).toBe(
        hasAdminPermission(role, "integrations:read"),
      );
      expect(canReadNotificationCategory(role, "meta.capi")).toBe(
        hasAdminPermission(role, "integrations:read"),
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
      expect(canReadNotificationCategory(role, "health.backup")).toBe(
        hasAdminPermission(role, "audit:read"),
      );
      expect(canReadNotificationCategory(role, "health.recovery")).toBe(
        hasAdminPermission(role, "audit:read"),
      );
      expect(navigation.some((item) => item.href === "/admin/salud")).toBe(
        hasAdminPermission(role, "audit:read"),
      );
      expect(canReadNotificationCategory(role, "operations.general")).toBe(true);
      expect(canReadNotificationCategory(role, "security.unclassified")).toBe(false);
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
    expect(() => formatSignedCopCents(-9_223_372_036_854_775_808n)).not.toThrow();
    expect(() => formatSignedCopCents(-9_223_372_036_854_775_809n)).toThrow(RangeError);
  });

  it("neutralizes spreadsheet formulas in finance CSV cells", () => {
    const csv = serializeCsv([["=1+1"], ["  @cmd"], ["\t-2"], ["\r=3"], ["safe"]]);
    expect(parseCsv(csv).map((record) => record.cells[0]?.[0])).toEqual(["'", "'", "'", "'", "s"]);
  });

  it("reads finance totals and rows from one repeatable-read snapshot", async () => {
    const executeRaw = vi.fn(async () => 0);
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ orderCount: 0n }])
      .mockResolvedValueOnce([]);
    const transaction = vi.fn(
      async (
        callback: (tx: {
          $executeRaw: typeof executeRaw;
          $queryRaw: typeof queryRaw;
        }) => Promise<unknown>,
        options: { isolationLevel: string },
      ) => {
        expect(options).toEqual({
          isolationLevel: "RepeatableRead",
          maxWait: 10_000,
          timeout: 120_000,
        });
        return callback({ $executeRaw: executeRaw, $queryRaw: queryRaw });
      },
    );
    const service = new FinanceService({ $transaction: transaction } as never, {
      uvtValueCents: 5_237_400n,
      uvtYear: 2026,
      thresholdUvt: 3500,
    });

    await expect(service.report(currentYearRange(2026))).resolves.toMatchObject({
      summary: { orderCount: 0 },
      rows: [],
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
