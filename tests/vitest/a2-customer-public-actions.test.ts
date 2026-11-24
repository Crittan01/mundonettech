import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { optionalTrimmedText, phoneInputPattern } from "../../apps/web/lib/form-validation";

import * as core from "../../packages/core/dist/index.js";
import * as db from "../../packages/db/dist/index.js";
import {
  actionError,
  actionSuccess,
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
  claimAssistedCart: vi.fn(),
  cartForMutation: vi.fn(),
  existingCartReference: vi.fn(),
  createReferralCode: vi.fn(),
  attributeReferral: vi.fn(),
  clearReferralCode: vi.fn(),
  consumeReferralPath: vi.fn(),
  requireCustomerPage: vi.fn(),
  updateProfile: vi.fn(),
  updateAddress: vi.fn(),
  createAddress: vi.fn(),
  deleteAddress: vi.fn(),
  anonymize: vi.fn(),
  signInWithOtp: vi.fn(),
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  verifyTurnstileToken: vi.fn(),
  recordSecurityEvent: vi.fn(),
  synchronizeCustomerProfile: vi.fn(),
  establishCustomerActivity: vi.fn(),
  clearActivityCookies: vi.fn(),
  clearCustomerCartCookie: vi.fn(),
  establishCustomerAuthRequest: vi.fn(),
  readCustomerAuthRequest: vi.fn(),
  clearCustomerAuthRequest: vi.fn(),
  clearGuestOrderSession: vi.fn(),
  captureOpportunity: vi.fn(),
  getPublicProposal: vi.fn(),
  checkout: vi.fn(),
};

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const moduleMocks: Record<string, unknown> = {
  "@mundonettech/core": core,
  "@mundonettech/db": db,
  "next/cache": { revalidatePath: mocks.revalidatePath, updateTag: mocks.updateTag },
  "next/navigation": { redirect: mocks.redirect },
  "@/lib/action-state": { actionError, actionSuccess, formSnapshot, formString },
  "@/lib/cart": {
    cartForMutation: mocks.cartForMutation,
    claimAssistedCart: mocks.claimAssistedCart,
    existingCartReference: mocks.existingCartReference,
  },
  "@/lib/cart-errors": { cartMutationMessage: () => "No pudimos actualizar el carrito." },
  "@/lib/db": { getDatabase: () => ({}) },
  "@/lib/growth": {
    growthService: () => ({
      createReferralCode: mocks.createReferralCode,
      attributeReferral: mocks.attributeReferral,
    }),
  },
  "@/lib/account": {
    accountService: () => ({
      updateProfile: mocks.updateProfile,
      updateAddress: mocks.updateAddress,
      createAddress: mocks.createAddress,
      deleteAddress: mocks.deleteAddress,
      anonymize: mocks.anonymize,
    }),
  },
  "@/lib/security/customer-auth": { requireCustomerPage: mocks.requireCustomerPage },
  "@/lib/security/referral": {
    clearReferralCode: mocks.clearReferralCode,
    consumeReferralPath: mocks.consumeReferralPath,
  },
  "@/lib/security/request-context": {
    getRequestSecurityContext: async () => ({
      ipHash: new Uint8Array(32).fill(1),
      userAgentHash: new Uint8Array(32).fill(2),
    }),
    recordSecurityEvent: mocks.recordSecurityEvent,
  },
  "@/lib/security/activity-cookies": {
    clearActivityCookies: mocks.clearActivityCookies,
    clearCustomerCartCookie: mocks.clearCustomerCartCookie,
    establishCustomerActivity: mocks.establishCustomerActivity,
  },
  "@/lib/security/customer-profile": {
    synchronizeCustomerProfile: mocks.synchronizeCustomerProfile,
  },
  "@/lib/security/customer-auth-request": {
    establishCustomerAuthRequest: mocks.establishCustomerAuthRequest,
    readCustomerAuthRequest: mocks.readCustomerAuthRequest,
    clearCustomerAuthRequest: mocks.clearCustomerAuthRequest,
  },
  "@/lib/security/guest-order-access": { clearGuestOrderSession: mocks.clearGuestOrderSession },
  "@/lib/security/hibp": { isPasswordCompromised: async () => false },
  "@/lib/security/outbound-email": { isServerOutboundEmailDisabled: () => false },
  "@/lib/security/turnstile": { verifyTurnstileToken: mocks.verifyTurnstileToken },
  "@/lib/supabase/server": {
    createSupabaseServerClient: async () => ({
      auth: {
        signInWithOtp: mocks.signInWithOtp,
        signUp: mocks.signUp,
        resetPasswordForEmail: mocks.resetPasswordForEmail,
        verifyOtp: mocks.verifyOtp,
        updateUser: mocks.updateUser,
        signOut: mocks.signOut,
      },
    }),
  },
  "@/lib/b2b": {
    b2bService: () => ({
      captureOpportunity: mocks.captureOpportunity,
      getPublicProposal: mocks.getPublicProposal,
    }),
    hashProposalToken: () => new Uint8Array(32).fill(3),
    receiptTokenForProposal: () => "r".repeat(43),
    sha256: (value: string) => Uint8Array.from(createHash("sha256").update(value).digest()),
  },
  "@/lib/checkout": { orderService: () => ({ checkout: mocks.checkout }) },
  "@/lib/checkout-errors": { checkoutMutationMessage: () => "No pudimos confirmar." },
  "@/lib/form-validation": { optionalTrimmedText, phoneInputPattern },
  "@/lib/legal": {
    getConfiguredLegalDocument: (slug: string) => ({ slug, version: "2026-01", content: "legal" }),
  },
};

const cartActions = loadActionModule<Record<string, ServerAction>>("cart", moduleMocks);
const growthActions = loadActionModule<Record<string, ServerAction>>("growth", moduleMocks);
const accountActions = loadActionModule<Record<string, ServerAction>>("account", moduleMocks);
const customerAuthActions = loadActionModule<Record<string, ServerAction>>(
  "customer-auth",
  moduleMocks,
);
const b2bActions = loadActionModule<Record<string, ServerAction>>("b2b-public", moduleMocks);

function requiredAction(registry: Record<string, ServerAction>, name: string): ServerAction {
  const action = registry[name];
  if (!action) throw new TypeError(`Missing Server Action export: ${name}`);
  return action;
}

const claimAssistedCartAction = requiredAction(cartActions, "claimAssistedCartAction");
const addCartVariantAction = requiredAction(cartActions, "addCartVariantAction");
const attributeReferralAction = requiredAction(growthActions, "attributeReferralAction");
const createReferralCodeAction = requiredAction(growthActions, "createReferralCodeAction");
const updateProfileAction = requiredAction(accountActions, "updateProfileAction");
const anonymizeAccountAction = requiredAction(accountActions, "anonymizeAccountAction");
const requestCustomerOtpAction = requiredAction(customerAuthActions, "requestCustomerOtpAction");
const verifyCustomerOtpAction = requiredAction(customerAuthActions, "verifyCustomerOtpAction");
const resetCustomerPasswordAction = requiredAction(
  customerAuthActions,
  "resetCustomerPasswordAction",
);
const cancelCustomerAuthRequestAction = requiredAction(
  customerAuthActions,
  "cancelCustomerAuthRequestAction",
);
const acceptB2bProposalAction = requiredAction(b2bActions, "acceptB2bProposalAction");
const captureB2bOpportunityAction = requiredAction(b2bActions, "captureB2bOpportunityAction");

const idle: ActionState = { status: "idle", message: "" };
const customerId = "11111111-1111-4111-8111-111111111111";
const otherCustomerId = "22222222-2222-4222-8222-222222222222";
const submissionId = "33333333-3333-4333-8333-333333333333";
const proposalId = "44444444-4444-4444-8444-444444444444";
const opportunityId = "55555555-5555-4555-8555-555555555555";
const cartId = "66666666-6666-4666-8666-666666666666";
const token = "t".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCustomerPage.mockResolvedValue({ profile: { id: customerId } });
  mocks.attributeReferral.mockResolvedValue({ replayed: false });
  mocks.createReferralCode.mockResolvedValue({ code: "23456789ABCD", replayed: false });
  mocks.updateProfile.mockResolvedValue({
    id: customerId,
    updatedAt: new Date("2026-11-24T12:00:00.000Z"),
  });
  mocks.anonymize.mockResolvedValue({
    customerId,
    anonymizedAt: new Date("2026-11-24T12:00:00.000Z"),
    affectedReviewProductSlugs: ["producto-a", "producto-b"],
  });
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.readCustomerAuthRequest.mockResolvedValue({ purpose: "login", email: "cookie@example.co" });
  mocks.verifyTurnstileToken.mockResolvedValue(undefined);
  mocks.captureOpportunity.mockResolvedValue({ opportunityId, replayed: false });
  mocks.getPublicProposal.mockResolvedValue({
    id: proposalId,
    opportunityId,
    version: 1,
    available: true,
    cartId,
    contact: {
      email: "servidor@empresa.co",
      givenName: "Contacto",
      familyName: "Servidor",
      phoneE164: "+573001234567",
      documentNumber: "900123456",
    },
  });
  mocks.checkout.mockResolvedValue({
    orderId: "77777777-7777-4777-8777-777777777777",
    orderNumber: "MNT-2026-0001",
    receiptNumber: "R-MNT-2026-0001",
    totalCents: "10000",
    paymentStatus: "UNPAID",
    replayed: false,
  });
});

describe("A2 — carrito, cuenta y crecimiento", () => {
  it("no devuelve el token asistido en errores y limita la longitud numérica antes del DAL", async () => {
    mocks.claimAssistedCart.mockRejectedValueOnce(new TypeError("invalid token"));
    const claim = new FormData();
    claim.set("token", token);
    claim.set("origin", "catalog");
    const result = await claimAssistedCartAction(idle, claim);
    expect(result.status).toBe("error");
    expect(result.values).toEqual({ origin: "catalog" });
    expect(JSON.stringify(result)).not.toContain(token);

    const add = new FormData();
    add.set("variantId", customerId);
    add.set("quantity", "10000000");
    const rejected = await addCartVariantAction(idle, add);
    expect(rejected.status).toBe("error");
    expect(mocks.cartForMutation).not.toHaveBeenCalled();
  });

  it("valida referidos cerrados y siempre atribuye al cliente autenticado", async () => {
    const invalid = new FormData();
    invalid.set("code", "x".repeat(10_000));
    const rejected = await attributeReferralAction(idle, invalid);
    expect(rejected.status).toBe("error");
    expect(JSON.stringify(rejected)).not.toContain("x".repeat(100));
    expect(mocks.attributeReferral).not.toHaveBeenCalled();

    const valid = new FormData();
    valid.set("code", "23456789abcd");
    valid.set("customerId", otherCustomerId);
    const attributed = await attributeReferralAction(idle, valid);
    expect(attributed.status).toBe("success");
    expect(mocks.attributeReferral).toHaveBeenCalledWith(customerId, "23456789abcd");
    expect(mocks.clearReferralCode).toHaveBeenCalledOnce();

    const created = await createReferralCodeAction(idle, new FormData());
    expect(created.status).toBe("success");
    expect(mocks.createReferralCode).toHaveBeenCalledWith(customerId);
  });

  it("actualiza perfil con timestamp del titular y devuelve conflictos obsoletos seguros", async () => {
    const form = new FormData();
    form.set("customerId", otherCustomerId);
    form.set("expectedUpdatedAt", "2026-11-24T11:00:00.000Z");
    form.set("givenName", "Nombre");
    form.set("familyName", "Apellido");
    form.set("phoneE164", "+573001234567");
    form.set("marketingEmail", "on");

    const result = await updateProfileAction(idle, form);

    expect(result.status).toBe("success");
    expect(result.values).toEqual({ expectedUpdatedAt: "2026-11-24T12:00:00.000Z" });
    expect(mocks.updateProfile).toHaveBeenCalledWith(
      customerId,
      {
        givenName: "Nombre",
        familyName: "Apellido",
        phoneE164: "+573001234567",
        marketingEmail: true,
        advertising: false,
      },
      new Date("2026-11-24T11:00:00.000Z"),
      { ipHash: new Uint8Array(32).fill(1), userAgentHash: new Uint8Array(32).fill(2) },
    );

    mocks.updateProfile.mockRejectedValueOnce(new db.AccountError("CONFLICT", "stale internal"));
    const conflict = await updateProfileAction(idle, form);
    expect(conflict.status).toBe("error");
    expect(conflict.message).toContain("cambió en otra sesión");
    expect(conflict.message).not.toContain("stale internal");
  });

  it("invalida reseñas globales y por producto después de anonimizar", async () => {
    const form = new FormData();
    form.set("confirmation", "ELIMINAR MI CUENTA");

    await expect(anonymizeAccountAction(idle, form)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mocks.anonymize).toHaveBeenCalledWith(customerId, "ELIMINAR MI CUENTA", {
      ipHash: new Uint8Array(32).fill(1),
      userAgentHash: new Uint8Array(32).fill(2),
    });
    expect(mocks.updateTag.mock.calls.map(([tag]) => tag)).toEqual([
      "reviews",
      "reviews:producto-a",
      "reviews:producto-b",
    ]);
    expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/producto/producto-a",
      "/producto/producto-b",
    ]);
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.clearActivityCookies).toHaveBeenCalledOnce();
    expect(mocks.clearCustomerCartCookie).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/ingresar?reason=anonymized");
  });
});

describe("A2 — autenticación cliente y mensajes uniformes", () => {
  it("exige Turnstile, usa OTP sin crear cuentas y guarda solo estado cifrado de login", async () => {
    const form = new FormData();
    form.set("email", " CLIENTE@Example.CO ");
    form.set("turnstileToken", "captcha-token");

    const result = await requestCustomerOtpAction(idle, form);

    expect(result.status).toBe("success");
    expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith("captcha-token", {
      expectedAction: "customer_login",
    });
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "cliente@example.co",
      options: { shouldCreateUser: false },
    });
    expect(mocks.establishCustomerAuthRequest).toHaveBeenCalledWith("login", "cliente@example.co");
  });

  it("ignora correo y modo inyectados y registra OTP fallido sin PII ni respuesta Auth", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "private auth response cliente@example.co" },
    });
    const form = new FormData();
    form.set("email", "atacante@example.co");
    form.set("code", "123456");
    form.set("mode", "recovery");
    form.set("turnstileToken", "captcha-token");

    const result = await verifyCustomerOtpAction(idle, form);

    expect(result.status).toBe("error");
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: "cookie@example.co",
      token: "123456",
      type: "email",
    });
    expect(JSON.stringify(result)).not.toContain("private auth response");
    expect(JSON.stringify(result)).not.toContain("cookie@example.co");
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventType: "CUSTOMER_OTP_FAILED",
        context: { ipHash: new Uint8Array(32).fill(1), userAgentHash: new Uint8Array(32).fill(2) },
      }),
    );
    expect(mocks.synchronizeCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.establishCustomerActivity).not.toHaveBeenCalled();
    expect(mocks.clearCustomerAuthRequest).not.toHaveBeenCalled();
  });

  it("consume el estado solo con OTP válido y activa la sesión del correo protegido", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { user: { id: customerId }, session: { access_token: "session" } },
      error: null,
    });
    const form = new FormData();
    form.set("code", "123456");
    form.set("turnstileToken", "captcha-token");

    await expect(verifyCustomerOtpAction(idle, form)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mocks.clearCustomerAuthRequest).toHaveBeenCalledOnce();
    expect(mocks.synchronizeCustomerProfile).toHaveBeenCalledWith(customerId, "cookie@example.co");
    expect(mocks.establishCustomerActivity).toHaveBeenCalledWith(customerId);
  });

  it("bloquea páginas sin solicitud y cancela limpiando el estado antes de redirigir", async () => {
    mocks.readCustomerAuthRequest.mockResolvedValueOnce(null);
    const form = new FormData();
    form.set("code", "123456");
    form.set("turnstileToken", "captcha-token");
    const missing = await verifyCustomerOtpAction(idle, form);
    expect(missing.status).toBe("error");
    expect(missing.message).toContain("expiró");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.clearCustomerAuthRequest).toHaveBeenCalledOnce();

    mocks.readCustomerAuthRequest.mockResolvedValueOnce({
      purpose: "recovery",
      email: "cookie@example.co",
    });
    await expect(cancelCustomerAuthRequestAction(idle, new FormData())).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mocks.clearCustomerAuthRequest).toHaveBeenCalledTimes(2);
    expect(mocks.redirect).toHaveBeenLastCalledWith("/recuperar");
  });

  it("liga el reset al propósito recovery y consume el estado antes de actualizar", async () => {
    mocks.readCustomerAuthRequest.mockResolvedValueOnce({
      purpose: "recovery",
      email: "reset@example.co",
    });
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { user: { id: customerId }, session: { access_token: "session" } },
      error: null,
    });
    mocks.updateUser.mockResolvedValueOnce({ error: null });
    const form = new FormData();
    form.set("code", "123456");
    form.set("password", "ClaveSegura123!");
    form.set("confirmation", "ClaveSegura123!");
    form.set("turnstileToken", "captcha-token");
    form.set("email", "atacante@example.co");

    await expect(resetCustomerPasswordAction(idle, form)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: "reset@example.co",
      token: "123456",
      type: "recovery",
    });
    expect(mocks.clearCustomerAuthRequest).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "ClaveSegura123!" });
  });
});

describe("A2 — canal público B2B", () => {
  function leadForm(): FormData {
    const form = new FormData();
    form.set("submissionId", submissionId);
    form.set("legalName", "Empresa Ejemplo SAS");
    form.set("commercialName", "Ejemplo");
    form.set("taxId", "900123456");
    form.set("givenName", "Contacto");
    form.set("familyName", "Comercial");
    form.set("email", "contacto@empresa.co");
    form.set("phoneE164", "+573001234567");
    form.set("requirements", "Necesitamos veinte equipos para la operación");
    form.set("dataProcessingAccepted", "true");
    form.set("turnstileToken", "captcha-secret");
    form.set("website", "");
    return form;
  }

  it("exige consentimiento y Turnstile, y nunca devuelve su token en errores", async () => {
    mocks.captureOpportunity.mockRejectedValueOnce(new db.B2bError("VALIDATION", "raw internal"));
    const result = await captureB2bOpportunityAction(idle, leadForm());
    expect(result.status).toBe("error");
    expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith("captcha-secret", {
      expectedAction: "b2b_lead",
    });
    expect(result.values?.turnstileToken).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("captcha-secret");
    expect(JSON.stringify(result)).not.toContain("raw internal");
  });

  it("aplica allowlist y errores por campo sin reflejar PII ni campos inyectados", async () => {
    const form = leadForm();
    form.set("email", "correo-invalido");
    form.set("internalNote", "secreto-interno-no-serializar");
    const result = await captureB2bOpportunityAction(idle, form);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("error");
    expect(result.values).toEqual({ submissionId });
    expect(result.fieldErrors).toEqual({ email: ["Revisa este campo."] });
    for (const privateValue of [
      "Empresa Ejemplo SAS",
      "900123456",
      "contacto@empresa.co",
      "+573001234567",
      "Necesitamos veinte equipos",
      "captcha-secret",
      "secreto-interno-no-serializar",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
    expect(mocks.captureOpportunity).not.toHaveBeenCalled();
  });

  it("toma contacto, documento y carrito desde la propuesta del servidor", async () => {
    const form = new FormData();
    form.set("submissionId", submissionId);
    form.set("proposalId", proposalId);
    form.set("token", token);
    form.set("reviewFingerprint", "b".repeat(64));
    form.set("recipientName", "Recepción Servidor");
    form.set("signerName", "Firmante Autorizado");
    form.set("signerDocumentType", "13");
    form.set("signerDocumentNumber", "123");
    form.set("buyerDocumentType", "31");
    form.set("buyerTaxRegime", "NO_RESPONSABLE_IVA");
    form.set("departmentCode", "05");
    form.set("municipalityCode", "05001");
    form.set("addressLine1", "Calle 123 # 45-67");
    form.set("addressLine2", "");
    form.set("neighborhood", "");
    form.set("postalCode", "");
    form.set("deliveryNotes", "");
    form.set("termsAccepted", "true");
    form.set("dataProcessingAccepted", "true");
    form.set("signatureAccepted", "true");
    form.set("email", "atacante@example.co");
    form.set("phoneE164", "+573099999999");
    form.set("cartId", otherCustomerId);

    await expect(acceptB2bProposalAction(idle, form)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mocks.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        cart: { cartId },
        contact: expect.objectContaining({
          email: "servidor@empresa.co",
          phoneE164: "+573001234567",
          buyerDocumentNumber: "900123456",
        }),
        b2bAcceptance: {
          proposalId,
          signerName: "Firmante Autorizado",
          signerDocumentType: "13",
          signerDocumentNumber: "123",
        },
      }),
    );
  });

  it("no refleja el token de propuesta cuando el enlace deja de estar disponible", async () => {
    mocks.getPublicProposal.mockResolvedValueOnce(null);
    const form = new FormData();
    form.set("submissionId", submissionId);
    form.set("proposalId", proposalId);
    form.set("token", token);
    form.set("reviewFingerprint", "b".repeat(64));
    form.set("recipientName", "Recepción Servidor");
    form.set("signerName", "Firmante Autorizado");
    form.set("signerDocumentType", "13");
    form.set("signerDocumentNumber", "123");
    form.set("buyerDocumentType", "31");
    form.set("buyerTaxRegime", "NO_RESPONSABLE_IVA");
    form.set("departmentCode", "05");
    form.set("municipalityCode", "05001");
    form.set("addressLine1", "Calle 123 # 45-67");
    form.set("addressLine2", "");
    form.set("neighborhood", "");
    form.set("postalCode", "");
    form.set("deliveryNotes", "");
    form.set("termsAccepted", "true");
    form.set("dataProcessingAccepted", "true");
    form.set("signatureAccepted", "true");

    const result = await acceptB2bProposalAction(idle, form);

    expect(result.status).toBe("error");
    expect(result.values).toEqual({ submissionId });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("Firmante Autorizado");
    expect(JSON.stringify(result)).not.toContain("Calle 123 # 45-67");
  });
});
