import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { normalizeOperationKey } from "@mundonettech/core";
import type { IntegrationEnvironment, PrismaClient } from "@mundonettech/db";
import {
  acquireOperationLocks,
  consumeOperationRateLimit,
  hasUniqueViolation,
  inInventoryTransaction,
} from "@mundonettech/db";

import { EmailProviderError, type EmailCredentials, type EmailProvider } from "./email-types.js";
import { assertIntegrationUuid } from "./integration-utils.js";
import { parseEmailCredentials, ResendEmailProvider } from "./resend.js";

export type GuestOrderAccessErrorCode =
  "INVALID" | "EXPIRED" | "COOLDOWN" | "RATE_LIMIT" | "CONFLICT";

export class GuestOrderAccessError extends Error {
  constructor(
    readonly code: GuestOrderAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GuestOrderAccessError";
  }
}

export interface GuestOrderAccessOptions {
  readonly secret: Uint8Array;
  readonly storeName: string;
  readonly environment?: IntegrationEnvironment;
  readonly vault: {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: readonly { id: string; provider: string; revokedAt: Date | null }[];
    }>;
    reveal(id: string): Promise<Uint8Array>;
  };
  readonly providerFactory?: (credentials: EmailCredentials) => EmailProvider;
}

function tokenHash(token: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new GuestOrderAccessError("INVALID", "Order access token is malformed.");
  }
  return createHash("sha256").update(token).digest();
}

function hash32(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new GuestOrderAccessError("INVALID", "Security hashes must contain 32 bytes.");
  }
  return Uint8Array.from(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class GuestOrderAccessService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: GuestOrderAccessOptions,
  ) {
    this.options = {
      ...options,
      environment: options.environment ?? "PRD",
    };
    if (options.secret.length !== 32)
      throw new TypeError("Guest order HMAC secret must contain 32 bytes.");
    if (options.storeName.trim().length < 2 || options.storeName.length > 120) {
      throw new TypeError("storeName is invalid.");
    }
  }

  private codeHash(challengeId: string, orderId: string, code: string): Uint8Array<ArrayBuffer> {
    return createHmac("sha256", this.options.secret)
      .update(`guest-order-access:v1:${challengeId}:${orderId}:${code}`)
      .digest();
  }

  private async credentials(): Promise<{ id: string; values: EmailCredentials }> {
    const descriptors = await this.options.vault.list({ includeRevoked: false, limit: 100 });
    const active = descriptors.items.filter(
      (item) => item.provider === "resend" && !item.revokedAt,
    );
    if (active.length !== 1 || descriptors.items.length === 100) {
      throw new EmailProviderError(
        "Exactly one active Resend credential is required.",
        "INVALID_CREDENTIAL",
      );
    }
    const id = active[0]!.id;
    const plaintext = await this.options.vault.reveal(id);
    try {
      return { id, values: parseEmailCredentials(plaintext, this.options.environment) };
    } finally {
      plaintext.fill(0);
    }
  }

  async requestCode(input: { token: string; idempotencyKey: string; ipHash: Uint8Array }) {
    const receiptHash = tokenHash(input.token);
    const ipHash = hash32(input.ipHash);
    const idempotencyKey = normalizeOperationKey(input.idempotencyKey, "idempotencyKey");
    let prepared: {
      challengeId: string;
      orderId: string;
      orderNumber: string;
      email: string;
      code: string | null;
      status: string;
    } | null;
    try {
      prepared = await inInventoryTransaction(this.db, async (tx) => {
        const existing = await tx.guestOrderChallenge.findUnique({ where: { idempotencyKey } });
        const receipt = await tx.orderReceipt.findFirst({
          where: { accessTokenHash: receiptHash },
          select: { orderId: true },
        });
        if (existing) {
          if (
            !receipt ||
            existing.orderId !== receipt.orderId ||
            !timingSafeEqual(Uint8Array.from(existing.requestIpHash), ipHash)
          ) {
            throw new GuestOrderAccessError(
              "CONFLICT",
              "The guest access idempotency key belongs to another request.",
            );
          }
          const lockedOrders = await tx.$queryRaw<
            Array<{
              id: string;
              orderNumber: string;
              emailSnapshot: string | null;
              anonymizedAt: Date | null;
            }>
          >`SELECT "id", "orderNumber", "emailSnapshot", "anonymizedAt" FROM "Order" WHERE "id" = ${receipt.orderId}::uuid FOR SHARE`;
          const lockedOrder = lockedOrders[0];
          if (!lockedOrder?.emailSnapshot || lockedOrder.anonymizedAt) {
            return null;
          }
          return {
            challengeId: existing.id,
            orderId: lockedOrder.id,
            orderNumber: lockedOrder.orderNumber,
            email: lockedOrder.emailSnapshot,
            code: null,
            status: existing.status,
          };
        }
        const ipRate = await consumeOperationRateLimit(tx, {
          operation: "guest-order-code",
          subject: { type: "IP" },
          ipHash,
          limit: 20,
          windowSeconds: 3_600,
          throwOnLimit: false,
        });
        if (!ipRate.allowed) {
          throw new GuestOrderAccessError(
            "RATE_LIMIT",
            "Too many guest access codes were requested.",
          );
        }
        if (!receipt) {
          return null;
        }
        const lockedOrders = await tx.$queryRaw<
          Array<{
            id: string;
            orderNumber: string;
            emailSnapshot: string | null;
            anonymizedAt: Date | null;
          }>
        >`SELECT "id", "orderNumber", "emailSnapshot", "anonymizedAt" FROM "Order" WHERE "id" = ${receipt.orderId}::uuid FOR SHARE`;
        const order = lockedOrders[0];
        if (!order?.emailSnapshot || order.anonymizedAt) {
          return null;
        }
        await acquireOperationLocks(tx, [`guest-order:${order.id}`]);
        const rechecked = await tx.guestOrderChallenge.findUnique({ where: { idempotencyKey } });
        if (rechecked) {
          if (
            rechecked.orderId !== order.id ||
            !timingSafeEqual(Uint8Array.from(rechecked.requestIpHash), ipHash)
          ) {
            throw new GuestOrderAccessError(
              "CONFLICT",
              "The guest access idempotency key belongs to another request.",
            );
          }
          return {
            challengeId: rechecked.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            email: order.emailSnapshot,
            code: null,
            status: rechecked.status,
          };
        }
        const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
        const now = nowRows[0]!.now;
        const cooldownStart = new Date(now.getTime() - 60_000);
        const [orderRecent, latestSent] = await Promise.all([
          tx.guestOrderChallenge.count({
            where: { orderId: order.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
          }),
          tx.guestOrderChallenge.findFirst({
            where: {
              orderId: order.id,
              OR: [
                { lastSentAt: { gte: cooldownStart } },
                { status: "PENDING", createdAt: { gte: cooldownStart } },
              ],
            },
            select: { id: true },
          }),
        ]);
        if (orderRecent >= 5) {
          throw new GuestOrderAccessError(
            "RATE_LIMIT",
            "Too many guest access codes were requested.",
          );
        }
        if (latestSent)
          throw new GuestOrderAccessError("COOLDOWN", "Wait before requesting another code.");
        await tx.guestOrderChallenge.updateMany({
          where: { orderId: order.id, status: { in: ["PENDING", "SENT", "FAILED"] } },
          data: { status: "EXPIRED" },
        });
        const id = randomUUID();
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        await tx.guestOrderChallenge.create({
          data: {
            id,
            orderId: order.id,
            idempotencyKey,
            codeHash: this.codeHash(id, order.id, code),
            requestIpHash: ipHash,
            expiresAt: new Date(now.getTime() + 10 * 60_000),
          },
        });
        return {
          challengeId: id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          email: order.emailSnapshot!,
          code,
          status: "PENDING" as const,
        };
      });
    } catch (error) {
      if (hasUniqueViolation(error)) {
        const [receipt, existing] = await Promise.all([
          this.db.orderReceipt.findFirst({
            where: { accessTokenHash: receiptHash },
            select: { orderId: true },
          }),
          this.db.guestOrderChallenge.findUnique({ where: { idempotencyKey } }),
        ]);
        if (existing) {
          if (
            !receipt ||
            existing.orderId !== receipt.orderId ||
            !timingSafeEqual(Uint8Array.from(existing.requestIpHash), ipHash)
          ) {
            throw new GuestOrderAccessError(
              "CONFLICT",
              "The guest access idempotency key belongs to another request.",
            );
          }
          return {
            accepted: true as const,
            challengeId: existing.id,
            delivered: existing.status === "SENT",
            replayed: true,
          };
        }
      }
      throw error;
    }
    if (!prepared)
      return { accepted: true as const, challengeId: null, delivered: false, replayed: false };
    if (!prepared.code) {
      return {
        accepted: true as const,
        challengeId: prepared.challengeId,
        delivered: prepared.status === "SENT",
        replayed: true,
      };
    }
    try {
      const { values } = await this.credentials();
      const provider = this.options.providerFactory?.(values) ?? new ResendEmailProvider(values);
      const orderNumber = escapeHtml(prepared.orderNumber);
      const storeName = escapeHtml(this.options.storeName);
      const result = await provider.send({
        idempotencyKey: `guest-order-access:${prepared.challengeId}`,
        to: prepared.email,
        subject: `Código de acceso para tu pedido ${prepared.orderNumber}`,
        html: `<p>Tu código para consultar el pedido <strong>${orderNumber}</strong> en ${storeName} es:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${prepared.code}</p><p>Expira en 10 minutos. No lo compartas. Si no solicitaste este código, puedes ignorar este mensaje.</p>`,
        text: `Tu código para consultar el pedido ${prepared.orderNumber} en ${this.options.storeName} es ${prepared.code}. Expira en 10 minutos. No lo compartas.`,
      });
      const sentNowRows = await this.db.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP AS now`;
      const updated = await this.db.guestOrderChallenge.updateMany({
        where: { id: prepared.challengeId, status: "PENDING" },
        data: {
          status: "SENT",
          lastSentAt: sentNowRows[0]!.now,
          providerMessageId: result.providerMessageId,
          failureCode: null,
        },
      });
      return {
        accepted: true as const,
        challengeId: prepared.challengeId,
        delivered: updated.count === 1,
        replayed: false,
      };
    } catch (error) {
      const failureCode = error instanceof EmailProviderError ? error.code : "DELIVERY_FAILED";
      await this.db.guestOrderChallenge.updateMany({
        where: { id: prepared.challengeId, status: "PENDING" },
        data: { status: "FAILED", failureCode },
      });
      return {
        accepted: true as const,
        challengeId: prepared.challengeId,
        delivered: false,
        replayed: false,
      };
    }
  }

  async verifyCode(input: {
    token: string;
    challengeId: string;
    code: string;
    ipHash: Uint8Array;
  }) {
    assertIntegrationUuid(input.challengeId, "challengeId");
    const receiptHash = tokenHash(input.token);
    const ipHash = hash32(input.ipHash);
    if (!/^[0-9]{6}$/.test(input.code))
      throw new GuestOrderAccessError("INVALID", "The access code is invalid.");
    const outcome = await inInventoryTransaction(this.db, async (tx) => {
      const ipRate = await consumeOperationRateLimit(tx, {
        operation: "guest-order-verify",
        subject: { type: "IP" },
        ipHash,
        limit: 60,
        windowSeconds: 3_600,
        throwOnLimit: false,
      });
      if (!ipRate.allowed) {
        throw new GuestOrderAccessError("RATE_LIMIT", "Too many verification attempts.");
      }
      const peekChallenge = await tx.guestOrderChallenge.findUnique({
        where: { id: input.challengeId },
        select: { orderId: true },
      });
      if (!peekChallenge) {
        throw new GuestOrderAccessError("INVALID", "The access code is invalid or expired.");
      }
      const lockedOrders = await tx.$queryRaw<
        Array<{ id: string; anonymizedAt: Date | null }>
      >`SELECT "id", "anonymizedAt" FROM "Order" WHERE "id" = ${peekChallenge.orderId}::uuid FOR SHARE`;
      const lockedOrder = lockedOrders[0];
      const receipt = lockedOrder
        ? await tx.orderReceipt.findUnique({
            where: { orderId: lockedOrder.id },
            select: { accessTokenHash: true },
          })
        : null;
      if (
        !lockedOrder ||
        !receipt ||
        !timingSafeEqual(Uint8Array.from(receipt.accessTokenHash), receiptHash) ||
        lockedOrder.anonymizedAt
      ) {
        throw new GuestOrderAccessError("INVALID", "The access code is invalid or expired.");
      }
      const challenges = await tx.$queryRaw<
        import("@mundonettech/db").GuestOrderChallenge[]
      >`SELECT * FROM "GuestOrderChallenge" WHERE "id" = ${input.challengeId}::uuid FOR UPDATE`;
      const challenge = challenges[0];
      if (!challenge || challenge.orderId !== lockedOrder.id) {
        throw new GuestOrderAccessError("INVALID", "The access code is invalid or expired.");
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (challenge.status !== "SENT" || challenge.expiresAt <= now || challenge.attempts >= 5) {
        throw new GuestOrderAccessError("EXPIRED", "The access code is invalid or expired.");
      }
      const expected = this.codeHash(challenge.id, lockedOrder.id, input.code);
      if (!timingSafeEqual(Uint8Array.from(challenge.codeHash), expected)) {
        const attempts = challenge.attempts + 1;
        await tx.guestOrderChallenge.update({
          where: { id: challenge.id },
          data: { attempts, ...(attempts >= 5 ? { status: "EXPIRED" as const } : {}) },
        });
        return { failure: "INVALID" as const };
      }
      await tx.guestOrderChallenge.update({
        where: { id: challenge.id },
        data: { status: "CONSUMED", consumedAt: now },
      });
      await tx.guestOrderSession.updateMany({
        where: { orderId: lockedOrder.id, revokedAt: null },
        data: { revokedAt: now },
      });
      const sessionToken = randomBytes(32).toString("base64url");
      const session = await tx.guestOrderSession.create({
        data: {
          orderId: lockedOrder.id,
          challengeId: challenge.id,
          tokenHash: createHash("sha256").update(sessionToken).digest(),
          expiresAt: new Date(now.getTime() + 30 * 60_000),
        },
      });
      return {
        sessionId: session.id,
        orderId: lockedOrder.id,
        sessionToken,
        expiresAt: session.expiresAt,
      };
    });
    if ("failure" in outcome) {
      throw new GuestOrderAccessError("INVALID", "The access code is invalid or expired.");
    }
    return outcome;
  }

  async getSession(input: { token: string; sessionToken: string }) {
    const receiptHash = tokenHash(input.token);
    const sessionHash = tokenHash(input.sessionToken);
    const [session, nowRows] = await Promise.all([
      this.db.guestOrderSession.findFirst({
        where: { tokenHash: sessionHash, revokedAt: null },
        include: { order: { include: { receipt: true } } },
      }),
      this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`,
    ]);
    const now = nowRows[0]!.now;
    if (
      !session?.order.receipt ||
      session.expiresAt <= now ||
      session.order.anonymizedAt ||
      !timingSafeEqual(Uint8Array.from(session.order.receipt.accessTokenHash), receiptHash)
    ) {
      throw new GuestOrderAccessError("INVALID", "The guest order session is invalid or expired.");
    }
    if (now.getTime() - session.lastUsedAt.getTime() > 60_000) {
      await this.db.guestOrderSession.updateMany({
        where: { id: session.id, revokedAt: null, lastUsedAt: { lte: now } },
        data: { lastUsedAt: now },
      });
    }
    return { sessionId: session.id, orderId: session.orderId, expiresAt: session.expiresAt };
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const sessionHash = tokenHash(sessionToken);
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    await this.db.guestOrderSession.updateMany({
      where: { tokenHash: sessionHash, revokedAt: null },
      data: { revokedAt: nowRows[0]!.now },
    });
  }
}
