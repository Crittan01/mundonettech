import { beforeEach, describe, expect, it, vi } from "vitest";

import { expectMethodAllowlist, expectNoStoreNoIndex } from "./test-helpers";

const mocks = vi.hoisted(() => {
  class AdminAuthorizationError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    AdminAuthorizationError,
    adminActionLogCreate: vi.fn(),
    consumeAdminOperationRateLimit: vi.fn(),
    creditNoteFindFirst: vi.fn(),
    exportCsv: vi.fn(),
    getAdminSession: vi.fn(),
    getDatabaseClock: vi.fn(),
    getRequestSecurityContext: vi.fn(),
    invoiceFindFirst: vi.fn(),
    isAdminSelfDealingCustomer: vi.fn(),
    parseFinanceRange: vi.fn(),
  };
});

vi.mock("@mundonettech/db", () => ({
  OperationRateLimitError: class OperationRateLimitError extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super("Rate limit exceeded.");
    }
  },
  consumeAdminOperationRateLimit: mocks.consumeAdminOperationRateLimit,
  isAdminSelfDealingCustomer: mocks.isAdminSelfDealingCustomer,
}));
vi.mock("@/lib/security/admin-auth", () => ({
  AdminAuthorizationError: mocks.AdminAuthorizationError,
  getAdminSession: mocks.getAdminSession,
}));
vi.mock("@/lib/security/request-context", () => ({
  getRequestSecurityContext: mocks.getRequestSecurityContext,
}));
vi.mock("@/lib/db", () => ({
  getDatabase: () => ({
    adminActionLog: { create: mocks.adminActionLogCreate },
    creditNote: { findFirst: mocks.creditNoteFindFirst },
    taxInvoice: { findFirst: mocks.invoiceFindFirst },
  }),
}));
vi.mock("@/lib/database-clock", () => ({ getDatabaseClock: mocks.getDatabaseClock }));
vi.mock("@/lib/finance-params", () => ({ parseFinanceRange: mocks.parseFinanceRange }));
vi.mock("@/lib/finance", () => ({ financeService: () => ({ exportCsv: mocks.exportCsv }) }));

import * as documentRoute from "../../apps/web/app/admin/(protected)/facturacion/documentos/[kind]/[id]/route";
import * as financeRoute from "../../apps/web/app/admin/(protected)/finanzas/exportar/route";

const documentId = "12345678-1234-4123-8123-123456789abc";
const range = {
  from: new Date("2026-01-01T05:00:00.000Z"),
  to: new Date("2027-01-01T05:00:00.000Z"),
  fromDate: "2026-01-01",
  toDate: "2026-12-31",
  year: 2026,
};

function documentRequest(kind = "invoice", id = documentId): Promise<Response> {
  return documentRoute.GET(new Request("https://mundonettech.co/admin/facturacion/documentos"), {
    params: Promise.resolve({ kind, id }),
  });
}

function financeRequest(query = "from=2026-01-01&to=2026-12-31&year=2026"): Promise<Response> {
  return financeRoute.GET(new Request(`https://mundonettech.co/admin/finanzas/exportar?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdminSession.mockResolvedValue({
    profile: { id: "admin-id", authUserId: "auth-admin-id", email: "admin@example.test" },
  });
  mocks.getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32),
    userAgentHash: new Uint8Array(32),
  });
  mocks.adminActionLogCreate.mockResolvedValue({ id: "audit-id" });
  mocks.consumeAdminOperationRateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
  mocks.isAdminSelfDealingCustomer.mockResolvedValue(false);
  mocks.invoiceFindFirst.mockResolvedValue({
    fullNumber: "FAC-2026-1",
    signedXml: "<Invoice><ID>FAC-2026-1</ID></Invoice>",
    order: { customerId: "customer-1", emailSnapshot: "buyer@example.test" },
  });
  mocks.creditNoteFindFirst.mockResolvedValue({
    fullNumber: "NC-2026-1",
    signedXml: "<CreditNote><ID>NC-2026-1</ID></CreditNote>",
    invoice: { order: { customerId: "customer-1", emailSnapshot: "buyer@example.test" } },
  });
  mocks.getDatabaseClock.mockResolvedValue(new Date("2026-06-01T12:00:00.000Z"));
  mocks.parseFinanceRange.mockReturnValue(range);
  mocks.exportCsv.mockResolvedValue("orderNumber,capturedCents\r\nMNT-2026-0001,1000");
});

describe("admin fiscal document download", () => {
  it("defends the handler with RBAC, aal2 activity and recent MFA", async () => {
    const response = await documentRequest();
    expect(response.status).toBe(200);
    expect(mocks.getAdminSession).toHaveBeenCalledWith({
      permission: "invoices:read",
      requireRecentMfa: true,
    });
    expect(mocks.invoiceFindFirst).toHaveBeenCalledWith({
      where: { id: documentId, status: "ACCEPTED" },
      select: {
        fullNumber: true,
        signedXml: true,
        order: { select: { customerId: true, emailSnapshot: true } },
      },
    });
  });

  it.each(["NO_SESSION", "NO_PROFILE", "AAL1", "TIMEOUT", "MFA_STALE"])(
    "maps %s to 401 before document access",
    async (code) => {
      mocks.getAdminSession.mockRejectedValue(new mocks.AdminAuthorizationError(code));
      const response = await documentRequest();
      expect(response.status).toBe(401);
      expectNoStoreNoIndex(response);
      expect(await response.json()).toEqual({ error: "Unauthorized." });
      expect(mocks.invoiceFindFirst).not.toHaveBeenCalled();
    },
  );

  it("maps an authenticated role without invoices:read to 403", async () => {
    mocks.getAdminSession.mockRejectedValue(new mocks.AdminAuthorizationError("FORBIDDEN"));
    const response = await documentRequest();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden." });
    expect(mocks.invoiceFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["quote", documentId],
    ["invoice", "not-a-uuid"],
    ["credit-note", "------------------------------------"],
  ])("returns 404 for invalid kind or id without querying documents", async (kind, id) => {
    const response = await documentRequest(kind, id);
    expect(response.status).toBe(404);
    expect(mocks.invoiceFindFirst).not.toHaveBeenCalled();
    expect(mocks.creditNoteFindFirst).not.toHaveBeenCalled();
  });

  it("downloads only an accepted invoice XML with a bounded safe filename", async () => {
    mocks.invoiceFindFirst.mockResolvedValue({
      fullNumber: 'FAC/1"\r\nInjected: yes',
      signedXml: "<Invoice><Buyer>alice@example.test</Buyer></Invoice>",
      order: { customerId: "customer-1", emailSnapshot: "buyer@example.test" },
    });
    const response = await documentRequest();
    expect(response.status).toBe(200);
    expectNoStoreNoIndex(response);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+\.xml"$/,
    );
    expect(response.headers.get("content-disposition")).not.toContain("\r");
    expect(await response.text()).toBe("<Invoice><Buyer>alice@example.test</Buyer></Invoice>");
  });

  it("uses the credit-note repository and hides non-accepted or unsigned documents", async () => {
    const credit = await documentRequest("credit-note");
    expect(credit.status).toBe(200);
    expect(mocks.creditNoteFindFirst).toHaveBeenCalledWith({
      where: { id: documentId, status: "ACCEPTED" },
      select: {
        fullNumber: true,
        signedXml: true,
        invoice: { select: { order: { select: { customerId: true, emailSnapshot: true } } } },
      },
    });
    mocks.creditNoteFindFirst.mockResolvedValue({ fullNumber: "NC-1", signedXml: null });
    const missing = await documentRequest("credit-note");
    expect(missing.status).toBe(404);
  });

  it("rejects unsupported methods before authentication", async () => {
    await expectMethodAllowlist(documentRoute);
    expect(mocks.getAdminSession).not.toHaveBeenCalled();
  });
});

describe("admin finance CSV export", () => {
  it("requires finance:read and recent MFA in the route itself", async () => {
    const response = await financeRequest();
    expect(response.status).toBe(200);
    expect(mocks.getAdminSession).toHaveBeenCalledWith({
      permission: "finance:read",
      requireRecentMfa: true,
    });
    expect(mocks.parseFinanceRange).toHaveBeenCalledWith(
      { from: "2026-01-01", to: "2026-12-31", year: "2026" },
      2026,
    );
    expect(mocks.exportCsv).toHaveBeenCalledWith(range);
  });

  it.each(["NO_SESSION", "NO_PROFILE", "AAL1", "TIMEOUT", "MFA_STALE"])(
    "returns 401 for %s without reading financial data",
    async (code) => {
      mocks.getAdminSession.mockRejectedValue(new mocks.AdminAuthorizationError(code));
      const response = await financeRequest();
      expect(response.status).toBe(401);
      expectNoStoreNoIndex(response);
      expect(mocks.getDatabaseClock).not.toHaveBeenCalled();
      expect(mocks.exportCsv).not.toHaveBeenCalled();
    },
  );

  it("returns 403 for an authenticated unauthorized role", async () => {
    mocks.getAdminSession.mockRejectedValue(new mocks.AdminAuthorizationError("FORBIDDEN"));
    const response = await financeRequest();
    expect(response.status).toBe(403);
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });

  it("preserves service-side formula neutralization and emits a safe attachment", async () => {
    mocks.exportCsv.mockResolvedValue('orderNumber,note\r\nMNT-2026-0001,"\'=HYPERLINK()"');
    const response = await financeRequest();
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="finanzas-2026-01-01-2026-12-31.csv"',
    );
    expectNoStoreNoIndex(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain('"\'=HYPERLINK()"');
    expect(csv).not.toContain("alice@example.test");
  });

  it("rejects duplicate range parameters as ambiguous", async () => {
    const response = await financeRequest("from=2026-01-01&from=2026-01-02&to=2026-12-31");
    expect(response.status).toBe(400);
    expect(mocks.parseFinanceRange).not.toHaveBeenCalled();
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });

  it.each([new TypeError("bad date"), new RangeError("too large")])(
    "returns 400 for invalid or excessive ranges",
    async (error) => {
      mocks.parseFinanceRange.mockImplementation(() => {
        throw error;
      });
      const response = await financeRequest();
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid or excessive finance range." });
      expect(mocks.exportCsv).not.toHaveBeenCalled();
    },
  );

  it("returns 500 with sanitized JSON and security headers on unexpected failures", async () => {
    mocks.exportCsv.mockRejectedValue(new Error("private database detail"));
    const response = await financeRequest();
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
    const text = await response.text();
    expect(text).toContain("Finance export failed.");
    expect(text).not.toContain("private database detail");
  });

  it("rejects unsupported methods before authentication", async () => {
    await expectMethodAllowlist(financeRoute);
    expect(mocks.getAdminSession).not.toHaveBeenCalled();
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });
});
