import {
  assertCartQuantity,
  assertMoney,
  normalizeCouponCode,
  normalizePromotionSlug,
  normalizeSku,
  parseMoneyCents,
} from "@mundonettech/core";

import type { Prisma, PrismaClient } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";
import { databaseNow } from "./primitives.js";
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

async function writeAudit(
  tx: Prisma.TransactionClient,
  audit: PricingMutationAudit,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Prisma.JsonObject,
): Promise<void> {
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (
    audit.ipHash.length !== 32 ||
    (audit.userAgentHash !== null && audit.userAgentHash.length !== 32)
  ) {
    throw new PricingValidationError("Audit hashes must contain 32 bytes.");
  }
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType,
      targetId,
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      metadata,
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
      const variant = await tx.productVariant.findFirst({
        where: { sku, deletedAt: null },
        select: { id: true },
      });
      if (!variant) throw new PricingNotFoundError("Wholesale variant was not found.");
      return { variantId: variant.id, productId: null, categoryId: null };
    }
    const slug = normalizePromotionSlug(target, "target");
    if (input.scope === "PRODUCT") {
      const product = await tx.product.findFirst({
        where: { slug, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw new PricingNotFoundError("Wholesale product was not found.");
      return { variantId: null, productId: product.id, categoryId: null };
    }
    const category = await tx.category.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
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
  const [products, categories] = await Promise.all([
    productSlugs.length
      ? tx.product.findMany({
          where: { slug: { in: [...productSlugs] }, deletedAt: null },
          select: { id: true, slug: true },
        })
      : [],
    categorySlugs.length
      ? tx.category.findMany({
          where: { slug: { in: [...categorySlugs] }, deletedAt: null },
          select: { id: true, slug: true },
        })
      : [],
  ]);
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
        const target = await resolveWholesaleTarget(tx, input);
        const data = {
          scope: input.scope,
          ...target,
          minimumQuantity,
          unitPriceCents,
          active: input.active,
        };
        const existing = id
          ? await tx.wholesaleTier.findFirst({ where: { id, deletedAt: null } })
          : null;
        if (id && !existing) throw new PricingNotFoundError("Wholesale tier not found.");
        await acquireOperationLocks(tx, [
          `wholesale:${input.scope}:${JSON.stringify(target)}:${minimumQuantity}`,
        ]);
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
            previous: existing
              ? {
                  scope: existing.scope,
                  variantId: existing.variantId,
                  productId: existing.productId,
                  categoryId: existing.categoryId,
                  minimumQuantity: existing.minimumQuantity,
                  unitPriceCents: existing.unitPriceCents.toString(),
                  active: existing.active,
                }
              : null,
            scope: saved.scope,
            minimumQuantity: saved.minimumQuantity,
            unitPriceCents: saved.unitPriceCents.toString(),
            active: saved.active,
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
      const existing = await tx.wholesaleTier.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new PricingNotFoundError("Wholesale tier not found.");
      const target = {
        variantId: existing.variantId,
        productId: existing.productId,
        categoryId: existing.categoryId,
      };
      await acquireOperationLocks(tx, [
        `wholesale:${existing.scope}:${JSON.stringify(target)}:${existing.minimumQuantity}`,
      ]);
      const now = await databaseNow(tx);
      const updated = await tx.wholesaleTier.update({
        where: { id },
        data: { active: false, deletedAt: now },
      });
      await writeAudit(tx, audit, "WHOLESALE_TIER_ARCHIVED", "WholesaleTier", id, {
        scope: existing.scope,
        minimumQuantity: existing.minimumQuantity,
        unitPriceCents: existing.unitPriceCents.toString(),
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
        await acquireOperationLocks(tx, [`coupon-code:${data.code}`]);
        const restrictions = await resolveCouponRestrictions(tx, productSlugs, categorySlugs);
        const existing = id ? await tx.coupon.findFirst({ where: { id, deletedAt: null } }) : null;
        if (id && !existing) throw new PricingNotFoundError("Coupon not found.");
        if (existing) await acquireOperationLocks(tx, [`coupon-write:${existing.id}`]);
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
            previousCode: existing?.code ?? null,
            code: saved.code,
            discountType: saved.discountType,
            percentageBps: saved.percentageBps,
            amountCents: saved.amountCents?.toString() ?? null,
            maximumDiscountCents: saved.maximumDiscountCents?.toString() ?? null,
            minimumSubtotalCents: saved.minimumSubtotalCents.toString(),
            maximumUsages: saved.maximumUsages,
            perCustomerUsages: saved.perCustomerUsages,
            status: saved.status,
            productSlugs,
            categorySlugs,
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
      await acquireOperationLocks(tx, [`coupon-redemption:${id}`, `coupon-write:${id}`]);
      const existing = await tx.coupon.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new PricingNotFoundError("Coupon not found.");
      const now = await databaseNow(tx);
      const updated = await tx.coupon.update({
        where: { id },
        data: { status: "ARCHIVED", deletedAt: now },
      });
      await tx.couponUsage.updateMany({
        where: { couponId: id, status: "RESERVED" },
        data: { status: "RELEASED", releasedAt: now },
      });
      await writeAudit(tx, audit, "COUPON_ARCHIVED", "Coupon", id, { code: existing.code });
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
        await acquireOperationLocks(tx, [`bundle-slug:${slug}`, ...(id ? [`bundle:${id}`] : [])]);
        const variants = await tx.productVariant.findMany({
          where: { sku: { in: skus }, deletedAt: null },
          include: { product: { include: { brand: true, category: true } } },
        });
        if (variants.length !== skus.length)
          throw new PricingNotFoundError("A bundle SKU was not found.");
        const bySku = new Map(variants.map((variant) => [variant.sku, variant]));
        const resolvedItems = input.items.map((item) => {
          const normalizedSku = normalizeSku(item.sku);
          const variant = bySku.get(normalizedSku);
          if (!variant) throw new PricingNotFoundError("A bundle SKU was not found.");
          return { variantId: variant.id, quantity: item.quantity };
        });
        if (input.status === "ACTIVE") {
          const invalid = variants.some(
            (variant) =>
              variant.status !== "ACTIVE" ||
              variant.product.status !== "ACTIVE" ||
              variant.product.deletedAt !== null ||
              variant.product.brand.deletedAt !== null ||
              variant.product.category.deletedAt !== null,
          );
          if (invalid)
            throw new PricingValidationError("Active bundles require sellable components.");
        }
        const componentsTotal = variants.reduce((sum, variant) => {
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
            previousSlug: existing?.slug ?? null,
            slug: saved.slug,
            status: saved.status,
            priceCents: saved.priceCents?.toString() ?? null,
            discountCents: saved.discountCents.toString(),
            items: resolvedItems.map((item) => ({ ...item, quantity: item.quantity })),
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
      await acquireOperationLocks(tx, [`bundle:${id}`]);
      const existing = await tx.bundle.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new PricingNotFoundError("Bundle not found.");
      const now = await databaseNow(tx);
      const updated = await tx.bundle.update({
        where: { id },
        data: { status: "ARCHIVED", deletedAt: now },
      });
      await writeAudit(tx, audit, "BUNDLE_ARCHIVED", "Bundle", id, { slug: existing.slug });
      return updated;
    });
  }
}
