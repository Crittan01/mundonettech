import {
  assertCartQuantity,
  assertMoney,
  normalizeCouponCode,
  normalizePromotionSlug,
  normalizeSku,
  parseMoneyCents,
  sanitizeAuditValue,
} from "@mundonettech/core";

import type { Bundle, Coupon, Prisma, PrismaClient, WholesaleTier } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";
import { assertAdminActorInTransaction, databaseNow } from "./primitives.js";
import type {
  BundleInput,
  CouponInput,
  PricingListOptions,
  PricingMutationAudit,
  WholesaleTierInput,
} from "./pricing-types.js";

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingValidationError";
  }
}

export class PricingNotFoundError extends Error {
  constructor(message = "Pricing record not found.") {
    super(message);
    this.name = "PricingNotFoundError";
  }
}

export class PricingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingConflictError";
  }
}

function text(value: string, field: string, maximum: number): string {
  if (typeof value !== "string") throw new PricingValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    normalized !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PricingValidationError(
      `${field} must be printable and within ${maximum} characters.`,
    );
  }
  return normalized;
}

function optionalText(value: string | undefined, field: string, maximum: number): string | null {
  if (value === undefined || value.trim() === "") return null;
  return text(value, field, maximum);
}

function positiveInteger(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new PricingValidationError(`${field} must be a positive 32-bit integer.`);
  }
  return value;
}

function validDate(value: Date | null | undefined, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PricingValidationError(`${field} must be a valid date.`);
  }
  return value;
}

function normalizePage(options: PricingListOptions): { page: number; pageSize: number } {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) {
    throw new PricingValidationError("Invalid pricing page.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new PricingValidationError("Invalid pricing page size.");
  }
  return { page, pageSize };
}

function pageResult<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function wholesaleAuditState(record: WholesaleTier): Prisma.JsonObject {
  return {
    id: record.id,
    scope: record.scope,
    variantId: record.variantId,
    productId: record.productId,
    categoryId: record.categoryId,
    minimumQuantity: record.minimumQuantity,
    unitPriceCents: record.unitPriceCents.toString(),
    active: record.active,
    deleted: record.deletedAt !== null,
  };
}

function couponAuditState(
  record: Coupon,
  productIds: readonly string[],
  categoryIds: readonly string[],
): Prisma.JsonObject {
  return {
    id: record.id,
    code: record.code,
    discountType: record.discountType,
    status: record.status,
    percentageBps: record.percentageBps,
    amountCents: record.amountCents?.toString() ?? null,
    maximumDiscountCents: record.maximumDiscountCents?.toString() ?? null,
    minimumSubtotalCents: record.minimumSubtotalCents.toString(),
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    maximumUsages: record.maximumUsages,
    perCustomerUsages: record.perCustomerUsages,
    productIds: [...productIds].sort(),
    categoryIds: [...categoryIds].sort(),
    deleted: record.deletedAt !== null,
  };
}

function bundleAuditState(
  record: Bundle,
  items: readonly { readonly variantId: string; readonly quantity: number }[],
): Prisma.JsonObject {
  const sortedItems = [...items].sort((left, right) =>
    left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0,
  );
  return {
    id: record.id,
    slug: record.slug,
    status: record.status,
    priceCents: record.priceCents?.toString() ?? null,
    discountCents: record.discountCents.toString(),
    items: Object.fromEntries(
      sortedItems.map((item) => [item.variantId, { quantity: item.quantity }]),
    ),
    deleted: record.deletedAt !== null,
  };
}

async function authorizePricingMutation(
  tx: Prisma.TransactionClient,
  audit: PricingMutationAudit,
): Promise<void> {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (
    audit.ipHash.length !== 32 ||
    (audit.userAgentHash !== null && audit.userAgentHash.length !== 32)
  ) {
    throw new PricingValidationError("Audit hashes must contain 32 bytes.");
  }
  await assertAdminActorInTransaction(tx, audit.actorAdminUserId, "pricing:write");
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  audit: PricingMutationAudit,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.JsonObject,
): Promise<void> {
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      requestId: audit.requestId ?? null,
      metadata: sanitizeAuditValue(metadata) as Prisma.JsonObject,
    },
  });
}

function rethrowWrite(error: unknown, conflictMessage: string): never {
  if (hasUniqueViolation(error)) throw new PricingConflictError(conflictMessage);
  if (error instanceof Error) throw error;
  throw new PricingValidationError("Unknown pricing write failure.");
}

async function resolveWholesaleTarget(
  tx: Prisma.TransactionClient,
  input: WholesaleTierInput,
): Promise<{ variantId: string | null; productId: string | null; categoryId: string | null }> {
  if (!["GLOBAL", "CATEGORY", "PRODUCT", "VARIANT"].includes(input.scope)) {
    throw new PricingValidationError("Invalid wholesale tier scope.");
  }
  if (input.scope === "GLOBAL") {
    if (input.target?.trim()) throw new PricingValidationError("A global tier has no target.");
    return { variantId: null, productId: null, categoryId: null };
  }
  const target = input.target;
  if (!target) throw new PricingValidationError("A scoped wholesale tier requires a target.");
  try {
    if (input.scope === "VARIANT") {
      const sku = normalizeSku(target);
      const variants = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT v."id" FROM "ProductVariant" v
        JOIN "Product" p ON p."id" = v."productId"
        WHERE v."sku" = ${sku} AND v."deletedAt" IS NULL AND p."deletedAt" IS NULL
        FOR SHARE OF v, p
      `;
      const variant = variants[0];
      if (!variant) throw new PricingNotFoundError("Wholesale variant was not found.");
      return { variantId: variant.id, productId: null, categoryId: null };
    }
    const slug = normalizePromotionSlug(target, "target");
    if (input.scope === "PRODUCT") {
      const products = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Product"
        WHERE "slug" = ${slug} AND "deletedAt" IS NULL
        FOR SHARE
      `;
      const product = products[0];
      if (!product) throw new PricingNotFoundError("Wholesale product was not found.");
      return { variantId: null, productId: product.id, categoryId: null };
    }
    const categories = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Category"
      WHERE "slug" = ${slug} AND "deletedAt" IS NULL
      FOR SHARE
    `;
    const category = categories[0];
    if (!category) throw new PricingNotFoundError("Wholesale category was not found.");
    return { variantId: null, productId: null, categoryId: category.id };
  } catch (error) {
    if (error instanceof PricingNotFoundError) throw error;
    throw new PricingValidationError(
      error instanceof Error ? error.message : "Invalid wholesale target.",
    );
  }
}

function normalizeCoupon(input: CouponInput) {
  let code: string;
  try {
    code = normalizeCouponCode(input.code);
  } catch (error) {
    throw new PricingValidationError(error instanceof Error ? error.message : "Invalid coupon.");
  }
  const name = text(input.name, "name", 160);
  if (!["PERCENTAGE", "FIXED_AMOUNT"].includes(input.discountType)) {
    throw new PricingValidationError("Invalid coupon discount type.");
  }
  if (!["DRAFT", "ACTIVE"].includes(input.status)) {
    throw new PricingValidationError("Coupon status must be DRAFT or ACTIVE.");
  }
  const percentageBps =
    input.discountType === "PERCENTAGE"
      ? positiveInteger(input.percentageBps, "percentageBps")
      : null;
  if (input.discountType === "PERCENTAGE" && (percentageBps === null || percentageBps > 10_000)) {
    throw new PricingValidationError("percentageBps must be between 1 and 10000.");
  }
  let amountCents: bigint | null = null;
  let maximumDiscountCents: bigint | null = null;
  let minimumSubtotalCents = 0n;
  try {
    if (input.discountType === "FIXED_AMOUNT") {
      if (!input.amountCents) throw new PricingValidationError("amountCents is required.");
      amountCents = parseMoneyCents(input.amountCents, "amountCents", true);
    } else if (input.amountCents?.trim()) {
      throw new PricingValidationError("Percentage coupons cannot have a fixed amount.");
    }
    maximumDiscountCents = input.maximumDiscountCents?.trim()
      ? parseMoneyCents(input.maximumDiscountCents, "maximumDiscountCents", true)
      : null;
    minimumSubtotalCents = input.minimumSubtotalCents?.trim()
      ? parseMoneyCents(input.minimumSubtotalCents, "minimumSubtotalCents")
      : 0n;
  } catch (error) {
    if (error instanceof PricingValidationError) throw error;
    throw new PricingValidationError(error instanceof Error ? error.message : "Invalid money.");
  }
  const startsAt = validDate(input.startsAt, "startsAt");
  const endsAt = validDate(input.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new PricingValidationError("Coupon end must be after its start.");
  }
  return {
    code,
    name,
    discountType: input.discountType,
    status: input.status,
    percentageBps,
    amountCents,
    maximumDiscountCents,
    minimumSubtotalCents,
    startsAt,
    endsAt,
    maximumUsages: positiveInteger(input.maximumUsages, "maximumUsages"),
    perCustomerUsages: positiveInteger(input.perCustomerUsages, "perCustomerUsages"),
  };
}

function normalizeSlugs(values: readonly string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 200) {
    throw new PricingValidationError(`${field} accepts at most 200 entries.`);
  }
  try {
    const normalized = values.map((value) => normalizePromotionSlug(value, field));
    if (new Set(normalized).size !== normalized.length) {
      throw new PricingValidationError(`${field} cannot contain duplicates.`);
    }
    return normalized.sort();
  } catch (error) {
    if (error instanceof PricingValidationError) throw error;
    throw new PricingValidationError(error instanceof Error ? error.message : `Invalid ${field}.`);
  }
}

async function resolveCouponRestrictions(
  tx: Prisma.TransactionClient,
  productSlugs: readonly string[],
  categorySlugs: readonly string[],
): Promise<{ productIds: string[]; categoryIds: string[] }> {
  const products = productSlugs.length
    ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Product"
        WHERE "slug" = ANY(${[...productSlugs]}::text[]) AND "deletedAt" IS NULL
        ORDER BY "id" ASC
        FOR SHARE
      `
    : [];
  const categories = categorySlugs.length
    ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Category"
        WHERE "slug" = ANY(${[...categorySlugs]}::text[]) AND "deletedAt" IS NULL
        ORDER BY "id" ASC
        FOR SHARE
      `
    : [];
  if (products.length !== productSlugs.length || categories.length !== categorySlugs.length) {
    throw new PricingNotFoundError("A coupon product or category restriction was not found.");
  }
  return {
    productIds: products.map((product) => product.id).sort(),
    categoryIds: categories.map((category) => category.id).sort(),
  };
}

export class PricingService {
  constructor(private readonly db: PrismaClient) {}

  async getWholesaleTier(id: string) {
    assertUuid(id, "wholesaleTierId");
    return this.db.wholesaleTier.findFirst({
      where: { id, deletedAt: null },
      include: {
        variant: { select: { sku: true } },
        product: { select: { slug: true, name: true } },
        category: { select: { slug: true, name: true } },
      },
    });
  }

  async getCoupon(id: string) {
    assertUuid(id, "couponId");
    return this.db.coupon.findFirst({
      where: { id, deletedAt: null },
      include: {
        products: { include: { product: { select: { slug: true, name: true } } } },
        categories: { include: { category: { select: { slug: true, name: true } } } },
        _count: { select: { usages: true } },
      },
    });
  }

  async getBundle(id: string) {
    assertUuid(id, "bundleId");
    return this.db.bundle.findFirst({
      where: { id, deletedAt: null },
      include: {
        items: {
          include: {
            variant: {
              select: { sku: true, priceCents: true, product: { select: { name: true } } },
            },
          },
          orderBy: { variant: { sku: "asc" } },
        },
      },
    });
  }

  async listWholesaleTiers(options: PricingListOptions = {}) {
    const { page: requestedPage, pageSize } = normalizePage(options);
    const total = await this.db.wholesaleTier.count({ where: { deletedAt: null } });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const items = await this.db.wholesaleTier.findMany({
      where: { deletedAt: null },
      include: {
        variant: { select: { sku: true } },
        product: { select: { slug: true, name: true } },
        category: { select: { slug: true, name: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return pageResult(items, total, page, pageSize);
  }

  async upsertWholesaleTier(
    id: string | null,
    input: WholesaleTierInput,
    audit: PricingMutationAudit,
  ) {
    if (id !== null) assertUuid(id, "wholesaleTierId");
    const minimumQuantity = positiveInteger(input.minimumQuantity, "minimumQuantity");
    if (minimumQuantity === null) throw new PricingValidationError("minimumQuantity is required.");
    assertCartQuantity(minimumQuantity, "minimumQuantity");
    let unitPriceCents: bigint;
    try {
      unitPriceCents = parseMoneyCents(input.unitPriceCents, "unitPriceCents");
    } catch (error) {
      throw new PricingValidationError(error instanceof Error ? error.message : "Invalid price.");
    }
    if (typeof input.active !== "boolean")
      throw new PricingValidationError("active must be boolean.");
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizePricingMutation(tx, audit);
        const target = await resolveWholesaleTarget(tx, input);
        const data = {
          scope: input.scope,
          ...target,
          minimumQuantity,
          unitPriceCents,
          active: input.active,
        };
        const peeked = id
          ? await tx.wholesaleTier.findFirst({
              where: { id, deletedAt: null },
              select: {
                scope: true,
                variantId: true,
                productId: true,
                categoryId: true,
                minimumQuantity: true,
              },
            })
          : null;
        if (id && !peeked) throw new PricingNotFoundError("Wholesale tier not found.");
        const newKey = `wholesale:${input.scope}:${JSON.stringify(target)}:${minimumQuantity}`;
        const peekedKey = peeked
          ? `wholesale:${peeked.scope}:${JSON.stringify({
              variantId: peeked.variantId,
              productId: peeked.productId,
              categoryId: peeked.categoryId,
            })}:${peeked.minimumQuantity}`
          : null;
        await acquireOperationLocks(tx, [
          newKey,
          ...(peekedKey ? [peekedKey] : []),
          ...(id ? [`wholesale-tier:${id}`] : []),
        ]);
        let existing: WholesaleTier | null = null;
        if (id) {
          const existingRows = await tx.$queryRaw<WholesaleTier[]>`
            SELECT * FROM "WholesaleTier"
            WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
            FOR UPDATE
          `;
          existing = existingRows[0] ?? null;
          if (!existing) throw new PricingNotFoundError("Wholesale tier not found.");
          const existingKey = `wholesale:${existing.scope}:${JSON.stringify({
            variantId: existing.variantId,
            productId: existing.productId,
            categoryId: existing.categoryId,
          })}:${existing.minimumQuantity}`;
          if (existingKey !== peekedKey) {
            const retry = new Error(
              "Wholesale tier identity changed before lock acquisition.",
            ) as Error & { code: string };
            retry.code = "40001";
            throw retry;
          }
        }
        const saved = existing
          ? await tx.wholesaleTier.update({ where: { id: existing.id }, data })
          : await tx.wholesaleTier.create({ data });
        await writeAudit(
          tx,
          audit,
          existing ? "WHOLESALE_TIER_UPDATED" : "WHOLESALE_TIER_CREATED",
          "WholesaleTier",
          saved.id,
          {
            before: existing ? wholesaleAuditState(existing) : null,
            after: wholesaleAuditState(saved),
          },
        );
        return saved;
      });
    } catch (error) {
      rethrowWrite(error, "An equivalent active wholesale tier already exists.");
    }
  }

  async archiveWholesaleTier(id: string, audit: PricingMutationAudit) {
    assertUuid(id, "wholesaleTierId");
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizePricingMutation(tx, audit);
      const peeked = await tx.wholesaleTier.findFirst({
        where: { id, deletedAt: null },
        select: {
          scope: true,
          variantId: true,
          productId: true,
          categoryId: true,
          minimumQuantity: true,
        },
      });
      if (!peeked) throw new PricingNotFoundError("Wholesale tier not found.");
      const peekedTarget = {
        variantId: peeked.variantId,
        productId: peeked.productId,
        categoryId: peeked.categoryId,
      };
      const peekedKey = `wholesale:${peeked.scope}:${JSON.stringify(peekedTarget)}:${peeked.minimumQuantity}`;
      await acquireOperationLocks(tx, [`wholesale-tier:${id}`, peekedKey]);
      const existingRows = await tx.$queryRaw<WholesaleTier[]>`
        SELECT * FROM "WholesaleTier"
        WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      const existing = existingRows[0];
      if (!existing) throw new PricingNotFoundError("Wholesale tier not found.");
      const existingKey = `wholesale:${existing.scope}:${JSON.stringify({
        variantId: existing.variantId,
        productId: existing.productId,
        categoryId: existing.categoryId,
      })}:${existing.minimumQuantity}`;
      if (existingKey !== peekedKey) {
        const retry = new Error(
          "Wholesale tier identity changed before lock acquisition.",
        ) as Error & { code: string };
        retry.code = "40001";
        throw retry;
      }
      const now = await databaseNow(tx);
      const updated = await tx.wholesaleTier.update({
        where: { id },
        data: { active: false, deletedAt: now },
      });
      await writeAudit(tx, audit, "WHOLESALE_TIER_ARCHIVED", "WholesaleTier", id, {
        before: wholesaleAuditState(existing),
        after: wholesaleAuditState(updated),
      });
      return updated;
    });
  }

  async listCoupons(options: PricingListOptions = {}) {
    const { page: requestedPage, pageSize } = normalizePage(options);
    const total = await this.db.coupon.count({ where: { deletedAt: null } });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const items = await this.db.coupon.findMany({
      where: { deletedAt: null },
      include: {
        products: { include: { product: { select: { slug: true, name: true } } } },
        categories: { include: { category: { select: { slug: true, name: true } } } },
        _count: { select: { usages: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return pageResult(items, total, page, pageSize);
  }

  async upsertCoupon(id: string | null, input: CouponInput, audit: PricingMutationAudit) {
    if (id !== null) assertUuid(id, "couponId");
    const data = normalizeCoupon(input);
    const productSlugs = normalizeSlugs(input.productSlugs, "productSlugs");
    const categorySlugs = normalizeSlugs(input.categorySlugs, "categorySlugs");
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizePricingMutation(tx, audit);
        const peekedCode = id
          ? ((
              await tx.coupon.findFirst({
                where: { id, deletedAt: null },
                select: { code: true },
              })
            )?.code ?? null)
          : null;
        await acquireOperationLocks(tx, [
          `coupon-code:${data.code}`,
          ...(peekedCode ? [`coupon-code:${peekedCode}`] : []),
          ...(id ? [`coupon-redemption:${id}`, `coupon-write:${id}`] : []),
        ]);
        const existing = id
          ? await tx.coupon.findFirst({
              where: { id, deletedAt: null },
              include: {
                products: { select: { productId: true } },
                categories: { select: { categoryId: true } },
              },
            })
          : null;
        if (id && !existing) throw new PricingNotFoundError("Coupon not found.");
        if (existing && existing.code !== peekedCode) {
          const retry = new Error("Coupon code changed before locks were acquired.") as Error & {
            code: string;
          };
          retry.code = "40001";
          throw retry;
        }
        const restrictions = await resolveCouponRestrictions(tx, productSlugs, categorySlugs);
        const saved = existing
          ? await tx.coupon.update({
              where: { id: existing.id },
              data: {
                ...data,
                products: {
                  deleteMany: {},
                  create: restrictions.productIds.map((productId) => ({ productId })),
                },
                categories: {
                  deleteMany: {},
                  create: restrictions.categoryIds.map((categoryId) => ({ categoryId })),
                },
              },
            })
          : await tx.coupon.create({
              data: {
                ...data,
                products: { create: restrictions.productIds.map((productId) => ({ productId })) },
                categories: {
                  create: restrictions.categoryIds.map((categoryId) => ({ categoryId })),
                },
              },
            });
        await writeAudit(
          tx,
          audit,
          existing ? "COUPON_UPDATED" : "COUPON_CREATED",
          "Coupon",
          saved.id,
          {
            before: existing
              ? couponAuditState(
                  existing,
                  existing.products.map((entry) => entry.productId),
                  existing.categories.map((entry) => entry.categoryId),
                )
              : null,
            after: couponAuditState(saved, restrictions.productIds, restrictions.categoryIds),
            couponIdentityChanged: existing === null || existing.code !== saved.code,
            nameChanged: existing === null || existing.name !== saved.name,
          },
        );
        return saved;
      });
    } catch (error) {
      rethrowWrite(error, "An active coupon with this code already exists.");
    }
  }

  async archiveCoupon(id: string, audit: PricingMutationAudit) {
    assertUuid(id, "couponId");
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizePricingMutation(tx, audit);
      await acquireOperationLocks(tx, [`coupon-redemption:${id}`, `coupon-write:${id}`]);
      const existing = await tx.coupon.findFirst({
        where: { id, deletedAt: null },
        include: {
          products: { select: { productId: true } },
          categories: { select: { categoryId: true } },
        },
      });
      if (!existing) throw new PricingNotFoundError("Coupon not found.");
      const beforeProductIds = existing.products.map((entry) => entry.productId);
      const beforeCategoryIds = existing.categories.map((entry) => entry.categoryId);
      const now = await databaseNow(tx);
      const released = await tx.couponUsage.updateMany({
        where: { couponId: id, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: now },
      });
      const updated = await tx.coupon.update({
        where: { id },
        data: { status: "ARCHIVED", deletedAt: now },
      });
      await writeAudit(tx, audit, "COUPON_ARCHIVED", "Coupon", id, {
        before: couponAuditState(existing, beforeProductIds, beforeCategoryIds),
        after: couponAuditState(updated, beforeProductIds, beforeCategoryIds),
        releasedReservationCount: released.count,
      });
      return updated;
    });
  }

  async listBundles(options: PricingListOptions = {}) {
    const { page: requestedPage, pageSize } = normalizePage(options);
    const total = await this.db.bundle.count({ where: { deletedAt: null } });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const items = await this.db.bundle.findMany({
      where: { deletedAt: null },
      include: {
        items: {
          include: {
            variant: {
              select: { sku: true, priceCents: true, product: { select: { name: true } } },
            },
          },
          orderBy: { variant: { sku: "asc" } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return pageResult(items, total, page, pageSize);
  }

  async upsertBundle(id: string | null, input: BundleInput, audit: PricingMutationAudit) {
    if (id !== null) assertUuid(id, "bundleId");
    let slug: string;
    try {
      slug = normalizePromotionSlug(input.slug);
    } catch (error) {
      throw new PricingValidationError(error instanceof Error ? error.message : "Invalid slug.");
    }
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description, "description", 1000);
    if (!["DRAFT", "ACTIVE"].includes(input.status)) {
      throw new PricingValidationError("Bundle status must be DRAFT or ACTIVE.");
    }
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
      throw new PricingValidationError("A bundle requires between 1 and 50 components.");
    }
    const skus = input.items.map((item) => {
      try {
        assertCartQuantity(item.quantity, "component quantity");
        return normalizeSku(item.sku);
      } catch (error) {
        throw new PricingValidationError(
          error instanceof Error ? error.message : "Invalid component.",
        );
      }
    });
    if (new Set(skus).size !== skus.length) {
      throw new PricingValidationError("A bundle cannot repeat a SKU.");
    }
    let priceCents: bigint | null;
    let discountCents: bigint;
    try {
      priceCents = input.priceCents?.trim()
        ? parseMoneyCents(input.priceCents, "priceCents")
        : null;
      discountCents = input.discountCents?.trim()
        ? parseMoneyCents(input.discountCents, "discountCents")
        : 0n;
    } catch (error) {
      throw new PricingValidationError(
        error instanceof Error ? error.message : "Invalid bundle money.",
      );
    }
    if (
      (priceCents === null && discountCents !== 0n) ||
      (priceCents !== null && discountCents > priceCents)
    ) {
      throw new PricingValidationError("Bundle discount is inconsistent with its base price.");
    }
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        await authorizePricingMutation(tx, audit);
        await acquireOperationLocks(tx, [`bundle-slug:${slug}`, ...(id ? [`bundle:${id}`] : [])]);
        const lockedVariants = await tx.$queryRaw<
          Array<{
            id: string;
            sku: string;
            status: string;
            priceCents: bigint;
            productId: string;
            productStatus: string;
            brandId: string;
            brandDeletedAt: Date | null;
            categoryId: string;
            categoryDeletedAt: Date | null;
          }>
        >`
          SELECT v."id", v."sku", v."status", v."priceCents",
                 p."id" AS "productId", p."status" AS "productStatus",
                 b."id" AS "brandId", b."deletedAt" AS "brandDeletedAt",
                 c."id" AS "categoryId", c."deletedAt" AS "categoryDeletedAt"
          FROM "ProductVariant" v
          JOIN "Product" p ON p."id" = v."productId"
          JOIN "Brand" b ON b."id" = p."brandId"
          JOIN "Category" c ON c."id" = p."categoryId"
          WHERE v."sku" = ANY(${skus}::text[])
            AND v."deletedAt" IS NULL
            AND p."deletedAt" IS NULL
          ORDER BY v."id" ASC
          FOR SHARE OF v, p, b, c
        `;
        if (lockedVariants.length !== skus.length)
          throw new PricingNotFoundError("A bundle SKU was not found.");
        const bySku = new Map(lockedVariants.map((variant) => [variant.sku, variant]));
        const resolvedItems = input.items.map((item) => {
          const normalizedSku = normalizeSku(item.sku);
          const variant = bySku.get(normalizedSku);
          if (!variant) throw new PricingNotFoundError("A bundle SKU was not found.");
          return { variantId: variant.id, quantity: item.quantity };
        });
        if (input.status === "ACTIVE") {
          const invalid = lockedVariants.some(
            (variant) =>
              variant.status !== "ACTIVE" ||
              variant.productStatus !== "ACTIVE" ||
              variant.brandDeletedAt !== null ||
              variant.categoryDeletedAt !== null,
          );
          if (invalid)
            throw new PricingValidationError("Active bundles require sellable components.");
        }
        const componentsTotal = lockedVariants.reduce((sum, variant) => {
          const inputItem = input.items.find((item) => normalizeSku(item.sku) === variant.sku);
          return sum + variant.priceCents * BigInt(inputItem?.quantity ?? 0);
        }, 0n);
        assertMoney(componentsTotal, "componentsTotal");
        const basePrice = priceCents ?? componentsTotal;
        if (input.status === "ACTIVE" && basePrice - discountCents > componentsTotal) {
          throw new PricingValidationError(
            "An active bundle cannot cost more than its components.",
          );
        }
        const existing = id
          ? await tx.bundle.findFirst({ where: { id, deletedAt: null }, include: { items: true } })
          : null;
        if (id && !existing) throw new PricingNotFoundError("Bundle not found.");
        if (existing) {
          const before = existing.items.map((item) => `${item.variantId}:${item.quantity}`).sort();
          const after = resolvedItems.map((item) => `${item.variantId}:${item.quantity}`).sort();
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            const activeCarts = await tx.cartItem.count({
              where: { bundleId: existing.id, cart: { status: "ACTIVE" } },
            });
            if (activeCarts > 0) {
              throw new PricingConflictError(
                "Bundle composition cannot change while active carts reference it; archive and replace it instead.",
              );
            }
          }
        }
        const data = { slug, name, description, status: input.status, priceCents, discountCents };
        const saved = existing
          ? await tx.bundle.update({
              where: { id: existing.id },
              data: { ...data, items: { deleteMany: {}, create: resolvedItems } },
            })
          : await tx.bundle.create({ data: { ...data, items: { create: resolvedItems } } });
        await writeAudit(
          tx,
          audit,
          existing ? "BUNDLE_UPDATED" : "BUNDLE_CREATED",
          "Bundle",
          saved.id,
          {
            before: existing ? bundleAuditState(existing, existing.items) : null,
            after: bundleAuditState(saved, resolvedItems),
            nameChanged: existing === null || existing.name !== saved.name,
            detailsChanged: existing === null || existing.description !== saved.description,
          },
        );
        return saved;
      });
    } catch (error) {
      rethrowWrite(error, "An active bundle with this slug already exists.");
    }
  }

  async archiveBundle(id: string, audit: PricingMutationAudit) {
    assertUuid(id, "bundleId");
    return inInventoryTransaction(this.db, async (tx) => {
      await authorizePricingMutation(tx, audit);
      await acquireOperationLocks(tx, [`bundle:${id}`]);
      const existing = await tx.bundle.findFirst({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      if (!existing) throw new PricingNotFoundError("Bundle not found.");
      const now = await databaseNow(tx);
      const updated = await tx.bundle.update({
        where: { id },
        data: { status: "ARCHIVED", deletedAt: now },
      });
      await writeAudit(tx, audit, "BUNDLE_ARCHIVED", "Bundle", id, {
        before: bundleAuditState(existing, existing.items),
        after: bundleAuditState(updated, existing.items),
      });
      return updated;
    });
  }
}
