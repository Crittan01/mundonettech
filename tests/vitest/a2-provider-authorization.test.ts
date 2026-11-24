import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { InvoiceService, ShippingService } from "../../packages/integrations/dist/index.js";

const actorId = randomUUID();
const audit = {
  actorAdminUserId: actorId,
  requestId: randomUUID(),
  ipHash: new Uint8Array(32).fill(1),
  userAgentHash: new Uint8Array(32).fill(2),
};

function vaultHarness() {
  return {
    list: vi.fn(async () => ({ items: [] })),
    reveal: vi.fn(async () => new Uint8Array()),
  };
}

describe("A2 — DIAN autoriza antes de bóveda, claims y proveedor", () => {
  it("un actor suspendido no toca bóveda ni abre transacción", async () => {
    const vault = vaultHarness();
    const transaction = vi.fn();
    const db = {
      adminUser: { findFirst: vi.fn(async () => null) },
      $transaction: transaction,
    } as never;
    const service = new InvoiceService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.prepareInvoice(randomUUID(), undefined, audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    await expect(service.transmitInvoice(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    expect(vault.list).not.toHaveBeenCalled();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("si el actor desaparece antes del claim, no consulta ni muta la factura", async () => {
    const transactionQuery = vi.fn(async () => []);
    const tx = { $queryRaw: transactionQuery };
    const db = {
      adminUser: { findFirst: vi.fn(async () => ({ role: "FINANCE_ANALYST" })) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as never;
    const vault = vaultHarness();
    const provider = vi.fn();
    const service = new InvoiceService(db, {
      vault,
      environment: "LOCAL",
      providerFactory: provider,
    } as never);
    await expect(service.transmitInvoice(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "InvoiceValidationError",
    });
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(vault.reveal).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("un worker sin auditoría humana no consulta AdminUser", async () => {
    const adminUser = { findFirst: vi.fn() };
    const db = { adminUser } as never;
    const vault = vaultHarness();
    const service = new InvoiceService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.prepareInvoice(randomUUID())).rejects.toMatchObject({
      name: "InvoiceConflictError",
    });
    expect(vault.list).toHaveBeenCalledOnce();
    expect(adminUser.findFirst).not.toHaveBeenCalled();
  });
});

describe("A2 — shipping autoriza antes de bóveda y claims", () => {
  it("un actor suspendido no lee pedido, bóveda ni bulto", async () => {
    const transaction = vi.fn();
    const order = { findUnique: vi.fn() };
    const db = {
      adminUser: { findFirst: vi.fn(async () => null) },
      order,
      $transaction: transaction,
    } as never;
    const vault = vaultHarness();
    const service = new ShippingService(db, { vault, environment: "LOCAL" } as never);
    await expect(service.ensureFulfillments(randomUUID(), undefined, audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    await expect(service.processLabel(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    expect(order.findUnique).not.toHaveBeenCalled();
    expect(vault.list).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("una degradación antes del claim no permite leer o actualizar el bulto", async () => {
    const transactionQuery = vi.fn(async () => []);
    const shipmentPackage = { findUnique: vi.fn(), update: vi.fn() };
    const shipmentEvent = { create: vi.fn() };
    const tx = { $queryRaw: transactionQuery, shipmentPackage, shipmentEvent };
    const db = {
      adminUser: { findFirst: vi.fn(async () => ({ role: "FULFILLMENT" })) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as never;
    const provider = vi.fn();
    const service = new ShippingService(db, {
      vault: vaultHarness(),
      environment: "LOCAL",
      providerFactory: provider,
    } as never);
    await expect(service.processLabel(randomUUID(), "admin:test", audit)).rejects.toMatchObject({
      name: "ShippingAuthorizationError",
    });
    expect(shipmentPackage.findUnique).not.toHaveBeenCalled();
    expect(shipmentPackage.update).not.toHaveBeenCalled();
    expect(shipmentEvent.create).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("un worker automático conserva su flujo sin autenticación humana", async () => {
    const adminUser = { findFirst: vi.fn() };
    const order = { findUnique: vi.fn(async () => null) };
    const service = new ShippingService(
      { adminUser, order } as never,
      {
        vault: vaultHarness(),
        environment: "LOCAL",
      } as never,
    );
    await expect(service.ensureFulfillments(randomUUID())).rejects.toMatchObject({
      name: "ShippingNotFoundError",
    });
    expect(order.findUnique).toHaveBeenCalledOnce();
    expect(adminUser.findFirst).not.toHaveBeenCalled();
  });
});
