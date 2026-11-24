import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AdminOrderService,
  CrmMergeService,
  OperationsService,
} from "../../packages/db/dist/index.js";

const actorId = randomUUID();
const orderId = randomUUID();

function firstArgument<T>(mock: { mock: { calls: unknown[] } }): T {
  const calls = mock.mock.calls as unknown as [unknown][];
  return calls[0]![0] as T;
}

interface OrderQuery {
  select: {
    items: { select: { unitCostWacCents: boolean } };
    paymentAttempts?: unknown;
    refunds?: unknown;
  };
}

function orderRecord() {
  const now = new Date("2026-11-24T12:00:00.000Z");
  return {
    id: orderId,
    orderNumber: "MNT-2026-0001",
    createdAt: now,
    confirmedAt: now,
    orderStatus: "CONFIRMED",
    paymentStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED",
    fulfillmentMethod: "HOME_DELIVERY",
    currency: "COP",
    subtotalCents: 100_000n,
    discountCents: 0n,
    taxCents: 19_000n,
    shippingCents: 0n,
    totalCents: 119_000n,
    emailSnapshot: "buyer@example.test",
    recipientNameSnapshot: "Comprador Privado",
    phoneE164Snapshot: "+573001234567",
    buyerDocumentNumberSnapshot: "1020304050",
    addressLine1Snapshot: "Carrera 7 # 71-21",
    municipalityNameSnapshot: "Bogotá",
    items: [
      {
        id: randomUUID(),
        variantId: randomUUID(),
        titleSnapshot: "Producto",
        skuSnapshot: "SKU-1",
        quantity: 1,
        unitPriceCents: 100_000n,
        unitCostWacCents: 60_000n,
        discountCents: 0n,
        taxCents: 19_000n,
        lineTotalCents: 100_000n,
        variant: { product: { trackSerial: false } },
        taxLines: [],
        refundItems: [],
      },
    ],
    shipments: [],
    serializedUnits: [],
    statusEvents: [],
  };
}

function orderHarness(role: string | null) {
  const adminUser = { findFirst: vi.fn(async () => (role ? { role } : null)) };
  const order = { findUnique: vi.fn(async () => orderRecord()), findMany: vi.fn() };
  const paymentAttempt = {
    findMany: vi.fn(async () => [
      {
        id: randomUUID(),
        provider: "BANK_TRANSFER",
        status: "SUCCEEDED",
        reference: "bank-private-reference",
        amountCents: 119_000n,
        createdAt: new Date(),
        transactions: [],
      },
    ]),
  };
  const orderRefund = {
    findMany: vi.fn(async () => [
      {
        id: randomUUID(),
        reason: "ADJUSTMENT",
        status: "REQUESTED",
        note: "Nota financiera privada",
        subtotalCents: 100_000n,
        taxCents: 19_000n,
        shippingCents: 0n,
        totalCents: 119_000n,
        createdAt: new Date(),
        processedAt: null,
        items: [],
        paymentTransactions: [],
      },
    ]),
  };
  return {
    adminUser,
    order,
    paymentAttempt,
    orderRefund,
    db: { adminUser, order, paymentAttempt, orderRefund } as never,
  };
}

describe("A2 — DAL y DTO de pedidos derivados del actor", () => {
  it("orders-only no selecciona ni devuelve WAC, libro de pagos o reembolsos", async () => {
    const harness = orderHarness("FULFILLMENT");
    const detail = await new AdminOrderService(harness.db, actorId).detail(orderId);
    expect(detail).not.toBeNull();
    expect(detail!.items[0]).not.toHaveProperty("unitCostWacCents");
    expect(detail).not.toHaveProperty("payments");
    expect(detail).not.toHaveProperty("refunds");
    expect(harness.paymentAttempt.findMany).not.toHaveBeenCalled();
    expect(harness.orderRefund.findMany).not.toHaveBeenCalled();
    const { select } = firstArgument<OrderQuery>(harness.order.findUnique);
    expect(select.items.select.unitCostWacCents).toBe(false);
    expect(select).not.toHaveProperty("paymentAttempts");
    expect(select).not.toHaveProperty("refunds");
    expect(JSON.stringify(detail)).not.toContain("bank-private-reference");
    expect(JSON.stringify(detail)).not.toContain("Nota financiera privada");
  });

  it("payments:read recibe pagos enmascarados pero sigue sin WAC", async () => {
    const harness = orderHarness("CUSTOMER_SUPPORT");
    const detail = await new AdminOrderService(harness.db, actorId).detail(orderId);
    expect(detail!.items[0]).not.toHaveProperty("unitCostWacCents");
    expect(detail!.payments).toHaveLength(1);
    expect(detail!.refunds).toHaveLength(1);
    expect(detail!.payments![0]!.reference).not.toBe("bank-private-reference");
    expect(JSON.stringify(detail)).not.toContain("buyer@example.test");
  });

  it("finance:read recibe WAC y relaciones financieras autorizadas", async () => {
    const harness = orderHarness("FINANCE_ANALYST");
    const detail = await new AdminOrderService(harness.db, actorId).detail(orderId);
    expect(detail!.items[0]!.unitCostWacCents).toBe("60000");
    expect(detail!.payments).toHaveLength(1);
    expect(detail!.refunds).toHaveLength(1);
    const { select } = firstArgument<OrderQuery>(harness.order.findUnique);
    expect(select.items.select.unitCostWacCents).toBe(true);
  });

  it("un actor suspendido no llega a consultar el pedido", async () => {
    const harness = orderHarness(null);
    await expect(new AdminOrderService(harness.db, actorId).detail(orderId)).rejects.toThrow(
      /not authorized/,
    );
    expect(harness.order.findUnique).not.toHaveBeenCalled();
  });
});

describe("A2 — acceso directo a candidatas CRM", () => {
  function crmHarness(role: string | null) {
    const adminUser = { findFirst: vi.fn(async () => (role ? { role } : null)) };
    const identityMergeCandidate = { findMany: vi.fn(async () => []) };
    return {
      adminUser,
      identityMergeCandidate,
      db: { adminUser, identityMergeCandidate } as never,
    };
  }

  it("rechaza soporte y suspendidos antes de leer candidatas", async () => {
    for (const role of ["CUSTOMER_SUPPORT", null]) {
      const harness = crmHarness(role);
      await expect(
        new CrmMergeService(harness.db).listCandidates(actorId, "PENDING"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(harness.identityMergeCandidate.findMany).not.toHaveBeenCalled();
    }
  });

  it("permite Anillo 1 sin devolver snapshots", async () => {
    const harness = crmHarness("OPERATIONS_MANAGER");
    const result = await new CrmMergeService(harness.db).listCandidates(actorId, "MERGED");
    expect(result).toEqual([]);
    expect(harness.identityMergeCandidate.findMany).toHaveBeenCalledOnce();
    const { select } = firstArgument<{ select: Record<string, unknown> }>(
      harness.identityMergeCandidate.findMany,
    );
    expect(select).not.toHaveProperty("sourceSnapshot");
    expect(select).not.toHaveProperty("targetSnapshot");
  });
});

describe("A2 — NotificationRead y auditoría en la misma transacción", () => {
  it("persiste requestId/hashes y metadata estrictamente operativa", async () => {
    const readAt = new Date();
    const tx = {
      notification: {
        findUnique: vi.fn(async () => ({ id: randomUUID(), category: "orders.fulfillment" })),
      },
      adminUser: { findFirst: vi.fn(async () => ({ id: actorId, role: "FULFILLMENT" })) },
      notificationRead: { upsert: vi.fn(async () => ({ readAt })) },
      adminActionLog: { create: vi.fn(async () => ({})) },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );
    const db = { $transaction: transaction } as never;
    const audit = {
      actorAdminUserId: actorId,
      requestId: randomUUID(),
      ipHash: new Uint8Array(32).fill(1),
      userAgentHash: new Uint8Array(32).fill(2),
    };
    const result = await new OperationsService(db).markNotificationRead(randomUUID(), audit);
    expect(result).toBe(readAt);
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.notificationRead.upsert).toHaveBeenCalledOnce();
    expect(tx.adminActionLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorAdminUserId: actorId,
        requestId: audit.requestId,
        action: "NOTIFICATION_MARKED_READ",
        metadata: { category: "orders.fulfillment" },
      }),
    });
    const { data: log } = firstArgument<{ data: { metadata: Record<string, unknown> } }>(
      tx.adminActionLog.create,
    );
    expect(JSON.stringify(log.metadata)).not.toMatch(/email|phone|document|message/i);
    await expect(
      new OperationsService(db).markNotificationRead(randomUUID(), {
        ...audit,
        ipHash: new Uint8Array(31),
      }),
    ).rejects.toThrow(/32 bytes/);
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("A2 — contratos RSC y selects mínimos", () => {
  const root = new URL("../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");

  it("mantiene las condiciones RSC de pedidos y CRM", () => {
    const orderPage = read("apps/web/app/admin/(protected)/pedidos/[id]/page.tsx");
    expect(orderPage).toContain("canReadFinance && item.unitCostWacCents !== undefined");
    expect(orderPage).toContain("canReadPayments && order.payments !== undefined");
    expect(orderPage).toContain("canReadPayments && order.refunds !== undefined");
    const crmPage = read("apps/web/app/admin/(protected)/crm/page.tsx");
    expect(crmPage).toContain(
      'canMerge\n      ? crmMergeService(db).listCandidates(session.profile.id, "PENDING")',
    );
    expect(crmPage).toContain("{canMerge ? (");
  });

  it("no usa includes de registros completos ni carga XML/cuerpos desde PostgreSQL", () => {
    const paths = [
      "apps/web/app/admin/(protected)/facturacion/page.tsx",
      "apps/web/app/admin/(protected)/pagos/page.tsx",
      "apps/web/app/admin/(protected)/logistica/page.tsx",
      "apps/web/app/admin/(protected)/comunicaciones/page.tsx",
    ];
    for (const path of paths) {
      const source = read(path);
      expect(source, path).not.toContain("include:");
      expect(source, path).toContain("select:");
    }
    expect(read(paths[0]!)).not.toMatch(/unsignedXml|signedXml/);
    const communicationQueries = read(paths[3]!).split("const defaults")[0]!;
    expect(communicationQueries).not.toMatch(/htmlBody|textBody|subjectSnapshot/);
  });

  it("ofrece step-up real en Hoy y restringe formularios Flex", () => {
    expect(read("apps/web/app/admin/(protected)/hoy/page.tsx")).toContain(
      "<CmsStepUp session={session} />",
    );
    const logistics = read("apps/web/app/admin/(protected)/logistica/page.tsx");
    expect(logistics).toContain("canManageDeliveryZones");
    expect(logistics).toContain("{canManageDeliveryZones ? <ArchiveDeliveryZoneForm");
    expect(logistics).toContain("Tu rol puede consultar la cobertura histórica");
  });
});
