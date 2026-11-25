import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { CodReconciliationService } from "../../packages/integrations/src/cod-reconciliation-service";
import { PaymentService } from "../../packages/integrations/src/payment-service";
import { PaymentValidationError } from "../../packages/integrations/src/payment-types";

const now = new Date("2026-11-24T12:00:00.000Z");
const orderId = randomUUID();
const hashes = {
  EMAIL: new Uint8Array(32).fill(1),
  PHONE: new Uint8Array(32).fill(2),
  DOCUMENT: new Uint8Array(32).fill(3),
};

type DistributionState = "open" | "fulfillment" | "shipment" | "package";

function harness(
  document: string | null,
  blocked = false,
  distribution: DistributionState = "open",
) {
  const order = {
    id: orderId,
    orderStatus: "CONFIRMED",
    paymentStatus: "UNPAID",
    reservationExpiresAt: new Date(now.getTime() + 8 * 86_400_000),
    totalCents: 100_000n,
    buyerDocumentNumberSnapshot: document,
  };
  const paymentAttemptCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    provider: "COD",
    status: "PENDING",
    reference: data.id,
    replayed: false,
  }));
  const blockedIdentityFindFirst = vi.fn(async () => (blocked ? { kind: "DOCUMENT" } : null));
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(),
    paymentAttempt: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: paymentAttemptCreate,
    },
    blockedIdentity: { findFirst: blockedIdentityFindFirst },
    codReconciliation: { create: vi.fn(async () => ({})) },
    orderFulfillment: {
      findFirst: vi.fn(async () => (distribution === "fulfillment" ? { id: randomUUID() } : null)),
    },
    shipment: {
      findFirst: vi.fn(async () => (distribution === "shipment" ? { id: randomUUID() } : null)),
    },
    shipmentPackage: {
      findFirst: vi.fn(async () => (distribution === "package" ? { id: randomUUID() } : null)),
    },
    order: { update: vi.fn() },
  };
  tx.$queryRaw
    .mockResolvedValueOnce([order])
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValueOnce([{ captured: 0n, committed: 0n }]);
  const db = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const service = new PaymentService(db as never);
  return { service, paymentAttemptCreate, blockedIdentityFindFirst };
}

function input(identityHashes: Partial<typeof hashes>) {
  return {
    orderId,
    provider: "COD",
    environment: "LOCAL",
    idempotencyKey: `cod-${randomUUID()}`,
    identityHashes,
  } as never;
}

describe("A2 — invariante COD en PaymentService", () => {
  it("rechaza la omisión de DOCUMENT cuando la orden lo tiene sellado, incluso con tres caracteres", async () => {
    const { service, paymentAttemptCreate, blockedIdentityFindFirst } = harness("abc");

    const attempt = service.start(input({ EMAIL: hashes.EMAIL, PHONE: hashes.PHONE }));
    await expect(attempt).rejects.toThrow(PaymentValidationError);
    await expect(attempt).rejects.toThrow(/DOCUMENT/);
    expect(paymentAttemptCreate).not.toHaveBeenCalled();
    expect(blockedIdentityFindFirst).not.toHaveBeenCalled();
  });

  it("acepta el documento HMAC y comprueba su bloqueo antes de persistir el intento", async () => {
    const accepted = harness("abc");
    const attempt = await accepted.service.start(input(hashes));
    expect(attempt).toMatchObject({ provider: "COD", status: "PENDING" });
    expect(accepted.paymentAttemptCreate).toHaveBeenCalledOnce();

    const blocked = harness("abc", true);
    await expect(blocked.service.start(input(hashes))).rejects.toMatchObject({
      name: "PaymentConflictError",
      code: "BLOCKED_IDENTITY",
    });
    expect(blocked.paymentAttemptCreate).not.toHaveBeenCalled();
  });

  it("conserva compatibilidad únicamente cuando el snapshot no contiene documento", async () => {
    const { service, paymentAttemptCreate } = harness(null);

    const attempt = await service.start(input({ EMAIL: hashes.EMAIL, PHONE: hashes.PHONE }));

    expect(attempt).toMatchObject({ provider: "COD", status: "PENDING" });
    expect(paymentAttemptCreate).toHaveBeenCalledOnce();
  });

  it("rechaza claves de identidad fuera del contrato cerrado", async () => {
    const { service, paymentAttemptCreate } = harness("abc");

    await expect(
      service.start(input({ ...hashes, UNKNOWN: new Uint8Array(32) } as never)),
    ).rejects.toThrow(PaymentValidationError);
    expect(paymentAttemptCreate).not.toHaveBeenCalled();
  });
});

describe("A5 — distribución COD sellada al iniciar fulfillments", () => {
  it.each([
    ["un fulfillment PICKING", "fulfillment"],
    ["un envío READY", "shipment"],
    ["un bulto persistido", "package"],
  ] as const)("rechaza un nuevo intento con %s", async (_label, distribution) => {
    const { service, paymentAttemptCreate, blockedIdentityFindFirst } = harness(
      "abc",
      false,
      distribution,
    );

    await expect(service.start(input(hashes))).rejects.toMatchObject({
      name: "PaymentConflictError",
      code: "INVALID_STATE",
    });
    expect(paymentAttemptCreate).not.toHaveBeenCalled();
    expect(blockedIdentityFindFirst).not.toHaveBeenCalled();
  });
});

describe("A5 — agregados COD acotados por BIGINT", () => {
  it("rechaza una remesa cuyo esperado excede INT8 antes de persistir el lote", async () => {
    const actorId = randomUUID();
    const now = new Date("2026-11-25T12:00:00.000Z");
    const attempts = [randomUUID(), randomUUID()].map((id) => ({
      id,
      orderId: randomUUID(),
      amountCents: 9_223_372_036_854_775_807n,
    }));
    const create = vi.fn();
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: actorId,
            authUserId: randomUUID(),
            email: "finance@example.test",
            role: "SUPERADMIN",
          },
        ])
        .mockResolvedValueOnce([{ now }]),
      paymentAttempt: { findMany: vi.fn(async () => attempts) },
      remittanceBatch: { findUnique: vi.fn(async () => null), create },
    };
    const db = {
      ...tx,
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const service = new CodReconciliationService(db as never);

    await expect(
      service.reconcile({
        carrier: "Transportadora",
        reference: `REM-${randomUUID()}`,
        items: attempts.map((attempt) => ({
          paymentAttemptId: attempt.id,
          collectedCents: 1n,
          remittedCents: 1n,
          carrierReference: `GUIA-${attempt.id}`,
        })),
        audit: {
          actorAdminUserId: actorId,
          ipHash: new Uint8Array(32).fill(1),
          userAgentHash: new Uint8Array(32).fill(2),
        },
      }),
    ).rejects.toThrow(PaymentValidationError);
    expect(create).not.toHaveBeenCalled();
  });
});
