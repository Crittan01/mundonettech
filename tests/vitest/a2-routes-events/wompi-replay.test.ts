import { fileURLToPath } from "node:url";

import {
  PaymentConflictError,
  PaymentNotFoundError,
  PaymentValidationError,
} from "../../../packages/integrations/dist/index.js";
import { describe, expect, it, vi } from "vitest";

import { loadTypeScriptModule } from "./route-loader.js";

const credentialId = "8a089e6d-5691-4d34-9d52-2f12e36b12aa";
const eventKey = "a".repeat(64);

interface TestEvent {
  readonly eventKey: string;
  readonly payloadHash: Uint8Array;
  readonly supported: boolean;
  readonly occurredAt: Date;
  readonly transaction: {
    readonly id: string;
    readonly reference: string;
    readonly amountCents: bigint;
    readonly currency: "COP";
    readonly status: "APPROVED";
    readonly statusMessage: null;
  } | null;
}

interface StoredWebhook {
  readonly id: string;
  readonly eventKey: string;
  readonly payloadHash: Uint8Array;
  readonly status: string;
  readonly attemptId: string | null;
}

interface WompiService {
  process(options: {
    readonly body: string;
    readonly environment: string;
    readonly credentialId: string;
  }): Promise<{ readonly status: string; readonly replayed: boolean }>;
}

function event(payloadHash: Uint8Array, supported = false): TestEvent {
  return {
    eventKey,
    payloadHash,
    supported,
    occurredAt: new Date("2026-11-24T12:00:00.000Z"),
    transaction: supported
      ? {
          id: "trx-unit-123",
          reference: "MNT-unit-123",
          amountCents: 100_000n,
          currency: "COP",
          status: "APPROVED",
          statusMessage: null,
        }
      : null,
  };
}

function createService(events: Record<string, TestEvent>, tx: Record<string, unknown>) {
  const acquireOperationLocks = vi.fn();
  const writePaymentOutbox = vi.fn();
  const inInventoryTransaction = async <T>(
    db: unknown,
    callback: (transaction: Record<string, unknown>) => Promise<T>,
  ): Promise<T> => {
    void db;
    return callback(tx);
  };
  const loadedModule = loadTypeScriptModule<{
    readonly WompiWebhookService: new (
      db: unknown,
      options: { readonly vault: unknown },
    ) => WompiService;
  }>(
    fileURLToPath(
      new URL("../../../packages/integrations/src/wompi-webhook-service.ts", import.meta.url),
    ),
    {
      "@mundonettech/db": {
        GrowthService: class {},
        IntegrationEnvironment: { LOCAL: "LOCAL" },
        PaymentProvider: { WOMPI: "WOMPI" },
        acquireOperationLocks,
        inInventoryTransaction,
      },
      "./payment-types.js": {
        PaymentConflictError,
        PaymentNotFoundError,
        PaymentValidationError,
      },
      "./payment-shared.js": {
        databaseNow: vi.fn(async () => new Date("2026-11-24T12:00:00.000Z")),
        lockPaymentAttempt: vi.fn(),
        lockPaymentOrder: vi.fn(),
        paymentDigest: vi.fn(),
        refreshOrderPaymentStatus: vi.fn(),
        writePaymentOutbox,
      },
      "./wompi-resolver.js": {
        resolveWompiProvider: vi.fn(async () => ({
          credential: { id: credentialId, environment: "LOCAL" },
          provider: {
            verifyWebhook: (options: { readonly body: string }) => {
              const selected = events[options.body];
              if (!selected) throw new Error("Unknown test event.");
              return selected;
            },
          },
        })),
      },
    },
  );
  const service = new loadedModule.WompiWebhookService({}, { vault: {} });
  return { service, acquireOperationLocks, writePaymentOutbox };
}

function transaction(initial: StoredWebhook | null) {
  let stored = initial;
  const findUnique = vi.fn(async () => stored);
  const create = vi.fn(async (options: { readonly data: Record<string, unknown> }) => {
    stored = {
      id: "webhook-id",
      eventKey,
      payloadHash: options.data.payloadHash as Uint8Array,
      status: String(options.data.status),
      attemptId: null,
    };
    return stored;
  });
  const update = vi.fn(async (options: { readonly data: { readonly status?: string } }) => {
    if (!stored) throw new Error("No stored webhook.");
    stored = { ...stored, status: options.data.status ?? stored.status };
    return stored;
  });
  const upsert = vi.fn();
  const tx = {
    paymentAttempt: {
      findUnique: vi.fn(async () => ({ credentialId, environment: "LOCAL" })),
    },
    paymentWebhookEvent: { findUnique, create, update, upsert },
  };
  return { tx, findUnique, create, update, upsert, current: () => stored };
}

describe("A2 Wompi payload-bound replay protection", () => {
  it("replays an identical ignored event without effects and rejects the same key with another body", async () => {
    const state = transaction(null);
    const firstHash = new Uint8Array(32).fill(1);
    const secondHash = new Uint8Array(32).fill(2);
    const { service } = createService(
      { first: event(firstHash), second: event(secondHash) },
      state.tx,
    );
    expect(
      await service.process({ body: "first", environment: "LOCAL", credentialId }),
    ).toMatchObject({
      status: "IGNORED",
      replayed: false,
    });
    expect(
      await service.process({ body: "first", environment: "LOCAL", credentialId }),
    ).toMatchObject({
      status: "IGNORED",
      replayed: true,
    });
    expect(state.create).toHaveBeenCalledOnce();
    await expect(
      service.process({ body: "second", environment: "LOCAL", credentialId }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(state.current()?.status).toBe("IGNORED");
    expect(state.current()?.payloadHash).toEqual(firstHash);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("checks processed and every nonterminal replay before any payment lock, update or outbox effect", async () => {
    for (const status of ["PROCESSED", "IGNORED", "FAILED", "RECEIVED"]) {
      const stored: StoredWebhook = {
        id: "webhook-id",
        eventKey,
        payloadHash: new Uint8Array(32).fill(3),
        status,
        attemptId: "attempt-id",
      };
      const state = transaction(stored);
      const { service, acquireOperationLocks, writePaymentOutbox } = createService(
        {
          same: event(stored.payloadHash, true),
          different: event(new Uint8Array(32).fill(4), true),
        },
        state.tx,
      );
      if (status === "PROCESSED" || status === "IGNORED") {
        expect(
          await service.process({ body: "same", environment: "LOCAL", credentialId }),
        ).toMatchObject({ status, replayed: true });
      }
      await expect(
        service.process({ body: "different", environment: "LOCAL", credentialId }),
      ).rejects.toBeInstanceOf(PaymentConflictError);
      expect(acquireOperationLocks).not.toHaveBeenCalled();
      expect(writePaymentOutbox).not.toHaveBeenCalled();
      expect(state.update).not.toHaveBeenCalled();
      expect(state.current()?.payloadHash).toEqual(stored.payloadHash);
      expect(state.current()?.status).toBe(status);
    }
  });

  it("does not let a late failure recording overwrite a concurrently completed terminal event", async () => {
    const terminal: StoredWebhook = {
      id: "webhook-id",
      eventKey,
      payloadHash: new Uint8Array(32).fill(5),
      status: "PROCESSED",
      attemptId: "attempt-id",
    };
    const state = transaction(null);
    state.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(terminal);
    state.create.mockRejectedValueOnce(new Error("concurrent unique insertion"));
    const { service } = createService({ first: event(terminal.payloadHash) }, state.tx);
    await expect(
      service.process({ body: "first", environment: "LOCAL", credentialId }),
    ).rejects.toThrow("concurrent unique insertion");
    expect(state.upsert).not.toHaveBeenCalled();
    expect(terminal.status).toBe("PROCESSED");
  });
});
