import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AccountError, AccountService } from "../../packages/db/src/account-service";
import { cancelPendingMetaCapiForCustomerInTransaction } from "../../packages/db/src/meta-capi";

const customerId = randomUUID();
const initialUpdatedAt = new Date("2026-11-24T11:00:00.000Z");
const now = new Date("2026-11-24T12:00:00.000Z");
const audit = { ipHash: new Uint8Array(32).fill(1), userAgentHash: new Uint8Array(32).fill(2) };
const baseInput = {
  givenName: "Nombre",
  familyName: "Apellido",
  phoneE164: "+573001234567",
  marketingEmail: false,
  advertising: false,
};

function harness(options: { marketingGranted?: boolean; advertisingGranted?: boolean } = {}) {
  let customer = {
    id: customerId,
    status: "ACTIVE",
    deletedAt: null,
    updatedAt: initialUpdatedAt,
    givenName: baseInput.givenName,
    familyName: baseInput.familyName,
    phoneE164: baseInput.phoneE164,
  };
  let marketingGranted = options.marketingGranted ?? false;
  let advertisingGranted = options.advertisingGranted ?? false;
  const customerUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    customer = { ...customer, ...data, updatedAt: now };
    return customer;
  });
  const consentCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.purpose === "MARKETING_EMAIL") marketingGranted = data.status === "GRANTED";
    if (data.purpose === "ADVERTISING") advertisingGranted = data.status === "GRANTED";
    return data;
  });
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "Customer"')) return [customer];
      if (sql.includes('FROM "CustomerSegmentMembership"')) return [];
      if (sql.includes('FROM "LifecycleEnrollment"')) return [];
      if (sql.includes('FROM "LifecycleMessage"')) return [];
      if (sql.includes('FROM "MetaCapiEvent"')) return [];
      if (sql.includes("CURRENT_TIMESTAMP")) return [{ now }];
      throw new TypeError(`Unexpected query: ${sql}`);
    }),
    customer: { update: customerUpdate },
    consent: {
      findMany: vi.fn(async ({ where }: { where: { purpose: string } }) => {
        const granted = where.purpose === "MARKETING_EMAIL" ? marketingGranted : advertisingGranted;
        return granted ? [{ id: randomUUID() }] : [];
      }),
      create: consentCreate,
    },
    emailEvent: { updateMany: vi.fn(async () => ({ count: 0 })) },
    lifecycleMessage: { updateMany: vi.fn(async () => ({ count: 0 })) },
    lifecycleEnrollment: { findMany: vi.fn(async () => []) },
    metaCapiEvent: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const db = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const service = new AccountService(db as never, { privacyPolicyVersion: "2026-01" });
  return { service, customerUpdate, consentCreate };
}

describe("A2 — concurrencia optimista de perfil", () => {
  it("bloquea una segunda pestaña obsoleta y admite replay sin reescritura", async () => {
    const { service, customerUpdate, consentCreate } = harness();
    const desired = { ...baseInput, givenName: "Actualizado" };
    const first = await service.updateProfile(customerId, desired, initialUpdatedAt, audit);

    await expect(
      service.updateProfile(
        customerId,
        { ...baseInput, givenName: "Obsoleto" },
        initialUpdatedAt,
        audit,
      ),
    ).rejects.toMatchObject({ name: "AccountError", code: "CONFLICT" });

    const replay = await service.updateProfile(customerId, desired, initialUpdatedAt, audit);
    expect(replay.updatedAt).toEqual(first.updatedAt);
    expect(customerUpdate).toHaveBeenCalledOnce();
    expect(consentCreate).not.toHaveBeenCalled();
  });

  it("no duplica consentimientos append-only al repetir una concesión ya aplicada", async () => {
    const { service, customerUpdate, consentCreate } = harness();
    const desired = { ...baseInput, marketingEmail: true };
    const first = await service.updateProfile(customerId, desired, initialUpdatedAt, audit);
    const replay = await service.updateProfile(customerId, desired, initialUpdatedAt, audit);

    expect(replay.updatedAt).toEqual(first.updatedAt);
    expect(customerUpdate).toHaveBeenCalledOnce();
    expect(consentCreate).toHaveBeenCalledOnce();
    expect(consentCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { status: "GRANTED", revokesId: null },
    });
  });

  it("rechaza timestamps inválidos antes de abrir la transacción", async () => {
    const { service, customerUpdate } = harness();
    await expect(
      service.updateProfile(customerId, baseInput, new Date("invalid"), audit),
    ).rejects.toBeInstanceOf(AccountError);
    expect(customerUpdate).not.toHaveBeenCalled();
  });

  it("revoca cada consentimiento vigente una sola vez y conserva el enlace append-only", async () => {
    const { service, consentCreate } = harness({
      marketingGranted: true,
      advertisingGranted: true,
    });
    await service.updateProfile(customerId, baseInput, initialUpdatedAt, audit);

    expect(consentCreate).toHaveBeenCalledTimes(2);
    for (const purpose of ["MARKETING_EMAIL", "ADVERTISING"]) {
      expect(consentCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          purpose,
          status: "REVOKED",
          revokesId: expect.any(String),
          policyVersion: "2026-01",
        }),
      });
    }
  });
});

describe("A6 — cursor de pedidos y obligaciones de anonimización", () => {
  it("pagina por createdAt/id solo dentro del titular y rechaza cursores ajenos", async () => {
    const cursorDate = new Date("2026-11-23T10:00:00.000Z");
    const findFirst = vi.fn(async (): Promise<{ id: string; createdAt: Date } | null> => ({
      id: customerId,
      createdAt: cursorDate,
    }));
    const findMany = vi.fn(async () => []);
    const service = new AccountService(
      {
        customer: { findFirst: vi.fn(async () => ({ id: customerId })) },
        order: { findFirst, findMany },
      } as never,
      {
        privacyPolicyVersion: "2026-01",
      },
    );
    await service.listOrders(customerId, { cursor: otherCustomerId(), limit: 10 });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: expect.any(String), customerId },
      select: { id: true, createdAt: true },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          customerId,
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: expect.any(String) } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 11,
      }),
    );

    findFirst.mockResolvedValueOnce(null);
    await expect(
      service.listOrders(customerId, { cursor: otherCustomerId(), limit: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(findMany).toHaveBeenCalledOnce();
    await expect(service.listOrders(customerId, { limit: 26 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("bloquea intentos por confirmar/autorizados y transacciones aún en proceso", async () => {
    async function run(paymentTransactionOpen: boolean) {
      const paymentAttemptFindFirst = vi.fn(async () =>
        paymentTransactionOpen ? null : { id: randomUUID() },
      );
      const paymentTransactionFindFirst = vi.fn(async () =>
        paymentTransactionOpen ? { id: randomUUID() } : null,
      );
      const tx = {
        $queryRaw: vi.fn(async () => [{ now }]),
        customer: {
          findUnique: vi.fn(async () => ({
            id: customerId,
            status: "ACTIVE",
            deletedAt: null,
            email: "cliente@example.co",
          })),
        },
        storeCreditAccount: {
          aggregate: vi.fn(async () => ({ _sum: { availableCents: 0n, heldCents: 0n } })),
        },
        order: { findFirst: vi.fn(async () => null) },
        paymentAttempt: { findFirst: paymentAttemptFindFirst },
        orderRefund: { findFirst: vi.fn(async () => null) },
        returnRequest: { findFirst: vi.fn(async () => null) },
        warrantyClaim: { findFirst: vi.fn(async () => null) },
        metaCapiEvent: { findFirst: vi.fn(async () => null) },
        paymentTransaction: { findFirst: paymentTransactionFindFirst },
        taxInvoice: { findFirst: vi.fn(async () => null) },
        creditNote: { findFirst: vi.fn(async () => null) },
      };
      const service = new AccountService({} as never, { privacyPolicyVersion: "2026-01" });
      await expect(
        service.anonymizeInTransaction(tx as never, customerId, audit, {
          skipCrmCascade: true,
          alreadyLocked: true,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      return { paymentAttemptFindFirst, paymentTransactionFindFirst };
    }

    const attempt = await run(false);
    expect(attempt.paymentAttemptFindFirst).toHaveBeenCalledWith({
      where: {
        order: { customerId },
        status: { in: ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"] },
      },
      select: { id: true },
    });
    const transaction = await run(true);
    expect(transaction.paymentTransactionFindFirst).toHaveBeenCalledWith({
      where: { attempt: { order: { customerId } }, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true },
    });
  });
});

describe("A8 — cancelación Meta por privacidad", () => {
  it("bloquea con FOR UPDATE y purga PENDING, DISPATCHING, UNCERTAIN y FAILED sin tocar terminales", async () => {
    const rows = [
      { id: randomUUID() },
      { id: randomUUID() },
      { id: randomUUID() },
      { id: randomUUID() },
    ];
    let lockedSql = "";
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
      lockedSql = strings.join("?");
      return rows;
    });
    const updateMany = vi.fn(async () => ({ count: rows.length }));
    const resolveAlerts = vi.fn(async () => ({ count: rows.length }));
    const tx = {
      $queryRaw: queryRaw,
      metaCapiEvent: { updateMany },
      notification: { updateMany: resolveAlerts },
    };

    const count = await cancelPendingMetaCapiForCustomerInTransaction(tx as never, customerId, now);

    expect(count).toBe(4);
    expect(lockedSql).toContain("FOR UPDATE");
    expect(lockedSql).toContain("'PENDING', 'DISPATCHING', 'UNCERTAIN', 'FAILED'");
    expect(lockedSql).not.toContain("'SENT'");
    expect(lockedSql).not.toContain("'SKIPPED'");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: rows.map((row) => row.id) },
      },
      data: {
        status: "SKIPPED",
        completedAt: now,
        failureCode: "NO_CONSENT",
        externalIdHash: null,
        emailHash: null,
        phoneHash: null,
        availableAt: now,
        claimId: null,
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        requestStartedAt: null,
      },
    });
    expect(resolveAlerts).toHaveBeenCalledWith({
      where: {
        deduplicationKey: { in: rows.map((row) => `meta-capi:${row.id}:review`) },
        resolvedAt: null,
      },
      data: { resolvedAt: now },
    });
  });
});

function otherCustomerId(): string {
  return "22222222-2222-4222-8222-222222222222";
}
