import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AccountError, AccountService } from "../../packages/db/src/account-service";

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

function harness() {
  let customer = {
    id: customerId,
    status: "ACTIVE",
    deletedAt: null,
    updatedAt: initialUpdatedAt,
    givenName: baseInput.givenName,
    familyName: baseInput.familyName,
    phoneE164: baseInput.phoneE164,
  };
  let marketingGranted = false;
  let advertisingGranted = false;
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
      if (sql.includes('FROM "LifecycleEnrollment"')) return [];
      if (sql.includes('FROM "LifecycleMessage"')) return [];
      if (sql.includes("CURRENT_TIMESTAMP")) return [{ now }];
      throw new TypeError(`Unexpected query: ${sql}`);
    }),
    customer: { update: customerUpdate },
    consent: {
      findFirst: vi.fn(async ({ where }: { where: { purpose: string } }) => {
        const granted = where.purpose === "MARKETING_EMAIL" ? marketingGranted : advertisingGranted;
        return granted ? { id: randomUUID() } : null;
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
});
