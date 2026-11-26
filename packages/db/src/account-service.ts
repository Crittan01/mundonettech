import { createHash } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";

import type { Contact, Customer, Prisma, PrismaClient } from "./generated/client.js";
import {
  CrmError,
  findCustomerCrmLineageIds,
  retryableLockDivergenceError,
  suppressCustomerCrmLineageInTransaction,
} from "./crm-shared.js";
import { GrowthError, GrowthService, marketingEmailConsentGranted } from "./growth-service.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  inInventoryTransaction,
} from "./inventory-shared.js";
import { revokeCustomerLifecycleConsentInTransaction } from "./lifecycle-cancellation.js";
import { cancelPendingMetaCapiForCustomerInTransaction } from "./meta-capi.js";

export interface CustomerAnonymizationLockScope {
  readonly cartIds: readonly string[];
  readonly couponIds: readonly string[];
  readonly orderIds: readonly string[];
  readonly segmentIds: readonly string[];
  readonly referralCounterpartyIds: readonly string[];
  readonly ticketIds: readonly string[];
  readonly reviewIds: readonly string[];
}

export function hasNewIds(locked: readonly string[], current: readonly string[]): boolean {
  if (current.length === 0) return false;
  const held = new Set(locked);
  return current.some((id) => !held.has(id));
}

export function sameSortedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function peekEnteredSegmentIds(
  tx: Prisma.TransactionClient,
  customerIds: readonly string[],
): Promise<string[]> {
  if (customerIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ segmentId: string }>>`
    WITH latest AS (
      SELECT DISTINCT ON (membership."segmentId", membership."customerId")
        membership."segmentId",
        membership."status"
      FROM "CustomerSegmentMembership" membership
      WHERE membership."customerId" = ANY(${[...customerIds]}::uuid[])
      ORDER BY membership."segmentId", membership."customerId", membership."sequence" DESC
    )
    SELECT DISTINCT "segmentId" FROM latest WHERE "status" = 'ENTERED' ORDER BY "segmentId"
  `;
  return rows.map((row) => row.segmentId);
}

export async function peekCustomerAnonymizationScope(
  tx: Prisma.TransactionClient,
  customerIds: readonly string[],
): Promise<CustomerAnonymizationLockScope> {
  const uniqueCustomerIds = [...new Set(customerIds)].sort(compareStrings);
  if (uniqueCustomerIds.length === 0) {
    return {
      cartIds: [],
      couponIds: [],
      orderIds: [],
      segmentIds: [],
      referralCounterpartyIds: [],
      ticketIds: [],
      reviewIds: [],
    };
  }
  const [carts, orders, segmentIds, attributedReferrals, tickets, reviews] = await Promise.all([
    tx.$queryRaw<Array<{ id: string; couponId: string | null }>>`
      SELECT "id", "couponId" FROM "Cart"
      WHERE "customerId" = ANY(${uniqueCustomerIds}::uuid[]) AND "status" = 'ACTIVE'
      ORDER BY "id"
    `,
    tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order"
      WHERE "customerId" = ANY(${uniqueCustomerIds}::uuid[]) AND "anonymizedAt" IS NULL
      ORDER BY "id"
    `,
    peekEnteredSegmentIds(tx, uniqueCustomerIds),
    tx.referral.findMany({
      where: {
        status: "ATTRIBUTED",
        OR: [
          { referrerCustomerId: { in: uniqueCustomerIds } },
          { referredCustomerId: { in: uniqueCustomerIds } },
        ],
      },
      select: { referrerCustomerId: true, referredCustomerId: true },
    }),
    tx.supportTicket.findMany({
      where: {
        OR: [
          { requesterCustomerId: { in: uniqueCustomerIds } },
          { order: { customerId: { in: uniqueCustomerIds } } },
        ],
      },
      select: { id: true, contactEmailSnapshot: true },
      orderBy: { id: "asc" },
    }),
    tx.review.findMany({
      where: {
        authorDisplayName: { not: "Cliente verificado" },
        OR: [
          { requesterCustomerId: { in: uniqueCustomerIds } },
          { orderItem: { order: { customerId: { in: uniqueCustomerIds } } } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const cartIds = carts.map((cart) => cart.id);
  const reservedUsages =
    cartIds.length > 0
      ? await tx.couponUsage.findMany({
          where: { cartId: { in: cartIds }, status: "RESERVED" },
          select: { couponId: true },
        })
      : [];
  const couponIds = [
    ...new Set([
      ...carts.map((cart) => cart.couponId).filter((id): id is string => id !== null),
      ...reservedUsages.map((usage) => usage.couponId),
    ]),
  ].sort(compareStrings);
  const customerIdSet = new Set(uniqueCustomerIds);
  const referralCounterpartyIds = [
    ...new Set(
      attributedReferrals
        .flatMap((referral) => [referral.referrerCustomerId, referral.referredCustomerId])
        .filter((id) => !customerIdSet.has(id)),
    ),
  ].sort(compareStrings);
  const anonymizedEmails = new Set(
    uniqueCustomerIds.map((id) => `anon-${id.replaceAll("-", "")}@anonymized.invalid`),
  );
  const ticketIds = tickets
    .filter((ticket) => !anonymizedEmails.has(ticket.contactEmailSnapshot))
    .map((ticket) => ticket.id)
    .sort(compareStrings);
  const reviewIds = reviews.map((review) => review.id).sort(compareStrings);
  return {
    cartIds,
    couponIds,
    orderIds: orders.map((order) => order.id),
    segmentIds,
    referralCounterpartyIds,
    ticketIds,
    reviewIds,
  };
}

export async function acquireCustomerContactLockHierarchy(
  tx: Prisma.TransactionClient,
  input: {
    readonly customerIds: readonly string[];
    readonly contactIds: readonly string[];
    readonly scope: CustomerAnonymizationLockScope;
  },
): Promise<{ readonly customers: Customer[]; readonly contacts: Contact[] }> {
  const uniqueCustomerIds = [...new Set(input.customerIds)].sort(compareStrings);
  const uniqueContactIds = [...new Set(input.contactIds)].sort(compareStrings);
  const {
    cartIds,
    couponIds,
    orderIds,
    segmentIds,
    referralCounterpartyIds,
    ticketIds,
    reviewIds,
  } = input.scope;

  // Level 1: coupon-redemption:<couponId> (sorted) -> Cart FOR UPDATE (sorted by id)
  if (couponIds.length > 0) {
    await acquireOperationLocks(
      tx,
      couponIds.map((id) => `coupon-redemption:${id}`),
    );
  }
  if (cartIds.length > 0) {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Cart"
      WHERE "id" = ANY(${[...cartIds]}::uuid[])
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  // Level 2: order-payment:<orderId> (sorted) -> Order FOR UPDATE (sorted by id)
  if (orderIds.length > 0) {
    await acquireOperationLocks(
      tx,
      orderIds.map((id) => `order-payment:${id}`),
    );
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Order"
      WHERE "id" = ANY(${[...orderIds]}::uuid[])
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  // Level 2.5: customer-segment:<segmentId> (sorted) before growth-customer (strict acyclic order)
  if (segmentIds.length > 0) {
    await acquireOperationLocks(
      tx,
      segmentIds.map((id) => `customer-segment:${id}`),
    );
  }

  // Level 3: ALL customer-level advisory locks in ONE sorted call -> Customer FOR UPDATE (sorted by id)
  let customers: Customer[] = [];
  if (uniqueCustomerIds.length > 0) {
    await acquireOperationLocks(tx, [
      ...uniqueCustomerIds.flatMap((id) => [
        `crm-customer:${id}`,
        `customer-account:${id}`,
        `growth-customer:${id}`,
        `store-credit:${id}`,
      ]),
      ...referralCounterpartyIds.map((id) => `growth-customer:${id}`),
    ]);
    customers = await tx.$queryRaw<Customer[]>`
      SELECT * FROM "Customer"
      WHERE "id" = ANY(${uniqueCustomerIds}::uuid[])
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  // Level 4: ALL contact-level advisory locks in ONE sorted call -> Contact FOR UPDATE (sorted by id)
  let contacts: Contact[] = [];
  if (uniqueContactIds.length > 0) {
    await acquireOperationLocks(
      tx,
      uniqueContactIds.map((id) => `crm-contact:${id}`),
    );
    contacts = await tx.$queryRaw<Contact[]>`
      SELECT * FROM "Contact"
      WHERE "id" = ANY(${uniqueContactIds}::uuid[])
      ORDER BY "id"
      FOR UPDATE
    `;
  }

  // Level 5: review:<id>, support:<id> (sorted)
  const level5Locks = [
    ...reviewIds.map((id) => `review:${id}`),
    ...ticketIds.map((id) => `support:${id}`),
  ];
  if (level5Locks.length > 0) {
    await acquireOperationLocks(tx, level5Locks);
  }

  return { customers, contacts };
}

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
    await acquireOperationLocks(tx, [
      `customer-account:${customerId}`,
      `growth-customer:${customerId}`,
    ]);
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
      const peekSegments = !values.marketingEmail
        ? await peekEnteredSegmentIds(tx, [customerId])
        : [];
      if (peekSegments.length > 0) {
        await acquireOperationLocks(
          tx,
          peekSegments.map((id) => `customer-segment:${id}`),
        );
      }
      const customer = await this.lockActiveCustomer(tx, customerId);
      if (!values.marketingEmail) {
        const verifiedSegments = await peekEnteredSegmentIds(tx, [customerId]);
        if (hasNewIds(peekSegments, verifiedSegments)) {
          throw retryableLockDivergenceError("Customer segment membership changed concurrently.");
        }
      }
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
      if (currentlyGranted && !values.marketingEmail) {
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
            "lastReminderActivityAt" = "lastActivityAt",
            "lastReminderOutcome" = 'NO_CONSENT'
          WHERE "customerId" = ${customerId}::uuid AND "status" = 'DETECTED'
        `;
        await revokeCustomerLifecycleConsentInTransaction(tx, customerId, now);
      }
      if (currentlyAdvertisingGranted && !values.advertising) {
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
    const active = await this.db.customer.findFirst({
      where: { id: customerId, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!active) throw new AccountError("NOT_FOUND", "Active customer account not found.");
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
      omit: {
        acceptanceIpHash: true,
        acceptanceUserAgentHash: true,
      },
      include: { items: { select: { id: true, titleSnapshot: true, quantity: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
  }

  async getOrder(customerId: string, orderId: string) {
    assertUuid(customerId, "customerId");
    assertUuid(orderId, "orderId");
    const active = await this.db.customer.findFirst({
      where: { id: customerId, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });
    if (!active) throw new AccountError("NOT_FOUND", "Active customer account not found.");
    const order = await this.db.order.findFirst({
      where: { id: orderId, customerId },
      omit: {
        acceptanceIpHash: true,
        acceptanceUserAgentHash: true,
      },
      include: {
        items: {
          omit: { unitCostWacCents: true },
          include: {
            variant: {
              omit: { costCents: true },
              include: {
                product: {
                  include: {
                    brand: { select: { deletedAt: true } },
                    category: { select: { deletedAt: true } },
                    variants: {
                      where: { deletedAt: null, status: "ACTIVE" },
                      omit: { costCents: true },
                      include: {
                        stockLevels: {
                          where: { location: { deletedAt: null, type: { not: "QUARANTINE" } } },
                          select: { onHand: true, committed: true, safetyStock: true },
                        },
                      },
                    },
                  },
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
    options: { readonly skipCrmCascade?: boolean; readonly alreadyLocked?: boolean } = {},
  ) {
    assertUuid(customerId, "customerId");
    const audit = this.audit(auditInput);
    let customer: Customer | undefined;
    if (options.alreadyLocked) {
      customer = (await tx.customer.findUnique({ where: { id: customerId } })) ?? undefined;
    } else {
      const peekScope = await peekCustomerAnonymizationScope(tx, [customerId]);
      const peekContactIds = options.skipCrmCascade
        ? []
        : await findCustomerCrmLineageIds(tx, [customerId]);
      const locked = await acquireCustomerContactLockHierarchy(tx, {
        customerIds: [customerId],
        contactIds: peekContactIds,
        scope: peekScope,
      });
      customer = locked.customers.find((item) => item.id === customerId);
      const [verifiedScope, verifiedContactIds] = await Promise.all([
        peekCustomerAnonymizationScope(tx, [customerId]),
        options.skipCrmCascade ? Promise.resolve([]) : findCustomerCrmLineageIds(tx, [customerId]),
      ]);
      if (
        hasNewIds(peekScope.cartIds, verifiedScope.cartIds) ||
        hasNewIds(peekScope.couponIds, verifiedScope.couponIds) ||
        hasNewIds(peekScope.orderIds, verifiedScope.orderIds) ||
        hasNewIds(peekScope.segmentIds, verifiedScope.segmentIds) ||
        hasNewIds(peekScope.referralCounterpartyIds, verifiedScope.referralCounterpartyIds) ||
        hasNewIds(peekScope.ticketIds, verifiedScope.ticketIds) ||
        hasNewIds(peekScope.reviewIds, verifiedScope.reviewIds) ||
        (!options.skipCrmCascade && !sameSortedIds(peekContactIds, verifiedContactIds))
      ) {
        throw retryableLockDivergenceError(
          "Customer anonymization dependencies changed concurrently.",
        );
      }
    }
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
      blockingPaymentTransaction,
      blockingTaxInvoice,
      blockingCreditNote,
      blockingUninvoicedOrder,
      blockingUncreditedRefund,
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
        where: {
          order: { customerId },
          status: { in: ["REQUIRES_ACTION", "PENDING", "PROCESSING", "AUTHORIZED"] },
        },
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
        },
        select: { id: true },
      }),
      tx.paymentTransaction.findFirst({
        where: {
          attempt: { order: { customerId } },
          status: { in: ["PENDING", "PROCESSING"] },
        },
        select: { id: true },
      }),
      tx.taxInvoice.findFirst({
        where: {
          order: { customerId },
          status: { not: "ACCEPTED" },
        },
        select: { id: true },
      }),
      tx.creditNote.findFirst({
        where: {
          invoice: { order: { customerId } },
          status: { not: "ACCEPTED" },
        },
        select: { id: true },
      }),
      tx.order.findFirst({
        where: {
          customerId,
          taxRegime: "RESPONSABLE_IVA",
          paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
          OR: [{ taxInvoice: null }, { taxInvoice: { is: { status: { not: "ACCEPTED" } } } }],
        },
        select: { id: true },
      }),
      tx.orderRefund.findFirst({
        where: {
          order: {
            customerId,
            taxRegime: "RESPONSABLE_IVA",
            taxInvoice: { is: { status: "ACCEPTED" } },
          },
          status: "COMPLETED",
          OR: [{ creditNote: null }, { creditNote: { is: { status: { not: "ACCEPTED" } } } }],
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
      blockingMetaCapi ||
      blockingPaymentTransaction ||
      blockingTaxInvoice ||
      blockingCreditNote ||
      blockingUninvoicedOrder ||
      blockingUncreditedRefund
    ) {
      throw new AccountError(
        "CONFLICT",
        "Complete or resolve active orders, payments, refunds, fiscal documents and post-sale requests before deleting the account.",
      );
    }
    try {
      await new GrowthService(tx).forfeitCustomerPointsInTransaction(tx, customerId);
    } catch (error) {
      if (error instanceof GrowthError && error.code === "CONFLICT") {
        throw new AccountError("CONFLICT", error.message);
      }
      throw error;
    }
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
      where: {
        OR: [{ customerId }, { customerId: null, email: previousEmail }],
      },
      data: { customerId: null, email: anonymizedEmail, status: "CANCELLED", cancelledAt: now },
    });
    await tx.$executeRaw`
      UPDATE "AbandonedCart" SET "contactEmail" = NULL,
        "lastReminderActivityAt" = COALESCE("lastReminderActivityAt", "lastActivityAt"),
        "lastReminderOutcome" = 'SUPPRESSED'
      WHERE "customerId" IS NULL AND lower("contactEmail") = lower(${previousEmail})
    `;
    const activeCarts = await tx.cart.findMany({
      where: { customerId, status: "ACTIVE" },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (activeCarts.length > 0) {
      const activeCartIds = activeCarts.map((cart) => cart.id);
      await tx.couponUsage.updateMany({
        where: { cartId: { in: activeCartIds }, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: now },
      });
      await tx.cart.updateMany({
        where: { id: { in: activeCartIds }, status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
    }
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
      data: {
        recipientEmail: anonymizedEmail,
        subjectSnapshot: "Notificación anonimizada",
        htmlBodySnapshot: "<p>Contenido anonimizado por solicitud de privacidad.</p>",
        textBodySnapshot: "Contenido anonimizado por solicitud de privacidad.",
        variablesSnapshot: {},
        anonymizedAt: now,
      },
    });
    await tx.supportTicket.updateMany({
      where: {
        OR: [{ requesterCustomerId: customerId }, { order: { customerId } }],
        contactEmailSnapshot: { not: anonymizedEmail },
      },
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
