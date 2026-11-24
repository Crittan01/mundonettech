import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { optionalTrimmedText, phoneInputPattern } from "../../apps/web/lib/form-validation";

import { parseCoordinateE6 } from "../../packages/core/dist/index.js";
import { OperationRateLimitError, PaymentProvider } from "../../packages/db/dist/index.js";
import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentValidationError,
} from "../../packages/integrations/dist/index.js";
import {
  actionError,
  formSnapshot,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { loadActionModule } from "./a2-action-loader";

const mocks = {
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${path}` });
  }),
  checkout: vi.fn(),
  getReceiptByToken: vi.fn(),
  localDeliveryQuotes: vi.fn(),
  paymentStart: vi.fn(),
  resumeWompiCheckout: vi.fn(),
  synchronize: vi.fn(),
  creditGet: vi.fn(),
  isBlocked: vi.fn(),
  optionalCustomerId: vi.fn(),
  clearCartAccessToken: vi.fn(),
  orderFindUnique: vi.fn(),
  attemptFindMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  attemptFindFirst: vi.fn(),
  listCredentials: vi.fn(),
  consumeRateLimit: vi.fn(),
  getRequestSecurityContext: vi.fn(),
};

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const moduleMocks: Record<string, unknown> = {
  "@mundonettech/core": { parseCoordinateE6 },
  "@mundonettech/db": {
    OperationRateLimitError,
    PaymentProvider,
    consumeOperationRateLimit: mocks.consumeRateLimit,
  },
  "@mundonettech/integrations": {
    PaymentConflictError,
    PaymentNotFoundError,
    PaymentProviderError,
    PaymentValidationError,
  },
  "next/cache": { revalidatePath: mocks.revalidatePath, updateTag: mocks.updateTag },
  "next/navigation": { redirect: mocks.redirect },
  "@/lib/action-state": { actionError, formSnapshot, formString },
  "@/lib/cart": {
    clearCartAccessToken: mocks.clearCartAccessToken,
    optionalCustomerId: mocks.optionalCustomerId,
  },
  "@/lib/cart-token": { hashCartToken: () => new Uint8Array(32).fill(3) },
  "@/lib/checkout": {
    orderService: () => ({
      checkout: mocks.checkout,
      getReceiptByToken: mocks.getReceiptByToken,
      localDeliveryQuotes: mocks.localDeliveryQuotes,
    }),
    readCheckoutCartReference: async () => ({ accessTokenHash: new Uint8Array(32).fill(2) }),
    receiptTokenForSubmission: () => "r".repeat(43),
  },
  "@/lib/checkout-errors": { checkoutMutationMessage: () => "No pudimos confirmar el pedido." },
  "@/lib/db": {
    getDatabase: () => ({
      order: { findUnique: mocks.orderFindUnique },
      paymentAttempt: { findMany: mocks.attemptFindMany, findFirst: mocks.attemptFindFirst },
      paymentTransaction: { findFirst: mocks.transactionFindFirst },
    }),
  },
  "@/lib/env": { getSecurityEventPepper: () => new Uint8Array(32).fill(9) },
  "@/lib/form-validation": { optionalTrimmedText, phoneInputPattern },
  "@/lib/integrations": {
    blockedIdentityService: () => ({ isBlocked: mocks.isBlocked }),
    getBankTransferInstructions: () => "Transferencia bancaria de prueba configurada",
    getIntegrationCredentialVault: () => ({
      list: mocks.listCredentials,
      forSystemProvider: () => ({ list: mocks.listCredentials }),
    }),
    getIntegrationEnvironment: () => "LOCAL",
    getPublicSiteUrl: () => "https://mundonettech.co",
    paymentService: () => ({
      start: mocks.paymentStart,
      resumeWompiCheckout: mocks.resumeWompiCheckout,
    }),
    storeCreditService: () => ({ get: mocks.creditGet }),
    wompiWebhookService: () => ({ synchronize: mocks.synchronize }),
  },
  "@/lib/legal": {
    getConfiguredLegalDocument: (slug: string) => ({ slug, version: "2026-01", content: "legal" }),
  },
  "@/lib/payment-identities": {
    documentIdentityHash: (document: string) => documentHash(document),
    emailIdentityHash: () => new Uint8Array(32).fill(4),
    phoneIdentityHash: () => new Uint8Array(32).fill(5),
  },
  "@/lib/security/request-context": {
    getRequestSecurityContext: mocks.getRequestSecurityContext,
  },
};
const checkoutActions = loadActionModule<Record<string, ServerAction>>("checkout", moduleMocks);
const paymentActions = loadActionModule<Record<string, ServerAction>>("payments", moduleMocks);

function requiredAction(registry: Record<string, ServerAction>, name: string): ServerAction {
  const action = registry[name];
  if (!action) throw new TypeError(`Missing Server Action export: ${name}`);
  return action;
}

const confirmCheckoutAction = requiredAction(checkoutActions, "confirmCheckoutAction");
const resumeWompiPaymentAction = requiredAction(paymentActions, "resumeWompiPaymentAction");
const startReceiptPaymentAction = requiredAction(paymentActions, "startReceiptPaymentAction");
const verifyWompiPaymentAction = requiredAction(paymentActions, "verifyWompiPaymentAction");

const idle: ActionState = { status: "idle", message: "" };
const orderId = "11111111-1111-4111-8111-111111111111";
const customerId = "22222222-2222-4222-8222-222222222222";
const otherCustomerId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const submissionId = "55555555-5555-4555-8555-555555555555";
const paymentAttemptId = "66666666-6666-4666-8666-666666666666";
const credentialId = "77777777-7777-4777-8777-777777777777";
const token = "t".repeat(43);

function documentHash(document: string): Uint8Array {
  return Uint8Array.from(
    createHmac("sha256", new Uint8Array(32).fill(9))
      .update(`DOCUMENT:${document.toUpperCase()}`, "utf8")
      .digest(),
  );
}

function checkoutForm(document = "abc"): FormData {
  const form = new FormData();
  form.set("submissionId", submissionId);
  form.set("reviewFingerprint", "a".repeat(64));
  form.set("fulfillmentMethod", "HOME_DELIVERY");
  form.set("paymentMethod", "COD");
  form.set("wompiCredentialId", "");
  form.set("email", "cliente@example.co");
  form.set("givenName", "Nombre");
  form.set("familyName", "Apellido");
  form.set("recipientName", "Nombre Apellido");
  form.set("phoneE164", "+573001234567");
  form.set("buyerDocumentType", "13");
  form.set("buyerDocumentNumber", document);
  form.set("buyerTaxRegime", "");
  form.set("departmentCode", "05");
  form.set("municipalityCode", "05001");
  form.set("addressLine1", "Calle 123 # 45-67");
  form.set("addressLine2", "");
  form.set("neighborhood", "");
  form.set("postalCode", "");
  form.set("clickCollectLocationId", "");
  form.set("localDeliveryZoneId", "");
  form.set("deliveryLatitude", "");
  form.set("deliveryLongitude", "");
  form.set("deliveryNotes", "");
  form.set("termsAccepted", "true");
  form.set("dataProcessingAccepted", "true");
  form.set("amountCents", "1");
  return form;
}

function receiptPaymentForm(paymentMethod: string): FormData {
  const form = new FormData();
  form.set("token", token);
  form.set("operationId", operationId);
  form.set("paymentMethod", paymentMethod);
  form.set("wompiCredentialId", "");
  form.set("amountCents", "1");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkout.mockResolvedValue({
    orderId,
    orderNumber: "MNT-2026-0001",
    receiptNumber: "R-MNT-2026-0001",
    totalCents: "10000",
    paymentStatus: "UNPAID",
    replayed: false,
  });
  mocks.paymentStart.mockResolvedValue({ checkoutUrl: null, replayed: false });
  mocks.isBlocked.mockResolvedValue(false);
  mocks.getReceiptByToken.mockResolvedValue({
    orderId,
    orderStatus: "CONFIRMED",
    paymentStatus: "UNPAID",
    totalCents: "10000",
    emailSnapshot: "cliente@example.co",
    phoneE164Snapshot: "+573001234567",
  });
  mocks.orderFindUnique.mockResolvedValue({ customerId, buyerDocumentNumberSnapshot: "abc" });
  mocks.attemptFindMany.mockResolvedValue([]);
  mocks.optionalCustomerId.mockResolvedValue(customerId);
  mocks.creditGet.mockResolvedValue({ active: true, availableCents: "5000" });
  mocks.resumeWompiCheckout.mockResolvedValue({ checkoutUrl: "https://checkout.wompi.co/abc" });
  mocks.synchronize.mockResolvedValue({ status: "PROCESSED" });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, remaining: 1 });
  mocks.getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32).fill(6),
    userAgentHash: new Uint8Array(32).fill(7),
  });
});

describe("A2 — identidades COD y autoridad de checkout", () => {
  it("incluye el documento de tres caracteres en ambos controles y omite el monto del navegador", async () => {
    await expect(confirmCheckoutAction(idle, checkoutForm())).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mocks.isBlocked).toHaveBeenCalledWith({
      EMAIL: new Uint8Array(32).fill(4),
      PHONE: new Uint8Array(32).fill(5),
      DOCUMENT: documentHash("abc"),
    });
    expect(mocks.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedReviewFingerprint: "a".repeat(64),
        contact: expect.objectContaining({ buyerDocumentNumber: "abc" }),
      }),
    );
    expect(mocks.paymentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        idempotencyKey: `checkout:${submissionId}`,
        identityHashes: {
          EMAIL: new Uint8Array(32).fill(4),
          PHONE: new Uint8Array(32).fill(5),
          DOCUMENT: documentHash("abc"),
        },
      }),
    );
    expect(mocks.paymentStart.mock.calls[0]?.[0]).not.toHaveProperty("amountCents");
  });

  it("bloquea la orden antes de reservar stock cuando cualquier identidad está bloqueada", async () => {
    mocks.isBlocked.mockResolvedValueOnce(true);

    const result = await confirmCheckoutAction(idle, checkoutForm("XYZ"));

    expect(result.status).toBe("error");
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.paymentStart).not.toHaveBeenCalled();
    expect(result.message).toContain("no está disponible");
  });
});

describe("A2 — pagos desde comprobante y titularidad", () => {
  it("usa el documento sellado en la orden y nunca un monto enviado por el cliente", async () => {
    await expect(startReceiptPaymentAction(idle, receiptPaymentForm("COD"))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mocks.orderFindUnique).toHaveBeenCalledWith({
      where: { id: orderId },
      select: { customerId: true, buyerDocumentNumberSnapshot: true },
    });
    expect(mocks.paymentStart).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        idempotencyKey: `receipt:${orderId}:${operationId}`,
        identityHashes: {
          EMAIL: new Uint8Array(32).fill(4),
          PHONE: new Uint8Array(32).fill(5),
          DOCUMENT: documentHash("abc"),
        },
      }),
    );
    expect(mocks.paymentStart.mock.calls[0]?.[0]).not.toHaveProperty("amountCents");
  });

  it("rechaza crédito de otra cuenta y limita el débito al saldo leído en servidor", async () => {
    mocks.orderFindUnique.mockResolvedValueOnce({
      customerId: otherCustomerId,
      buyerDocumentNumberSnapshot: "abc",
    });
    const forbidden = await startReceiptPaymentAction(idle, receiptPaymentForm("STORE_CREDIT"));
    expect(forbidden.status).toBe("error");
    expect(mocks.paymentStart).not.toHaveBeenCalled();
    expect(mocks.creditGet).not.toHaveBeenCalled();

    await expect(
      startReceiptPaymentAction(idle, receiptPaymentForm("STORE_CREDIT")),
    ).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(mocks.creditGet).toHaveBeenCalledWith(customerId);
    expect(mocks.paymentStart).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000n }),
    );
  });

  it("liga reanudación y sincronización Wompi al pedido del comprobante", async () => {
    const resume = new FormData();
    resume.set("token", token);
    resume.set("paymentAttemptId", paymentAttemptId);
    await expect(resumeWompiPaymentAction(idle, resume)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mocks.resumeWompiCheckout).toHaveBeenCalledWith({
      paymentAttemptId,
      orderId,
      returnUrl: `https://mundonettech.co/recibo/${token}`,
    });

    mocks.attemptFindFirst.mockResolvedValueOnce({ credentialId });
    const verify = new FormData();
    verify.set("token", token);
    verify.set("externalId", "wompi_external_123");
    await expect(verifyWompiPaymentAction(idle, verify)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mocks.synchronize).toHaveBeenCalledWith({
      externalId: "wompi_external_123",
      environment: "LOCAL",
      credentialId,
      expectedOrderId: orderId,
    });
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(3);
    expect(Math.max(...mocks.consumeRateLimit.mock.invocationCallOrder)).toBeLessThan(
      mocks.synchronize.mock.invocationCallOrder[0]!,
    );
  });

  it("devuelve Retry-After y nunca consulta Wompi después de agotar la cuota", async () => {
    mocks.attemptFindFirst.mockResolvedValueOnce({ credentialId });
    mocks.consumeRateLimit.mockResolvedValueOnce({
      allowed: true,
      retryAfterSeconds: 0,
      remaining: 4,
    });
    mocks.consumeRateLimit.mockRejectedValueOnce(new OperationRateLimitError(23, 0));
    const verify = new FormData();
    verify.set("token", token);
    verify.set("externalId", "wompi_external_123");

    const result = (await verifyWompiPaymentAction(idle, verify)) as ActionState & {
      retryAfterSeconds?: number;
    };

    expect(result).toMatchObject({ status: "error", retryAfterSeconds: 23 });
    expect(result.message).toContain("23 segundos");
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("no crea bucket ni consulta Wompi cuando la IP verificada no está disponible", async () => {
    mocks.attemptFindFirst.mockResolvedValueOnce({ credentialId });
    mocks.getRequestSecurityContext.mockRejectedValueOnce(new Error("unverified proxy"));
    const verify = new FormData();
    verify.set("token", token);
    verify.set("externalId", "wompi_external_123");

    const result = await verifyWompiPaymentAction(idle, verify);

    expect(result.status).toBe("error");
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("rechaza una referencia persistida de otro pedido antes de la cuota por pedido y del proveedor", async () => {
    mocks.transactionFindFirst.mockResolvedValueOnce({
      attempt: { orderId: "99999999-9999-4999-8999-999999999999", credentialId },
    });
    const verify = new FormData();
    verify.set("token", token);
    verify.set("externalId", "wompi_external_123");

    const result = await verifyWompiPaymentAction(idle, verify);

    expect(result.status).toBe("error");
    expect(mocks.attemptFindFirst).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: "payments.wompi.verify.ip" }),
    );
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it("no devuelve respuestas crudas del proveedor al fallar la sincronización", async () => {
    mocks.attemptFindFirst.mockResolvedValueOnce({ credentialId });
    mocks.synchronize.mockRejectedValueOnce(
      new PaymentProviderError("secret provider payload", "INVALID_RESPONSE"),
    );
    const verify = new FormData();
    verify.set("token", token);
    verify.set("externalId", "wompi_external_123");

    const result = await verifyWompiPaymentAction(idle, verify);

    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret provider payload");
  });
});
