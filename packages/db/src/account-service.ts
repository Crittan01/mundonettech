import { createHash } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";

import type { Customer, PrismaClient } from "./generated/client.js";
import { CrmError, suppressCustomerCrmLineageInTransaction } from "./crm-shared.js";
import { GrowthService, marketingEmailConsentGranted } from "./growth-service.js";
import { acquireOperationLocks, assertUuid, inInventoryTransaction } from "./inventory-shared.js";
import { revokeCustomerLifecycleConsentInTransaction } from "./lifecycle-cancellation.js";
import { cancelPendingMetaCapiForCustomerInTransaction } from "./meta-capi.js";

export type AccountErrorCode = "NOT_FOUND" | "CONFLICT" | "VALIDATION";

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AccountAudit {
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
}

export interface ProfileInput {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly phoneE164: string | null;
  readonly marketingEmail: boolean;
  readonly advertising: boolean;
}

export interface AddressInput {
  readonly label: string;
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly departmentCode: string;
  readonly municipalityCode: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly neighborhood?: string | null;
  readonly postalCode?: string | null;
  readonly deliveryNotes?: string | null;
  readonly isDefault: boolean;
}

interface AccountServiceOptions {
  readonly privacyPolicyVersion: string;
}

const textPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const phonePattern = /^\+[1-9][0-9]{7,14}$/;

function hash32(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new AccountError("VALIDATION", `${field} must contain 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function text(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  nullable = false,
): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    textPattern.test(value)
  ) {
    throw new AccountError(
      "VALIDATION",
      `${field} must contain ${minimum} to ${maximum} trimmed printable characters.`,
    );
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = text(value, field, 1, maximum);
  return normalized === "" ? null : normalized;
}

function phone(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (typeof value !== "string" || !phonePattern.test(value)) {
    throw new AccountError("VALIDATION", "phoneE164 must use a valid international format.");
  }
  return value;
}

function profileInput(input: ProfileInput): ProfileInput {
  return {
    givenName: optionalText(input.givenName, "givenName", 100),
    familyName: optionalText(input.familyName, "familyName", 100),
    phoneE164: phone(input.phoneE164, true),
    marketingEmail:
      typeof input.marketingEmail === "boolean"
        ? input.marketingEmail
        : (() => {
            throw new AccountError("VALIDATION", "marketingEmail must be boolean.");
          })(),
    advertising:
      typeof input.advertising === "boolean"
        ? input.advertising
        : (() => {
            throw new AccountError("VALIDATION", "advertising must be boolean.");
          })(),
  };
}

function addressInput(input: AddressInput): AddressInput {
  if (typeof input.isDefault !== "boolean") {
    throw new AccountError("VALIDATION", "isDefault must be boolean.");
  }
  if (!/^[0-9]{2}$/.test(input.departmentCode) || !/^[0-9]{5}$/.test(input.municipalityCode)) {
    throw new AccountError("VALIDATION", "DANE department or municipality code is invalid.");
  }
  if (input.postalCode && !/^[0-9]{6}$/.test(input.postalCode)) {
    throw new AccountError("VALIDATION", "postalCode must contain six digits.");
  }
  return {
    label: text(input.label, "label", 2, 80)!,
    recipientName: text(input.recipientName, "recipientName", 2, 200)!,
    phoneE164: phone(input.phoneE164)!,
    departmentCode: input.departmentCode,
    municipalityCode: input.municipalityCode,
    addressLine1: text(input.addressLine1, "addressLine1", 3, 200)!,
    addressLine2: optionalText(input.addressLine2, "addressLine2", 200),
    neighborhood: optionalText(input.neighborhood, "neighborhood", 120),
    postalCode: input.postalCode ?? null,
    deliveryNotes: optionalText(input.deliveryNotes, "deliveryNotes", 500),
    isDefault: input.isDefault,
  };
}

export class AccountService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: AccountServiceOptions,
  ) {
    text(options.privacyPolicyVersion, "privacyPolicyVersion", 1, 50);
  }

  private audit(audit: AccountAudit) {
    return {
      ipHash: hash32(audit.ipHash, "ipHash"),
      userAgentHash:
        audit.userAgentHash === null ? null : hash32(audit.userAgentHash, "userAgentHash"),
    };
  }

  private async lockActiveCustomer(
    tx: import("./generated/client.js").Prisma.TransactionClient,
    customerId: string,
  ): Promise<Customer> {
    assertUuid(customerId, "customerId");
    await acquireOperationLocks(tx, [`growth-customer:${customerId}`]);
    await acquireOperationLocks(tx, [`customer-account:${customerId}`]);
    const rows = await tx.$queryRaw<
      Customer[]
    >`SELECT * FROM "Customer" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
    const customer = rows[0];
    if (!customer || customer.status !== "ACTIVE" || customer.deletedAt) {
      throw new AccountError("NOT_FOUND", "Active customer account not found.");
    }
    return customer;
  }

  async getProfile(customerId: string) {
    assertUuid(customerId, "customerId");
    const [customer, activeConsents] = await Promise.all([
      this.db.customer.findFirst({
        where: { id: customerId, status: "ACTIVE", deletedAt: null },
        include: {
          consents: { orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 20 },
          addresses: {
            where: { deletedAt: null },
            include: { municipality: { include: { department: true } } },
            orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
          },
          storeCreditAccounts: { select: { availableCents: true, heldCents: true, active: true } },
        },
      }),
      this.db.consent.findMany({
        where: {
          customerId,
          purpose: { in: ["MARKETING_EMAIL", "ADVERTISING"] },
          status: "GRANTED",
          revokedBy: null,
        },
        select: { purpose: true },
      }),
    ]);
    if (!customer) throw new AccountError("NOT_FOUND", "Active customer account not found.");
    const grantedPurposes = new Set(activeConsents.map((item) => item.purpose));
    return {
      ...customer,
      marketingEmailGranted: grantedPurposes.has("MARKETING_EMAIL"),
      advertisingGranted: grantedPurposes.has("ADVERTISING"),
    };
  }

  async updateProfile(
    customerId: string,
    input: ProfileInput,
    expectedUpdatedAt: Date,
    auditInput: AccountAudit,
  ) {
    const values = profileInput(input);
    if (!(expectedUpdatedAt instanceof Date) || Number.isNaN(expectedUpdatedAt.getTime())) {
      throw new AccountError("VALIDATION", "expectedUpdatedAt is invalid.");
    }
    const audit = this.audit(auditInput);
    return inInventoryTransaction(this.db, async (tx) => {
      const customer = await this.lockActiveCustomer(tx, customerId);
      const [latestConsent, latestAdvertisingConsent] = await Promise.all([
        tx.consent.findFirst({
          where: {
            customerId,
            purpose: "MARKETING_EMAIL",
            status: "GRANTED",
            revokedBy: null,
          },
          select: { id: true },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        }),
        tx.consent.findFirst({
          where: {
            customerId,
            purpose: "ADVERTISING",
            status: "GRANTED",
            revokedBy: null,
          },
          select: { id: true },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        }),
      ]);
      const currentlyGranted = latestConsent !== null;
      const currentlyAdvertisingGranted = latestAdvertisingConsent !== null;
      if (
        customer.givenName === values.givenName &&
        customer.familyName === values.familyName &&
        customer.phoneE164 === values.phoneE164 &&
        currentlyGranted === values.marketingEmail &&
        currentlyAdvertisingGranted === values.advertising
      ) {
        return customer;
      }
      if (customer.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new AccountError("CONFLICT", "The profile changed in another session.");
      }
      const proofHash = createHash("sha256")
        .update(
          JSON.stringify({
            customerId,
            givenName: values.givenName,
            familyName: values.familyName,
            phoneE164: values.phoneE164,
            marketingEmail: values.marketingEmail,
            advertising: values.advertising,
            policyVersion: this.options.privacyPolicyVersion,
          }),
        )
        .digest();
      const updated = await tx.customer.update({
        where: { id: customer.id },
        data: {
          givenName: values.givenName,
          familyName: values.familyName,
          phoneE164: values.phoneE164,
        },
      });
      if (currentlyGranted !== values.marketingEmail) {
        await tx.consent.create({
          data: {
            customerId,
            purpose: "MARKETING_EMAIL",
            status: values.marketingEmail ? "GRANTED" : "REVOKED",
            source: "customer-account",
            policyVersion: this.options.privacyPolicyVersion,
            proofHash,
            ipHash: audit.ipHash,
            userAgentHash: audit.userAgentHash,
            revokesId: values.marketingEmail ? null : latestConsent!.id,
          },
        });
      }
      if (currentlyAdvertisingGranted !== values.advertising) {
        await tx.consent.create({
          data: {
            customerId,
            purpose: "ADVERTISING",
            status: values.advertising ? "GRANTED" : "REVOKED",
            source: "customer-account",
            policyVersion: this.options.privacyPolicyVersion,
            proofHash,
            ipHash: audit.ipHash,
            userAgentHash: audit.userAgentHash,
            revokesId: values.advertising ? null : latestAdvertisingConsent!.id,
          },
        });
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (!values.marketingEmail) {
        await tx.emailEvent.updateMany({
          where: {
            customerId,
            templateKey: "cart.recovery",
            status: { in: ["QUEUED", "SENDING"] },
          },
          data: { status: "SUPPRESSED", statusRank: 70, finalAt: now, nextAttemptAt: null },
        });
        await tx.$executeRaw`
          UPDATE "AbandonedCart" SET
            "lastReminderActivityAt" = COALESCE("lastReminderActivityAt", "lastActivityAt"),
            "lastReminderOutcome" = 'NO_CONSENT'
          WHERE "customerId" = ${customerId}::uuid AND "status" = 'DETECTED'
        `;
        await revokeCustomerLifecycleConsentInTransaction(tx, customerId, now);
      }
      if (!values.advertising) {
        await cancelPendingMetaCapiForCustomerInTransaction(tx, customerId, now);
      }
      await tx.$executeRaw`
        INSERT INTO "SecurityEvent" ("customerId", "eventType", "ipHash", "userAgentHash", "metadata", "dedupMinute")
        VALUES (${customerId}::uuid, 'CUSTOMER_PROFILE_UPDATED', ${audit.ipHash}, ${audit.userAgentHash}, ${JSON.stringify({ marketingEmail: values.marketingEmail, advertising: values.advertising })}::jsonb, date_trunc('minute', CURRENT_TIMESTAMP))
        ON CONFLICT ("eventType", "ipHash", "dedupMinute") DO NOTHING
      `;
      return updated;
    });
  }

  private async assertAddressLocation(
    tx: import("./generated/client.js").Prisma.TransactionClient,
    values: AddressInput,
  ): Promise<void> {
    const municipality = await tx.daneMunicipality.findFirst({
      where: { code: values.municipalityCode, departmentCode: values.departmentCode },
      select: { code: true },
    });
    if (!municipality)
      throw new AccountError(
        "VALIDATION",
        "The municipality does not belong to the selected department.",
      );
  }

  async createAddress(customerId: string, input: AddressInput) {
    const values = addressInput(input);
    return inInventoryTransaction(this.db, async (tx) => {
      await this.lockActiveCustomer(tx, customerId);
      await this.assertAddressLocation(tx, values);
      const count = await tx.address.count({ where: { customerId, deletedAt: null } });
      if (count >= 20) throw new AccountError("CONFLICT", "The address limit has been reached.");
      const isDefault = count === 0 || values.isDefault;
      if (isDefault) {
        await tx.address.updateMany({
          where: { customerId, deletedAt: null, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({ data: { customerId, ...values, isDefault } });
    });
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    input: AddressInput,
    expectedUpdatedAt: Date,
  ) {
    assertUuid(addressId, "addressId");
    const values = addressInput(input);
    if (!(expectedUpdatedAt instanceof Date) || Number.isNaN(expectedUpdatedAt.getTime())) {
      throw new AccountError("VALIDATION", "expectedUpdatedAt is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      await this.lockActiveCustomer(tx, customerId);
      await this.assertAddressLocation(tx, values);
      const existing = await tx.address.findFirst({
        where: { id: addressId, customerId, deletedAt: null },
      });
      if (!existing) throw new AccountError("NOT_FOUND", "Address not found.");
      if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new AccountError("CONFLICT", "The address changed in another session.");
      }
      if (values.isDefault) {
        await tx.address.updateMany({
          where: { customerId, deletedAt: null, isDefault: true, id: { not: addressId } },
          data: { isDefault: false },
        });
      }
      const updated = await tx.address.update({ where: { id: addressId }, data: values });
      if (!updated.isDefault) {
        const fallback = await tx.address.findFirst({
          where: { customerId, deletedAt: null, isDefault: true },
          select: { id: true },
        });
        if (!fallback) {
          await tx.address.update({ where: { id: addressId }, data: { isDefault: true } });
          updated.isDefault = true;
        }
      }
      return updated;
    });
  }

  async deleteAddress(customerId: string, addressId: string) {
    assertUuid(addressId, "addressId");
    return inInventoryTransaction(this.db, async (tx) => {
      await this.lockActiveCustomer(tx, customerId);
      const existing = await tx.address.findFirst({
        where: { id: addressId, customerId, deletedAt: null },
      });
      if (!existing) throw new AccountError("NOT_FOUND", "Address not found.");
      await tx.address.delete({ where: { id: existing.id } });
      if (existing.isDefault) {
        const fallback = await tx.address.findFirst({
          where: { customerId, deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (fallback)
          await tx.address.update({ where: { id: fallback.id }, data: { isDefault: true } });
      }
      return { id: addressId, deleted: true as const };
    });
  }

  async listOrders(customerId: string, options: { cursor?: string; limit?: number } = {}) {
    assertUuid(customerId, "customerId");
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new AccountError("VALIDATION", "Order page size must be between 1 and 25.");
    }
    let cursor: { createdAt: Date; id: string } | null = null;
    if (options.cursor) {
      assertUuid(options.cursor, "cursor");
      const found = await this.db.order.findFirst({
        where: { id: options.cursor, customerId },
        select: { id: true, createdAt: true },
      });
      if (!found) throw new AccountError("NOT_FOUND", "Order cursor not found.");
      cursor = found;
    }
    return this.db.order.findMany({
      where: {
        customerId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { items: { select: { id: true, titleSnapshot: true, quantity: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
  }

  async getOrder(customerId: string, orderId: string) {
    assertUuid(customerId, "customerId");
    assertUuid(orderId, "orderId");
    const order = await this.db.order.findFirst({
      where: { id: orderId, customerId },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: {
                  include: { variants: { where: { deletedAt: null, status: "ACTIVE" } } },
                },
              },
            },
            shipmentItems: { include: { shipment: true } },
            returnRequestItems: { include: { returnRequest: true, units: true } },
            warrantyClaims: true,
            reviews: true,
          },
        },
        shipments: { include: { items: true } },
        serializedUnits: true,
        returnRequests: { include: { items: { include: { units: true } } } },
        warrantyClaims: true,
        supportTickets: { include: { messages: { orderBy: { createdAt: "asc" } } } },
        refunds: { include: { items: true, returnRequest: true, warrantyClaim: true } },
      },
    });
    if (!order) throw new AccountError("NOT_FOUND", "Order not found.");
    return order;
  }

  async anonymize(customerId: string, confirmation: string, auditInput: AccountAudit) {
    if (confirmation !== "ELIMINAR MI CUENTA") {
      throw new AccountError("VALIDATION", "The account deletion confirmation does not match.");
    }
    return inInventoryTransaction(this.db, async (tx) =>
      this.anonymizeInTransaction(tx, customerId, auditInput),
    );
  }

  async anonymizeInTransaction(
    tx: import("./generated/client.js").Prisma.TransactionClient,
    customerId: string,
    auditInput: AccountAudit,
    options: { readonly skipCrmCascade?: boolean } = {},
  ) {
    assertUuid(customerId, "customerId");
    const audit = this.audit(auditInput);
    await acquireOperationLocks(tx, [`store-credit:${customerId}`]);
    await acquireOperationLocks(tx, [`growth-customer:${customerId}`]);
    await acquireOperationLocks(tx, [`customer-account:${customerId}`]);
    const customers = await tx.$queryRaw<
      Customer[]
    >`SELECT * FROM "Customer" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
    const customer = customers[0];
    if (
      !customer ||
      !["ACTIVE", "GUEST"].includes(customer.status) ||
      customer.deletedAt !== null
    ) {
      throw new AccountError("NOT_FOUND", "Customer eligible for anonymization not found.");
    }
    const credit = await tx.storeCreditAccount.aggregate({
      where: { customerId },
      _sum: { availableCents: true, heldCents: true },
    });
    if ((credit._sum.availableCents ?? 0n) !== 0n || (credit._sum.heldCents ?? 0n) !== 0n) {
      throw new AccountError(
        "CONFLICT",
        "Use or resolve store credit before deleting the account.",
      );
    }
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    const [
      blockingOrder,
      blockingPayment,
      blockingRefund,
      blockingReturn,
      blockingWarranty,
      blockingMetaCapi,
    ] = await Promise.all([
      tx.order.findFirst({
        where: {
          customerId,
          OR: [
            { orderStatus: "PENDING" },
            {
              orderStatus: "CONFIRMED",
              OR: [
                { fulfillmentStatus: { not: "FULFILLED" } },
                { paymentStatus: { in: ["UNPAID", "PARTIALLY_PAID"] } },
                { shipments: { some: { status: { notIn: ["DELIVERED", "CANCELLED"] } } } },
              ],
            },
          ],
        },
        select: { id: true },
      }),
      tx.paymentAttempt.findFirst({
        where: { order: { customerId }, status: { in: ["PENDING", "PROCESSING"] } },
        select: { id: true },
      }),
      tx.orderRefund.findFirst({
        where: {
          order: { customerId },
          status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] },
        },
        select: { id: true },
      }),
      tx.returnRequest.findFirst({
        where: {
          order: { customerId },
          status: { in: ["REQUESTED", "AWAITING_RETURN", "RECEIVED"] },
        },
        select: { id: true },
      }),
      tx.warrantyClaim.findFirst({
        where: {
          order: { customerId },
          status: { in: ["REQUESTED", "UNDER_REVIEW", "APPROVED"] },
        },
        select: { id: true },
      }),
      tx.metaCapiEvent.findFirst({
        where: {
          customerId,
          status: "DISPATCHING",
          claimExpiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    if (
      blockingOrder ||
      blockingPayment ||
      blockingRefund ||
      blockingReturn ||
      blockingWarranty ||
      blockingMetaCapi
    ) {
      throw new AccountError(
        "CONFLICT",
        "Complete or resolve active orders, payments, refunds and post-sale requests before deleting the account.",
      );
    }
    await new GrowthService(tx).forfeitCustomerPointsInTransaction(tx, customerId);
    if (!options.skipCrmCascade) {
      try {
        await suppressCustomerCrmLineageInTransaction(tx, customerId, now);
      } catch (error) {
        if (error instanceof CrmError && error.code === "CONFLICT") {
          throw new AccountError("CONFLICT", error.message);
        }
        throw error;
      }
    }
    const previousEmail = customer.email;
    const anonymizedEmail = `anon-${customerId.replaceAll("-", "")}@anonymized.invalid`;
    const activeConsents = await tx.consent.findMany({
      where: {
        customerId,
        purpose: { in: ["MARKETING_EMAIL", "MARKETING_SMS", "ANALYTICS", "ADVERTISING"] },
        status: "GRANTED",
        revokedBy: null,
      },
    });
    for (const consent of activeConsents) {
      await tx.consent.create({
        data: {
          customerId,
          purpose: consent.purpose,
          status: "REVOKED",
          source: "customer-anonymization",
          policyVersion: this.options.privacyPolicyVersion,
          proofHash: createHash("sha256").update(`anonymize:${customerId}:${consent.id}`).digest(),
          ipHash: audit.ipHash,
          userAgentHash: audit.userAgentHash,
          revokesId: consent.id,
        },
      });
    }
    await cancelPendingMetaCapiForCustomerInTransaction(tx, customerId, now);
    await tx.address.deleteMany({ where: { customerId } });
    await tx.wishlistItem.deleteMany({ where: { customerId } });
    await tx.backInStockSubscription.updateMany({
      where: { customerId },
      data: { customerId: null, email: anonymizedEmail, status: "CANCELLED", cancelledAt: now },
    });
    await tx.cart.updateMany({
      where: { customerId, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    await new GrowthService(tx).suppressCustomerGrowthInTransaction(tx, customerId, now);
    await tx.storeCreditAccount.updateMany({
      where: { customerId },
      data: { active: false, version: { increment: 1 } },
    });
    await tx.guestOrderSession.updateMany({
      where: { order: { customerId }, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.guestOrderChallenge.updateMany({
      where: { order: { customerId }, status: { in: ["PENDING", "SENT", "FAILED"] } },
      data: { status: "EXPIRED" },
    });
    await tx.order.updateMany({
      where: { customerId, anonymizedAt: null },
      data: {
        emailSnapshot: null,
        recipientNameSnapshot: null,
        phoneE164Snapshot: null,
        buyerDocumentTypeSnapshot: null,
        buyerDocumentNumberSnapshot: null,
        buyerTaxRegimeSnapshot: null,
        addressLine1Snapshot: null,
        addressLine2Snapshot: null,
        neighborhoodSnapshot: null,
        postalCodeSnapshot: null,
        deliveryNotesSnapshot: null,
        deliveryLatitudeE6: null,
        deliveryLongitudeE6: null,
        acceptanceIpHash: null,
        acceptanceUserAgentHash: null,
        anonymizedAt: now,
      },
    });
    await tx.customer.update({
      where: { id: customerId },
      data: {
        authUserId: null,
        email: anonymizedEmail,
        givenName: null,
        familyName: null,
        phoneE164: null,
        loyaltyPoints: 0,
        status: "ANONYMIZED",
        deletedAt: now,
      },
    });
    await tx.emailEvent.updateMany({
      where: {
        anonymizedAt: null,
        OR: [
          { order: { customerId } },
          { customerId },
          { orderId: null, recipientEmail: previousEmail },
        ],
      },
      data: { recipientEmail: anonymizedEmail, anonymizedAt: now },
    });
    await tx.supportTicket.updateMany({
      where: { requesterCustomerId: customerId, contactEmailSnapshot: { not: anonymizedEmail } },
      data: { contactEmailSnapshot: anonymizedEmail, version: { increment: 1 } },
    });
    const affectedReviews = await tx.review.findMany({
      where: {
        authorDisplayName: { not: "Cliente verificado" },
        OR: [{ requesterCustomerId: customerId }, { orderItem: { order: { customerId } } }],
      },
      select: { product: { select: { slug: true } } },
    });
    await tx.review.updateMany({
      where: {
        authorDisplayName: { not: "Cliente verificado" },
        OR: [{ requesterCustomerId: customerId }, { orderItem: { order: { customerId } } }],
      },
      data: { authorDisplayName: "Cliente verificado" },
    });
    await tx.$executeRaw`
        INSERT INTO "SecurityEvent" ("customerId", "eventType", "ipHash", "userAgentHash", "metadata", "dedupMinute")
        VALUES (${customerId}::uuid, 'CUSTOMER_ACCOUNT_ANONYMIZED', ${audit.ipHash}, ${audit.userAgentHash}, '{"retention":"financial-history-only"}'::jsonb, date_trunc('minute', CURRENT_TIMESTAMP))
        ON CONFLICT ("eventType", "ipHash", "dedupMinute") DO NOTHING
      `;
    if (customer.authUserId) {
      await tx.domainOutbox.create({
        data: {
          eventType: "customer.auth-erasure.requested.v1",
          aggregateType: "Customer",
          aggregateId: customerId,
          deduplicationKey: `customer:${customerId}:auth-erasure:v1`,
          payload: { customerId, authUserId: customer.authUserId },
        },
      });
    }
    const affectedReviewProductSlugs = [
      ...new Set(affectedReviews.map((review) => review.product.slug)),
    ];
    return { customerId, anonymizedAt: now, affectedReviewProductSlugs };
  }

  async getDaneDirectory() {
    return this.db.daneDepartment.findMany({
      include: { municipalities: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    });
  }

  async marketingEmailGranted(customerId: string): Promise<boolean> {
    return marketingEmailConsentGranted(this.db, customerId);
  }

  anonymizedEmailFor(customerId: string): string {
    assertUuid(customerId, "customerId");
    return normalizeEmail(`anon-${customerId.replaceAll("-", "")}@anonymized.invalid`);
  }
}
