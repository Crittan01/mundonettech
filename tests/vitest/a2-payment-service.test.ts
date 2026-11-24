import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { PaymentService } from "../../packages/integrations/src/payment-service";
import { PaymentValidationError } from "../../packages/integrations/src/payment-types";

const now = new Date("2026-11-24T12:00:00.000Z");
const orderId = randomUUID();
const hashes = {
  EMAIL: new Uint8Array(32).fill(1),
  PHONE: new Uint8Array(32).fill(2),
  DOCUMENT: new Uint8Array(32).fill(3),
};

function harness(document: string | null, blocked = false) {
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
});
