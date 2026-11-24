import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostSaleError } from "../../packages/db/dist/index.js";
import { GuestOrderAccessError } from "../../packages/integrations/dist/index.js";
import {
  actionError,
  actionSuccess,
  formString,
  type ActionState,
} from "../../apps/web/lib/action-state";
import { loadActionModule } from "./a2-action-loader";

const mocks = {
  revalidatePath: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${path}` });
  }),
  requestReturn: vi.fn(),
  requestWarranty: vi.fn(),
  createReview: vi.fn(),
  createSupportTicket: vi.fn(),
  replySupportTicket: vi.fn(),
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  revokeSession: vi.fn(),
  getGuestOrderAccess: vi.fn(),
  establishGuestOrderSession: vi.fn(),
  clearGuestOrderSession: vi.fn(),
  requireCustomerPage: vi.fn(),
  getRequestSecurityContext: vi.fn(),
};

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const actions = loadActionModule<Record<string, ServerAction>>("postsale", {
  "@mundonettech/db": { PostSaleError },
  "@mundonettech/integrations": { GuestOrderAccessError },
  "next/cache": { revalidatePath: mocks.revalidatePath },
  "next/navigation": { redirect: mocks.redirect },
  "@/lib/action-state": { actionError, actionSuccess, formString },
  "@/lib/account": {
    postSaleService: () => ({
      requestReturn: mocks.requestReturn,
      requestWarranty: mocks.requestWarranty,
      createReview: mocks.createReview,
      createSupportTicket: mocks.createSupportTicket,
      replySupportTicket: mocks.replySupportTicket,
    }),
  },
  "@/lib/integrations": {
    guestOrderAccessService: () => ({
      requestCode: mocks.requestCode,
      verifyCode: mocks.verifyCode,
      revokeSession: mocks.revokeSession,
    }),
  },
  "@/lib/security/customer-auth": { requireCustomerPage: mocks.requireCustomerPage },
  "@/lib/security/guest-order-access": {
    clearGuestOrderSession: mocks.clearGuestOrderSession,
    establishGuestOrderSession: mocks.establishGuestOrderSession,
    getGuestOrderAccess: mocks.getGuestOrderAccess,
  },
  "@/lib/security/request-context": {
    getRequestSecurityContext: mocks.getRequestSecurityContext,
  },
});

function requiredAction(name: string): ServerAction {
  const action = actions[name];
  if (!action) throw new TypeError(`Missing Server Action export: ${name}`);
  return action;
}

const createReviewAction = requiredAction("createReviewAction");
const createSupportTicketAction = requiredAction("createSupportTicketAction");
const replySupportTicketAction = requiredAction("replySupportTicketAction");
const requestGuestCodeAction = requiredAction("requestGuestCodeAction");
const requestReturnAction = requiredAction("requestReturnAction");
const requestWarrantyAction = requiredAction("requestWarrantyAction");
const verifyGuestCodeAction = requiredAction("verifyGuestCodeAction");

const idle: ActionState = { status: "idle", message: "" };
const orderId = "11111111-1111-4111-8111-111111111111";
const otherOrderId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const challengeId = "55555555-5555-4555-8555-555555555555";
const shipmentItemId = "66666666-6666-4666-8666-666666666666";
const orderItemId = "77777777-7777-4777-8777-777777777777";
const ticketId = "88888888-8888-4888-8888-888888888888";
const token = "a".repeat(43);
const guestActor = { kind: "GUEST", guestSessionId: sessionId } as const;

function guestForm(order = otherOrderId): FormData {
  const form = new FormData();
  form.set("channel", "guest");
  form.set("token", token);
  form.set("orderId", order);
  form.set("idempotencyKey", "request-key");
  return form;
}

function accountForm(order = orderId): FormData {
  const form = new FormData();
  form.set("channel", "account");
  form.set("orderId", order);
  form.set("idempotencyKey", "request-key");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGuestOrderAccess.mockResolvedValue({ actor: guestActor, orderId });
  mocks.requireCustomerPage.mockResolvedValue({ profile: { id: customerId } });
  mocks.getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32).fill(1),
    userAgentHash: null,
  });
  mocks.requestReturn.mockResolvedValue({ replayed: false });
  mocks.requestWarranty.mockResolvedValue({ replayed: false });
  mocks.createReview.mockResolvedValue({ replayed: false });
  mocks.createSupportTicket.mockResolvedValue({ ticketNumber: "PQR-2026-1", replayed: false });
  mocks.replySupportTicket.mockResolvedValue({ replayed: false });
});

describe("A2 — titularidad y validación de acciones de posventa", () => {
  it("deriva el pedido de devoluciones desde la sesión de invitado y nunca devuelve el token", async () => {
    const form = guestForm();
    form.set("kind", "REFUND");
    form.set("reason", "Producto recibido con fallas");
    form.set("items", JSON.stringify([{ shipmentItemId, quantity: 1, serializedUnitIds: [] }]));
    mocks.requestReturn.mockRejectedValueOnce(new PostSaleError("CONFLICT", "changed"));

    const result = await requestReturnAction(idle, form);

    expect(mocks.requestReturn).toHaveBeenCalledWith(guestActor, {
      orderId,
      kind: "REFUND",
      reason: "Producto recibido con fallas",
      idempotencyKey: "request-key",
      items: [{ shipmentItemId, quantity: 1, replacementVariantId: null, serializedUnitIds: [] }],
    });
    expect(result.status).toBe("error");
    expect(result.values?.token).toBeUndefined();
    expect(result.values?.orderId).toBe(otherOrderId);
  });

  it("fuerza el pedido de PQR de invitado aunque el campo oculto se altere o se omita", async () => {
    for (const suppliedOrderId of [otherOrderId, ""]) {
      const form = guestForm(suppliedOrderId);
      form.set("kind", "CLAIM");
      form.set("subject", "Pedido incompleto");
      form.set("message", "Faltan accesorios incluidos en la oferta");

      const result = await createSupportTicketAction(idle, form);

      expect(result.status).toBe("success");
      expect(mocks.createSupportTicket).toHaveBeenCalledWith(
        guestActor,
        expect.objectContaining({ orderId }),
      );
      expect(result.values).toBeUndefined();
    }
  });

  it("bloquea una sesión de invitado expirada antes de tocar el servicio", async () => {
    mocks.getGuestOrderAccess.mockResolvedValueOnce(null);
    const form = guestForm();
    form.set("serializedUnitId", shipmentItemId);
    form.set("issueDescription", "El equipo no enciende");
    form.set("remedy", "REPAIR");

    const result = await requestWarrantyAction(idle, form);

    expect(result).toMatchObject({ status: "error", message: expect.stringMatching(/expiró/) });
    expect(result.values?.token).toBeUndefined();
    expect(mocks.requestWarranty).not.toHaveBeenCalled();
  });

  it("exige UUID en operaciones de cuenta pero conserva PQR generales sin pedido", async () => {
    const invalid = accountForm("not-a-uuid");
    invalid.set("serializedUnitId", shipmentItemId);
    invalid.set("issueDescription", "El equipo no enciende");
    invalid.set("remedy", "REPAIR");
    const rejected = await requestWarrantyAction(idle, invalid);
    expect(rejected.status).toBe("error");
    expect(mocks.requestWarranty).not.toHaveBeenCalled();

    const general = accountForm("");
    general.set("kind", "QUERY");
    general.set("subject", "Consulta de privacidad");
    general.set("message", "Solicito información sobre mis datos");
    const created = await createSupportTicketAction(idle, general);
    expect(created.status).toBe("success");
    expect(mocks.createSupportTicket).toHaveBeenCalledWith(
      { kind: "CUSTOMER", customerId },
      expect.objectContaining({ orderId: null }),
    );

    const reply = accountForm("");
    reply.set("ticketId", ticketId);
    reply.set("body", "Agrego información para continuar");
    reply.set("expectedVersion", "2");
    const replied = await replySupportTicketAction(idle, reply);
    expect(replied.status).toBe("success");
    expect(mocks.replySupportTicket).toHaveBeenCalledWith(
      { kind: "CUSTOMER", customerId },
      expect.objectContaining({ ticketId, expectedVersion: 2 }),
    );
  });

  it("rechaza JSON con campos desconocidos, ratings con coerción y cargas excesivas", async () => {
    const invalidJson = guestForm();
    invalidJson.set("kind", "REFUND");
    invalidJson.set("reason", "Producto recibido con fallas");
    invalidJson.set(
      "items",
      JSON.stringify([{ shipmentItemId, quantity: 1, serializedUnitIds: [], admin: true }]),
    );
    const rejectedJson = await requestReturnAction(idle, invalidJson);
    expect(rejectedJson.status).toBe("error");
    expect(rejectedJson.values?.token).toBeUndefined();
    expect(mocks.requestReturn).not.toHaveBeenCalled();

    const review = guestForm();
    review.set("orderItemId", orderItemId);
    review.set("rating", "0x5");
    review.set("title", "Compra verificada");
    review.set("body", "La experiencia de compra fue satisfactoria");
    review.set("authorDisplayName", "Cliente");
    const rejectedRating = await createReviewAction(idle, review);
    expect(rejectedRating.status).toBe("error");
    expect(mocks.createReview).not.toHaveBeenCalled();

    const oversized = guestForm();
    oversized.set("kind", "REFUND");
    oversized.set("reason", "Producto recibido con fallas");
    oversized.set("items", " ".repeat(4_000_001));
    const rejectedSize = await requestReturnAction(idle, oversized);
    expect(rejectedSize.status).toBe("error");
    expect(rejectedSize.values?.items).toBeUndefined();
    expect(rejectedSize.values?.token).toBeUndefined();
    expect(mocks.requestReturn).not.toHaveBeenCalled();
  });

  it("no refleja mensajes internos que coincidan parcialmente con errores de sesión", async () => {
    mocks.requestWarranty.mockRejectedValueOnce(
      new Error("driver sesión de posventa postgres://usuario:secreto@interno"),
    );
    const form = guestForm();
    form.set("serializedUnitId", shipmentItemId);
    form.set("issueDescription", "El equipo no enciende");
    form.set("remedy", "REPAIR");

    const result = await requestWarrantyAction(idle, form);

    expect(result.status).toBe("error");
    expect(result.message).not.toContain("postgres");
    expect(result.message).not.toContain("secreto");
    expect(result.message).toBe(
      "No pudimos completar la solicitud. Inténtalo de nuevo sin reenviar el formulario.",
    );
  });
});

describe("A2 — segundo factor de invitado", () => {
  it("limita el contexto de solicitud a hash y no expone el token en el estado", async () => {
    mocks.requestCode.mockResolvedValueOnce({ challengeId, delivered: true, replayed: false });
    const form = new FormData();
    form.set("token", token);
    form.set("idempotencyKey", "guest-code-key");

    const result = await requestGuestCodeAction(idle, form);

    expect(mocks.requestCode).toHaveBeenCalledWith({
      token,
      idempotencyKey: "guest-code-key",
      ipHash: new Uint8Array(32).fill(1),
    });
    expect(result).toMatchObject({ status: "success", values: { challengeId } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("uniforma el límite de solicitudes sin filtrar respuestas del proveedor", async () => {
    mocks.requestCode.mockRejectedValueOnce(
      new GuestOrderAccessError("RATE_LIMIT", "provider raw"),
    );
    const form = new FormData();
    form.set("token", token);
    form.set("idempotencyKey", "guest-code-key");

    const result = await requestGuestCodeAction(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("límite de códigos");
    expect(JSON.stringify(result)).not.toContain("provider raw");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("crea la sesión de invitado solo después de verificar el desafío", async () => {
    const expiresAt = new Date("2026-11-24T20:00:00.000Z");
    mocks.verifyCode.mockResolvedValueOnce({ sessionToken: "session-secret", expiresAt });
    const form = new FormData();
    form.set("token", token);
    form.set("challengeId", challengeId);
    form.set("code", "123456");

    await expect(verifyGuestCodeAction(idle, form)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mocks.verifyCode).toHaveBeenCalledWith({
      token,
      challengeId,
      code: "123456",
      ipHash: new Uint8Array(32).fill(1),
    });
    expect(mocks.establishGuestOrderSession).toHaveBeenCalledWith("session-secret", expiresAt);
    expect(mocks.redirect).toHaveBeenCalledWith(`/pedido/${token}`);
  });
});
