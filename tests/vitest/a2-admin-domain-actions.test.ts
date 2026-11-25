import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "../../packages/core/dist/index.js";
import * as cmsPackage from "../../packages/cms/dist/index.js";
import * as db from "../../packages/db/dist/index.js";
import * as integrations from "../../packages/integrations/dist/index.js";
import * as media from "../../packages/media/dist/index.js";
import { loadActionModule } from "./a2-action-loader.js";

interface ActionResult {
  readonly status: string;
  readonly message: string;
  readonly values?: Record<string, string>;
  readonly retryAfterSeconds?: number;
}
type Action = (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
type ActionModule = Record<string, Action>;

class AdminAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminAuthorizationError";
  }
}
class AdminOperationRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly remaining: number,
  ) {
    super("Rate limited");
    this.name = "AdminOperationRateLimitError";
  }
}

const idle: ActionResult = { status: "idle", message: "" };
const adminId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const otherOrderId = "33333333-3333-4333-8333-333333333333";
const refundId = "44444444-4444-4444-8444-444444444444";
const contactId = "55555555-5555-4555-8555-555555555555";
const shipmentId = "77777777-7777-4777-8777-777777777777";
const shipmentItemId = "88888888-8888-4888-8888-888888888888";
const orderItemId = "99999999-9999-4999-8999-999999999999";
const segmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const getAdminSession = vi.fn();
const getRequestSecurityContext = vi.fn();
const revalidatePath = vi.fn();
const updateTag = vi.fn();
const getDatabase = vi.fn(() => ({}));
const consumeRateLimit = vi.fn();
const effects = {
  confirmBankTransfer: vi.fn(),
  reconcile: vi.fn(),
  refund: vi.fn(),
  completeManualTransaction: vi.fn(),
  void: vi.fn(),
  adjust: vi.fn(),
  block: vi.fn(),
  unblock: vi.fn(),
  startPicking: vi.fn(),
  pack: vi.fn(),
  processLabel: vi.fn(),
  reconcileLabel: vi.fn(),
  assignSerialUnits: vi.fn(),
  markShipped: vi.fn(),
  markDelivered: vi.fn(),
  prepareInvoice: vi.fn(),
  transmitInvoice: vi.fn(),
  prepareCreditNote: vi.fn(),
  transmitCreditNote: vi.fn(),
  saveTemplate: vi.fn(),
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  archiveOrganization: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  verifyContact: vi.fn(),
  detectDuplicates: vi.fn(),
  merge: vi.fn(),
  rejectMerge: vi.fn(),
  reverse: vi.fn(),
  addActivity: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  suppress: vi.fn(),
  createSegment: vi.fn(),
  updateSegment: vi.fn(),
  transitionSegment: vi.fn(),
  refreshSegment: vi.fn(),
  createJourney: vi.fn(),
  updateJourney: vi.fn(),
  transitionJourney: vi.fn(),
};

function formEntries(formData: FormData): [string, FormDataEntryValue][] {
  return Array.from(formData.entries()).filter(([key]) => !key.startsWith("$ACTION_"));
}

function formSnapshot(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formEntries(formData)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

const actionState = {
  actionError: (message: string, values?: Record<string, string>) => ({
    status: "error",
    message,
    ...(values ? { values } : {}),
  }),
  actionSuccess: (message: string, values?: Record<string, string>) => ({
    status: "success",
    message,
    ...(values ? { values } : {}),
  }),
  formEntries,
  formSnapshot,
  formString: (formData: FormData, key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  },
};

const crm = {
  createOrganization: effects.createOrganization,
  updateOrganization: effects.updateOrganization,
  archiveOrganization: effects.archiveOrganization,
  createContact: effects.createContact,
  updateContact: effects.updateContact,
  verifyContact: effects.verifyContact,
  detectDuplicates: effects.detectDuplicates,
  addActivity: effects.addActivity,
  createTask: effects.createTask,
  updateTask: effects.updateTask,
};
const merges = { merge: effects.merge, reject: effects.rejectMerge, reverse: effects.reverse };
const segments = {
  createSegment: effects.createSegment,
  updateSegment: effects.updateSegment,
  transitionSegment: effects.transitionSegment,
  refreshSegment: effects.refreshSegment,
};
const journeys = {
  createJourney: effects.createJourney,
  updateJourney: effects.updateJourney,
  transitionJourney: effects.transitionJourney,
};

const mocks: Record<string, unknown> = {
  "@mundonettech/core": core,
  "@mundonettech/cms": cmsPackage,
  "@mundonettech/config/store": {
    storeConfig: { name: "MundoNetTech", domain: "example.test" },
  },
  "@mundonettech/db": {
    ...db,
    AdminOperationRateLimitError,
    consumeAdminOperationRateLimit: consumeRateLimit,
  },
  "@mundonettech/integrations": integrations,
  "@mundonettech/media": media,
  "next/cache": { revalidatePath, updateTag },
  "next/navigation": { redirect: vi.fn() },
  "@/lib/action-state": actionState,
  "@/lib/admin-pricing-presenters": { bogotaInputValue: vi.fn(() => "") },
  "@/lib/db": { getDatabase },
  "@/lib/security/admin-auth": { getAdminSession, AdminAuthorizationError },
  "@/lib/security/request-context": { getRequestSecurityContext },
  "@/lib/payment-identities": {
    emailIdentityHash: vi.fn(() => new Uint8Array(32)),
    phoneIdentityHash: vi.fn(() => new Uint8Array(32)),
    documentIdentityHash: vi.fn(() => new Uint8Array(32)),
  },
  "@/lib/integrations": {
    paymentService: () => ({ confirmBankTransfer: effects.confirmBankTransfer }),
    codReconciliationService: () => ({ reconcile: effects.reconcile }),
    paymentRefundService: () => ({
      refund: effects.refund,
      completeManualTransaction: effects.completeManualTransaction,
      void: effects.void,
    }),
    storeCreditService: () => ({ adjust: effects.adjust }),
    blockedIdentityService: () => ({ block: effects.block, unblock: effects.unblock }),
    shippingService: () => ({
      startPicking: effects.startPicking,
      pack: effects.pack,
      processLabel: effects.processLabel,
      reconcileLabel: effects.reconcileLabel,
      assignSerialUnits: effects.assignSerialUnits,
      markShipped: effects.markShipped,
      markDelivered: effects.markDelivered,
    }),
    invoiceService: () => ({
      prepareInvoice: effects.prepareInvoice,
      transmitInvoice: effects.transmitInvoice,
      prepareCreditNote: effects.prepareCreditNote,
      transmitCreditNote: effects.transmitCreditNote,
    }),
    emailService: () => ({ saveTemplate: effects.saveTemplate }),
  },
  "@/lib/crm": {
    crmService: () => crm,
    crmMergeService: () => merges,
    crmRetentionService: () => ({ suppress: effects.suppress }),
    crmPrivacyPolicyVersion: "2026-01",
  },
  "@/lib/lifecycle": {
    segmentationService: () => segments,
    lifecycleService: () => journeys,
  },
};

const moduleNames = [
  "admin-catalog",
  "admin-pricing",
  "admin-cms",
  "admin-redirects",
  "admin-payments",
  "admin-logistics",
  "admin-invoices",
  "admin-communications",
  "admin-operations",
  "admin-postsale",
  "admin-crm",
  "admin-lifecycle",
] as const;
const modules = Object.fromEntries(
  moduleNames.map((name) => [name, loadActionModule<ActionModule>(name, mocks)]),
) as Record<(typeof moduleNames)[number], ActionModule>;

const modulePermissions: Record<(typeof moduleNames)[number], string> = {
  "admin-catalog": "catalog:write",
  "admin-pricing": "pricing:write",
  "admin-cms": "content:write",
  "admin-redirects": "content:write",
  "admin-payments": "payments:write",
  "admin-logistics": "fulfillment:write",
  "admin-invoices": "invoices:write",
  "admin-communications": "communications:write",
  "admin-operations": "payments:write",
  "admin-postsale": "postsale:write",
  "admin-crm": "crm:write",
  "admin-lifecycle": "crm:write",
};
const specialPermissions: Record<string, string> = {
  saveStoreSettingsAction: "settings:write",
  markNotificationReadAction: "dashboard:read",
  moderateReviewAction: "reviews:write",
  mergeCrmContactsAction: "crm:merge",
  rejectCrmMergeAction: "crm:merge",
  reverseCrmMergeAction: "crm:merge",
  suppressCrmContactAction: "crm:suppress",
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue({ profile: { id: adminId, role: "SUPERADMIN" } });
  consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, remaining: 1 });
  getRequestSecurityContext.mockResolvedValue({
    ipHash: new Uint8Array(32).fill(1),
    userAgentHash: new Uint8Array(32).fill(2),
  });
});

describe("A2/A4 — autorización y cierre de los 82 actions administrativos asignados", () => {
  it("exige el permiso exacto y MFA antes de rechazar campos desconocidos sin tocar servicios", async () => {
    let count = 0;
    for (const [moduleName, actions] of Object.entries(modules) as [
      (typeof moduleNames)[number],
      ActionModule,
    ][]) {
      for (const [actionName, action] of Object.entries(actions)) {
        count += 1;
        getAdminSession.mockClear();
        const form = new FormData();
        form.set("unexpected", "must-not-be-accepted");
        const result = await action(idle, form);
        expect(result.status, `${moduleName}.${actionName}`).toBe("error");
        expect(getAdminSession, `${moduleName}.${actionName}`).toHaveBeenCalledTimes(1);
        const options = getAdminSession.mock.calls[0]![0] as {
          permission: string;
          requireRecentMfa?: boolean;
        };
        expect(options.permission, actionName).toBe(
          specialPermissions[actionName] ?? modulePermissions[moduleName],
        );
        expect(options.requireRecentMfa, actionName).toBe(true);
      }
    }
    expect(count).toBe(82);
    for (const [name, effect] of Object.entries(effects)) {
      expect(effect, name).not.toHaveBeenCalled();
    }
  });

  it("acepta metadatos $ACTION_* sin abrir campos de negocio desconocidos", async () => {
    effects.createOrganization.mockResolvedValueOnce({});
    const form = new FormData();
    form.set("legalName", "Organización React");
    form.set("commercialName", "");
    form.set("taxId", "901.888.777-6");
    form.set("$ACTION_REF_5", "");
    form.set("$ACTION_5:0", "action-transport-metadata");
    form.set("$ACTION_5:1", "bound-action-metadata");
    form.set("$ACTION_KEY", "k-react-action-state");
    const result = await modules["admin-crm"].createCrmOrganizationAction!(idle, form);
    expect(result.status).toBe("success");
    expect(effects.createOrganization).toHaveBeenCalledTimes(1);

    form.set("unexpected", "must-not-be-accepted");
    const rejected = await modules["admin-crm"].createCrmOrganizationAction!(idle, form);
    expect(rejected.status).toBe("error");
    expect(effects.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("rechaza claves duplicadas y archivos antes de efectos financieros", async () => {
    const duplicated = new FormData();
    duplicated.append("paymentAttemptId", randomUUID());
    duplicated.append("externalReference", "first-reference");
    duplicated.append("externalReference", "second-reference");
    const duplicateResult = await modules["admin-payments"].confirmBankTransferAction!(
      idle,
      duplicated,
    );
    expect(duplicateResult.status).toBe("error");

    const uploaded = new FormData();
    uploaded.set("paymentAttemptId", randomUUID());
    uploaded.set("externalReference", new File(["raw"], "reference.txt"));
    const fileResult = await modules["admin-payments"].confirmBankTransferAction!(idle, uploaded);
    expect(fileResult.status).toBe("error");
    expect(effects.confirmBankTransfer).not.toHaveBeenCalled();
  });

  it("bloquea JSON de bultos, reembolsos y lifecycle con claves adicionales", async () => {
    const packages = new FormData();
    packages.set("shipmentId", shipmentId);
    packages.set(
      "packages",
      JSON.stringify([
        {
          weightGrams: 100,
          lengthMillimeters: 100,
          widthMillimeters: 100,
          heightMillimeters: 100,
          items: [{ shipmentItemId, quantity: 1, admin: true }],
        },
      ]),
    );
    expect((await modules["admin-logistics"].packShipmentAction!(idle, packages)).status).toBe(
      "error",
    );

    const refund = new FormData();
    refund.set("orderId", orderId);
    refund.set("idempotencyKey", "admin-refund:test");
    refund.set("reason", "ADJUSTMENT");
    refund.set("note", "");
    refund.set("items", JSON.stringify([{ orderItemId, quantity: 1, admin: true }]));
    expect((await modules["admin-operations"].requestOrderRefundAction!(idle, refund)).status).toBe(
      "error",
    );

    const journey = new FormData();
    journey.set("name", "Journey seguro");
    journey.set("description", "Finalidad comercial");
    journey.set("segmentId", segmentId);
    journey.set(
      "stepsJson",
      JSON.stringify([
        {
          position: 0,
          offsetMinutes: 0,
          subject: "Hola {{customerFirstName}}",
          htmlBody: '<a href="{{unsubscribeUrl}}">Baja</a>',
          textBody: "Baja {{unsubscribeUrl}}",
          variables: ["customerFirstName", "unsubscribeUrl"],
          admin: true,
        },
      ]),
    );
    expect((await modules["admin-lifecycle"].createJourneyAction!(idle, journey)).status).toBe(
      "error",
    );
    expect(effects.pack).not.toHaveBeenCalled();
    expect(effects.createJourney).not.toHaveBeenCalled();
  });

  it("rechaza fechas inexistentes y conserva la conversión Bogotá en entradas válidas", async () => {
    const taskForm = (dueAt: string) => {
      const form = new FormData();
      form.set("contactId", contactId);
      form.set("title", "Contactar al cliente");
      form.set("description", "Seguimiento comercial");
      form.set("priority", "NORMAL");
      form.set("dueAt", dueAt);
      form.set("assignedToAdminUserId", "");
      return form;
    };
    const invalid = await modules["admin-crm"].createCrmTaskAction!(
      idle,
      taskForm("2026-02-30T10:30"),
    );
    expect(invalid.status).toBe("error");
    expect(effects.createTask).not.toHaveBeenCalled();

    effects.createTask.mockResolvedValueOnce({});
    const valid = await modules["admin-crm"].createCrmTaskAction!(
      idle,
      taskForm("2027-06-15T10:30"),
    );
    expect(valid.status).toBe("success");
    expect(effects.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: new Date("2027-06-15T15:30:00.000Z") }),
      expect.objectContaining({ actorAdminUserId: adminId }),
    );

    const blocked = new FormData();
    blocked.set("kind", "DOCUMENT");
    blocked.set("identity", "CC-1020304050");
    blocked.set("reason", "Fraude confirmado");
    blocked.set("expiresAt", "2026-02-30");
    const invalidBlock = await modules["admin-payments"].blockIdentityAction!(idle, blocked);
    expect(invalidBlock.status).toBe("error");
    expect(invalidBlock.values?.identity).toBeUndefined();
    expect(invalidBlock.values?.reason).toBeUndefined();
    expect(effects.block).not.toHaveBeenCalled();

    blocked.set("identity", "abc");
    blocked.set("expiresAt", "");
    effects.block.mockResolvedValueOnce({});
    const validBlock = await modules["admin-payments"].blockIdentityAction!(idle, blocked);
    expect(validBlock.status).toBe("success");
    expect(effects.block).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "DOCUMENT",
        identityHash: new Uint8Array(32),
        reason: "Fraude confirmado",
      }),
    );
  });

  it("no refleja contenido personal, plantillas ni importes sobredimensionados en errores", async () => {
    const template = new FormData();
    template.set("templateKey", "order.paid");
    template.set("subject", "Dato personal cliente@example.test");
    template.set("htmlBody", '<p class="private">Contenido personal</p>');
    template.set("textBody", "Contenido personal");
    template.set("variables", "unsubscribeUrl");
    effects.saveTemplate.mockRejectedValueOnce(
      new integrations.EmailValidationError("provider raw response"),
    );
    const templateResult = await modules["admin-communications"].saveEmailTemplateAction!(
      idle,
      template,
    );
    expect(templateResult.status).toBe("error");
    expect(templateResult.values).toEqual({ templateKey: "order.paid" });
    expect(JSON.stringify(templateResult)).not.toContain("Contenido personal");
    expect(JSON.stringify(templateResult)).not.toContain("provider raw response");

    const remittance = new FormData();
    remittance.set("carrier", "Transportadora");
    remittance.set("reference", "remittance-reference");
    remittance.set("paymentAttemptId", randomUUID());
    const oversized = "9".repeat(300);
    remittance.set("collectedCents", oversized);
    remittance.set("remittedCents", "0");
    remittance.set("carrierReference", "carrier-reference");
    const remittanceResult = await modules["admin-payments"].reconcileCodAction!(idle, remittance);
    expect(remittanceResult.status).toBe("error");
    expect(JSON.stringify(remittanceResult)).not.toContain(oversized);
    expect(effects.reconcile).not.toHaveBeenCalled();
  });

  it("devuelve Retry-After y bloquea detección CRM al agotar su cuota", async () => {
    consumeRateLimit.mockRejectedValueOnce(new AdminOperationRateLimitError(37, 0));
    const duplicates = new FormData();
    duplicates.set("contactId", "");
    const limited = await modules["admin-crm"].detectCrmDuplicatesAction!(idle, duplicates);
    expect(limited).toMatchObject({ status: "error", retryAfterSeconds: 37 });
    expect(limited.message).toContain("37 segundos");
    expect(effects.detectDuplicates).not.toHaveBeenCalled();
  });

  it("devuelve Retry-After y bloquea evaluación lifecycle al agotar su cuota", async () => {
    consumeRateLimit.mockRejectedValueOnce(new AdminOperationRateLimitError(19, 0));
    const segment = new FormData();
    segment.set("segmentId", segmentId);
    const lifecycle = loadActionModule<ActionModule>("admin-lifecycle", {
      ...mocks,
      "@mundonettech/db": {
        LifecycleError: db.LifecycleError,
        AdminOperationRateLimitError,
        consumeAdminOperationRateLimit: consumeRateLimit,
      },
    });
    const limited = await lifecycle.refreshSegmentAction!(idle, segment);
    expect(limited.message).toContain("19 segundos");
    expect(limited).toMatchObject({ status: "error", retryAfterSeconds: 19 });
    expect(effects.refreshSegment).not.toHaveBeenCalled();
    expect(consumeRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: "lifecycle.segment.refresh",
        actorAdminUserId: adminId,
        limit: 10,
        windowSeconds: 60,
      }),
    );
  });

  it("no ofrece gestión Flex a FULFILLMENT ni construye el servicio", async () => {
    getAdminSession.mockResolvedValue({ profile: { id: adminId, role: "FULFILLMENT" } });
    const zone = await modules["admin-logistics"].saveDeliveryZoneAction!(idle, new FormData());
    const archive = await modules["admin-logistics"].archiveDeliveryZoneAction!(
      idle,
      new FormData(),
    );
    expect(zone.status).toBe("error");
    expect(archive.status).toBe("error");
    expect(zone.message).toContain("no está autorizada");
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("detiene un MFA vencido antes de interpretar JSON o construir integraciones", async () => {
    getAdminSession.mockRejectedValueOnce(new AdminAuthorizationError("MFA_STALE"));
    const form = new FormData();
    form.set("shipmentId", shipmentId);
    form.set("packages", "{not-json");
    const result = await modules["admin-logistics"].packShipmentAction!(idle, form);
    expect(result.status).toBe("error");
    expect(result.message).toContain("autenticador");
    expect(effects.pack).not.toHaveBeenCalled();

    getAdminSession.mockRejectedValueOnce(new AdminAuthorizationError("MFA_STALE"));
    const notification = await modules["admin-operations"].markNotificationReadAction!(
      idle,
      new FormData(),
    );
    expect(notification.status).toBe("error");
    expect(notification.message).toContain("autenticador");
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("invalida el pedido persistido por el servicio y no el orderId oculto alterado", async () => {
    class RefundService {
      async cancel() {
        return { orderId, status: "CANCELLED" };
      }
      async reject() {
        return { orderId, status: "REJECTED" };
      }
    }
    const localMocks = {
      ...mocks,
      "@mundonettech/db": { ...db, OrderRefundService: RefundService },
    };
    const actions = loadActionModule<ActionModule>("admin-operations", localMocks);
    const form = new FormData();
    form.set("orderId", otherOrderId);
    form.set("refundId", refundId);
    form.set("transition", "cancel");
    form.set("note", "Cancelación verificada");
    const result = await actions.transitionOrderRefundAction!(idle, form);
    expect(result.status).toBe("success");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/pedidos/${orderId}`);
    expect(revalidatePath).not.toHaveBeenCalledWith(`/admin/pedidos/${otherOrderId}`);
  });
});
