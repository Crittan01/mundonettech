import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatCopCents } from "../../packages/core/dist/index.js";
import { ReceiptBalanceError } from "../../packages/db/dist/index.js";
import { expectMethodAllowlist, expectNoStoreNoIndex } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  creditNoteFindFirst: vi.fn(),
  credentialList: vi.fn(),
  creditGet: vi.fn(),
  getDatabaseClock: vi.fn(),
  getReceiptByToken: vi.fn(),
  hashCartToken: vi.fn((token: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError("invalid token");
    return Uint8Array.from([1, 2, 3]);
  }),
  invoiceFindFirst: vi.fn(),
  listOrderPayments: vi.fn(),
  optionalCustomerId: vi.fn(),
  orderFindUnique: vi.fn(),
  paymentAttemptFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/components/orders/receipt-payment-panel", () => ({
  ReceiptPaymentPanel: () => null,
}));
vi.mock("@/lib/cart", () => ({ optionalCustomerId: mocks.optionalCustomerId }));
vi.mock("@/lib/cart-token", () => ({ hashCartToken: mocks.hashCartToken }));
vi.mock("@/lib/checkout", () => ({
  orderService: () => ({ getReceiptByToken: mocks.getReceiptByToken }),
}));
vi.mock("@/lib/database-clock", () => ({ getDatabaseClock: mocks.getDatabaseClock }));
vi.mock("@/lib/db", () => ({
  getDatabase: () => ({
    creditNote: { findFirst: mocks.creditNoteFindFirst },
    order: { findUnique: mocks.orderFindUnique },
    paymentAttempt: { findMany: mocks.paymentAttemptFindMany },
    taxInvoice: { findFirst: mocks.invoiceFindFirst },
  }),
}));
vi.mock("@/lib/integrations", () => ({
  getBankTransferInstructions: () => null,
  getIntegrationCredentialVault: () => ({
    forSystemProvider: () => ({ list: mocks.credentialList }),
  }),
  paymentService: () => ({ listOrderPayments: mocks.listOrderPayments }),
  storeCreditService: () => ({ get: mocks.creditGet }),
}));
vi.mock("@/lib/payment-identities", () => ({
  documentIdentityHash: () => new Uint8Array(32),
  emailIdentityHash: () => new Uint8Array(32),
  phoneIdentityHash: () => new Uint8Array(32),
}));

import * as documentRoute from "../../apps/web/app/api/recibos/[token]/documentos/[kind]/[id]/route";
import * as downloadRoute from "../../apps/web/app/api/recibos/[token]/descargar/route";
import ReceiptPage from "../../apps/web/app/(storefront)/recibo/[token]/page";
import { ReceiptPaymentPanel } from "../../apps/web/components/orders/receipt-payment-panel";

const token = "A".repeat(43);
const documentId = "12345678-1234-4123-8123-123456789abc";
const receipt = {
  id: "receipt-id",
  orderId: "order-id",
  orderNumber: "MNT-2026-0001",
  receiptNumber: "R-MNT-2026-0001",
  issuedAt: "2026-01-02T03:04:05.000Z",
  orderStatus: "CONFIRMED",
  paymentStatus: "UNPAID",
  fulfillmentMethod: "HOME_DELIVERY",
  taxRegime: "NO_RESPONSABLE_IVA",
  currency: "COP",
  emailSnapshot: "alice@example.test",
  recipientNameSnapshot: "Alice",
  phoneE164Snapshot: "+573001234567",
  departmentNameSnapshot: "Bogotá",
  municipalityNameSnapshot: "Bogotá",
  addressLine1Snapshot: "Calle 1",
  addressLine2Snapshot: null,
  neighborhoodSnapshot: null,
  postalCodeSnapshot: null,
  deliveryNotesSnapshot: null,
  pickupLocationName: null,
  couponCodeSnapshot: null as string | null,
  subtotalCents: "1000",
  wholesaleDiscountCents: "0",
  bundleDiscountCents: "0",
  couponDiscountCents: "0",
  discountCents: "0",
  taxCents: "0",
  shippingCents: "0",
  totalCents: "1000",
  deliveryPromiseAt: "2026-01-05T03:04:05.000Z",
  items: [
    {
      id: "item-id",
      skuSnapshot: "SKU-1",
      titleSnapshot: "Producto real",
      productSlugSnapshot: "producto-real",
      quantity: 1,
      unitPriceCents: "1000",
      unitCostWacCents: "987654321",
      discountCents: "0",
      lineTotalCents: "1000",
      taxCents: "0",
      totalCents: "1000",
      taxLines: [
        {
          id: "tax-id",
          taxGroupCode: "EXCLUIDO",
          taxGroupName: "Excluido",
          treatment: "EXCLUDED",
          rule: "NOT_RESPONSABLE",
          catalogRateBps: 0,
          appliedRateBps: 0,
          uvtLimit: null,
          uvtValueCents: "0",
          uvtYear: null,
          unitValueCents: "1000",
          taxableBaseCents: "1000",
          taxCents: "0",
        },
      ],
    },
  ],
};

function downloadRequest(value = token): Promise<Response> {
  return downloadRoute.GET(new Request("https://mundonettech.co/api/recibos/token/descargar"), {
    params: Promise.resolve({ token: value }),
  });
}

function documentRequest(kind = "invoice", id = documentId, value = token): Promise<Response> {
  return documentRoute.GET(new Request("https://mundonettech.co/api/recibos/token/documentos"), {
    params: Promise.resolve({ token: value, kind, id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credentialList.mockResolvedValue({ items: [] });
  mocks.creditGet.mockResolvedValue(null);
  mocks.getDatabaseClock.mockResolvedValue(new Date("2026-02-01T12:00:00.000Z"));
  mocks.listOrderPayments.mockResolvedValue([]);
  mocks.optionalCustomerId.mockResolvedValue(null);
  mocks.orderFindUnique.mockResolvedValue({ customerId: null });
  mocks.paymentAttemptFindMany.mockResolvedValue([]);
  mocks.getReceiptByToken.mockResolvedValue(structuredClone(receipt));
  mocks.invoiceFindFirst.mockResolvedValue({
    fullNumber: "FAC-2026-1",
    signedXml: "<Invoice><ID>FAC-2026-1</ID></Invoice>",
  });
  mocks.creditNoteFindFirst.mockResolvedValue({
    fullNumber: "NC-2026-1",
    signedXml: "<CreditNote><ID>NC-2026-1</ID></CreditNote>",
  });
});

interface PaymentPanelProps {
  readonly allowNewPayment: boolean;
  readonly uncommittedCents: string;
  readonly resumableWompiAttemptId: string | null;
}

function findPaymentPanelProps(node: ReactNode): PaymentPanelProps | null {
  if (!isValidElement(node)) return null;
  if (node.type === ReceiptPaymentPanel) return node.props as PaymentPanelProps;
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Children.toArray(children)) {
    const found = findPaymentPanelProps(child);
    if (found) return found;
  }
  return null;
}

async function receiptPaymentProps(): Promise<PaymentPanelProps> {
  const page = await ReceiptPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({}),
  });
  const props = findPaymentPanelProps(page);
  if (!props) throw new Error("Receipt payment panel was not rendered.");
  return props;
}

describe("receipt text download", () => {
  it("uses the hashed capability token and emits a no-store attachment", async () => {
    const response = await downloadRequest();
    expect(response.status).toBe(200);
    expect(mocks.hashCartToken).toHaveBeenCalledWith(token);
    expect(mocks.getReceiptByToken).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]));
    expectNoStoreNoIndex(response);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="R-MNT-2026-0001.txt"',
    );
    const body = await response.text();
    expect(body).toContain("COMPROBANTE DE COMPRA NO FISCAL");
    expect(body).toContain("Pago pendiente (UNPAID)");
    expect(body).toContain("alice@example.test");
    expect(body).not.toContain("987654321");
  });

  it("flattens snapshot controls and bidi overrides instead of allowing receipt line injection", async () => {
    const malicious = structuredClone(receipt);
    malicious.receiptNumber = 'R-1"\r\nX-Injected: yes';
    malicious.recipientNameSnapshot = "Alice\r\nTOTAL: $0";
    malicious.emailSnapshot = "alice@example.test\u202e";
    malicious.addressLine1Snapshot = "Calle 1\r\nPago: PAID";
    malicious.items[0]!.titleSnapshot = "Producto\nTOTAL: $0";
    malicious.items[0]!.taxLines[0]!.taxGroupCode = "IVA\r\nTOTAL: $0";
    malicious.couponCodeSnapshot = "SAVE\r\nTOTAL: $0";
    mocks.getReceiptByToken.mockResolvedValue(malicious);
    const response = await downloadRequest();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+\.txt"$/,
    );
    const body = await response.text();
    expect(body).not.toContain("\r\nTOTAL: $0");
    expect(body).not.toContain("\r\nPago: PAID");
    expect(body).not.toContain("\u202e");
    expect(body).toContain("Cliente: Alice  TOTAL: $0");
    expect(body).toContain(`TOTAL: ${formatCopCents("1000")}`);
  });

  it("returns 404 for malformed or unknown tokens", async () => {
    const malformed = await downloadRequest("invalid");
    expect(malformed.status).toBe(404);
    expectNoStoreNoIndex(malformed);
    mocks.getReceiptByToken.mockResolvedValue(null);
    const missing = await downloadRequest();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });

  it("blocks an unbalanced receipt with 409 and no document contents", async () => {
    mocks.getReceiptByToken.mockRejectedValue(new ReceiptBalanceError());
    const response = await downloadRequest();
    expect(response.status).toBe(409);
    expectNoStoreNoIndex(response);
    expect(await response.json()).toEqual({
      error: "Receipt verification failed and was blocked for operational review.",
    });
  });

  it("rejects unsupported methods without resolving the capability", async () => {
    await expectMethodAllowlist(downloadRoute);
    expect(mocks.hashCartToken).not.toHaveBeenCalled();
    expect(mocks.getReceiptByToken).not.toHaveBeenCalled();
  });
});

describe("receipt fiscal XML downloads", () => {
  it("scopes an invoice to the order authorized by the receipt token", async () => {
    const response = await documentRequest();
    expect(response.status).toBe(200);
    expect(mocks.invoiceFindFirst).toHaveBeenCalledWith({
      where: { id: documentId, orderId: "order-id", status: "ACCEPTED" },
      select: { fullNumber: true, signedXml: true },
    });
    expectNoStoreNoIndex(response);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="FAC-2026-1.xml"',
    );
    expect(await response.text()).toBe("<Invoice><ID>FAC-2026-1</ID></Invoice>");
  });

  it("scopes a credit note through its invoice ownership", async () => {
    const response = await documentRequest("credit-note");
    expect(response.status).toBe(200);
    expect(mocks.creditNoteFindFirst).toHaveBeenCalledWith({
      where: { id: documentId, status: "ACCEPTED", invoice: { orderId: "order-id" } },
      select: { fullNumber: true, signedXml: true },
    });
    expect(await response.text()).toContain("CreditNote");
  });

  it.each([
    ["quote", documentId],
    ["invoice", "not-a-uuid"],
  ])("rejects invalid kind or id before hashing the token", async (kind, id) => {
    const response = await documentRequest(kind, id);
    expect(response.status).toBe(404);
    expect(mocks.hashCartToken).not.toHaveBeenCalled();
    expect(mocks.getReceiptByToken).not.toHaveBeenCalled();
  });

  it("returns 404 for malformed, unknown or integrity-blocked receipts", async () => {
    expect((await documentRequest("invoice", documentId, "invalid")).status).toBe(404);
    mocks.getReceiptByToken.mockResolvedValue(null);
    expect((await documentRequest()).status).toBe(404);
    mocks.getReceiptByToken.mockRejectedValue(new ReceiptBalanceError());
    expect((await documentRequest()).status).toBe(404);
    expect(mocks.invoiceFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when the id belongs to another order or is not accepted", async () => {
    mocks.invoiceFindFirst.mockResolvedValue(null);
    const response = await documentRequest();
    expect(response.status).toBe(404);
    expectNoStoreNoIndex(response);
  });

  it("sanitizes the signed document filename", async () => {
    mocks.invoiceFindFirst.mockResolvedValue({
      fullNumber: 'FAC/1"\r\nInjected: yes',
      signedXml: "<Invoice />",
    });
    const response = await documentRequest();
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+\.xml"$/,
    );
  });

  it("rejects unsupported methods without token or document access", async () => {
    await expectMethodAllowlist(documentRoute);
    expect(mocks.hashCartToken).not.toHaveBeenCalled();
    expect(mocks.getReceiptByToken).not.toHaveBeenCalled();
    expect(mocks.invoiceFindFirst).not.toHaveBeenCalled();
  });
});

describe("receipt payment clock", () => {
  it("uses PostgreSQL time instead of a skewed Node clock for commitments and Wompi resume", async () => {
    mocks.invoiceFindFirst.mockResolvedValue(null);
    const attempt = {
      id: "wompi-attempt-id",
      provider: "WOMPI",
      status: "REQUIRES_ACTION",
      amountCents: 1000n,
      expiresAt: new Date("2026-01-15T12:00:00.000Z"),
      transactions: [],
    };
    mocks.paymentAttemptFindMany.mockResolvedValue([attempt]);
    mocks.listOrderPayments.mockResolvedValue([attempt]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      mocks.getDatabaseClock.mockResolvedValue(new Date("2026-02-01T12:00:00.000Z"));
      await expect(receiptPaymentProps()).resolves.toMatchObject({
        allowNewPayment: true,
        uncommittedCents: "1000",
        resumableWompiAttemptId: null,
      });

      vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
      mocks.getDatabaseClock.mockResolvedValue(new Date("2026-01-01T12:00:00.000Z"));
      await expect(receiptPaymentProps()).resolves.toMatchObject({
        allowNewPayment: false,
        uncommittedCents: "0",
        resumableWompiAttemptId: attempt.id,
      });
      expect(mocks.getDatabaseClock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
