import {
  assertCartQuantity,
  assertMoney,
  calculateCartPricing,
  maxCartLines,
  normalizeCouponCode,
  type CartPricingIssue,
  type PricingBundle,
  type PricingCoupon,
  type PricingLineInput,
  type PricingTier,
} from "@mundonettech/core";

import type {
  Bundle,
  Cart,
  CartItem,
  Coupon,
  Prisma,
  PrismaClient,
  ProductVariant,
} from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  hasUniqueViolation,
  inInventoryTransaction,
} from "./inventory-shared.js";
import type { PricingMutationAudit } from "./pricing-types.js";
import type { CartReference, CartSnapshot } from "./cart-types.js";

const blockingIssueCodes = new Set([
  "CART_EMPTY",
  "PRODUCT_UNAVAILABLE",
  "STOCK_INSUFFICIENT",
  "BUNDLE_UNAVAILABLE",
  "BUNDLE_CHANGED",
  "BUNDLE_PRICE_INVALID",
  "MONEY_OVERFLOW",
]);
const issueCodes = new Set([
  ...blockingIssueCodes,
  "COUPON_INVALID",
  "COUPON_MINIMUM_NOT_MET",
  "PRICE_CHANGED",
]);

export class CartNotFoundError extends Error {
  constructor(message = "Cart not found.") {
    super(message);
    this.name = "CartNotFoundError";
  }
}

export class CartStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartStateError";
  }
}

export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

export class CartStockError extends Error {
  constructor(
    message: string,
    readonly variantId: string | null = null,
    readonly available: number | null = null,
  ) {
    super(message);
    this.name = "CartStockError";
  }
}

export type CouponErrorCode =
  | "INVALID_CODE"
  | "NOT_FOUND"
  | "INACTIVE"
  | "SCHEDULE"
  | "MAXIMUM_USAGES"
  | "CUSTOMER_USAGES"
  | "MINIMUM_SUBTOTAL"
  | "NO_ELIGIBLE_ITEMS"
  | "EMPTY_CART";

export class CouponError extends Error {
  constructor(
    readonly code: CouponErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CouponError";
  }
}

type VariantWithProduct = ProductVariant & {
  product: {
    id: string;
    slug: string;
    name: string;
    status: string;
    deletedAt: Date | null;
    categoryId: string;
    brand: { deletedAt: Date | null };
    category: { deletedAt: Date | null };
  };
};

type CartItemWithVariant = CartItem & { variant: VariantWithProduct };
type CouponWithRestrictions = Coupon & {
  products: Array<{ productId: string }>;
  categories: Array<{ categoryId: string }>;
};
type CartWithItems = Cart & {
  items: CartItemWithVariant[];
  coupon: CouponWithRestrictions | null;
};

const cartInclude = {
  items: {
    include: {
      variant: {
        include: { product: { include: { brand: true, category: true } } },
      },
    },
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  },
  coupon: { include: { products: true, categories: true } },
} satisfies Prisma.CartInclude;

function assertTokenHash(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new CartValidationError(`${field} must contain 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function validateExpiration(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CartValidationError(`${field} must be a valid date.`);
  }
  return value;
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  return rows[0]!.now;
}

async function loadCart(tx: Prisma.TransactionClient, id: string): Promise<CartWithItems> {
  const cart = await tx.cart.findUnique({ where: { id }, include: cartInclude });
  if (!cart) throw new CartNotFoundError();
  return cart as CartWithItems;
}

async function lockCart(
  tx: Prisma.TransactionClient,
  reference: CartReference,
): Promise<{ cart: CartWithItems; now: Date }> {
  let rows: Cart[];
  if ("cartId" in reference) {
    assertUuid(reference.cartId, "cartId");
    rows = await tx.$queryRaw<Cart[]>`
      SELECT * FROM "Cart" WHERE "id" = ${reference.cartId}::uuid FOR UPDATE
    `;
  } else {
    const hash = assertTokenHash(reference.accessTokenHash, "accessTokenHash");
    rows = await tx.$queryRaw<Cart[]>`
      SELECT * FROM "Cart" WHERE "accessTokenHash" = ${hash} FOR UPDATE
    `;
  }
  const row = rows[0];
  if (!row) throw new CartNotFoundError();
  return { cart: await loadCart(tx, row.id), now: await databaseNow(tx) };
}

function assertActiveCart(cart: Cart, now: Date): void {
  if (cart.status !== "ACTIVE") throw new CartStateError("Cart is not active.");
  if (cart.expiresAt <= now) throw new CartStateError("Cart has expired.");
}

async function writeCartAudit(
  tx: Prisma.TransactionClient,
  audit: PricingMutationAudit | undefined,
  action: string,
  cartId: string,
  metadata: Prisma.JsonObject = {},
): Promise<void> {
  if (!audit) return;
  assertUuid(audit.actorAdminUserId, "actorAdminUserId");
  if (
    audit.ipHash.length !== 32 ||
    (audit.userAgentHash !== null && audit.userAgentHash.length !== 32)
  ) {
    throw new CartValidationError("Audit hashes must contain 32 bytes.");
  }
  await tx.adminActionLog.create({
    data: {
      actorAdminUserId: audit.actorAdminUserId,
      action,
      targetType: "Cart",
      targetId: cartId,
      ipHash: Uint8Array.from(audit.ipHash),
      userAgentHash: audit.userAgentHash ? Uint8Array.from(audit.userAgentHash) : null,
      metadata,
    },
  });
}

async function availabilityFor(
  tx: Prisma.TransactionClient,
  variantIds: readonly string[],
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ variantId: string; available: bigint }>>`
    SELECT level."variantId",
      COALESCE(sum(available_stock(level."onHand", level."committed", level."safetyStock")), 0)::bigint AS available
    FROM "StockLevel" level
    JOIN "StockLocation" location ON location."id" = level."locationId"
    WHERE level."variantId" = ANY(${[...new Set(variantIds)]}::uuid[])
      AND location."deletedAt" IS NULL AND location."type" <> 'QUARANTINE'
    GROUP BY level."variantId"
  `;
  return new Map(
    rows.map((row) => [
      row.variantId,
      row.available > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(row.available),
    ]),
  );
}

function parseIssues(value: Prisma.JsonValue): CartPricingIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: CartPricingIssue[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.code !== "string" || !issueCodes.has(record.code)) continue;
    const issue: {
      code: string;
      variantId?: string;
      bundleId?: string;
      available?: number;
      requested?: number;
    } = { code: record.code };
    if (typeof record.variantId === "string") issue.variantId = record.variantId;
    if (typeof record.bundleId === "string") issue.bundleId = record.bundleId;
    if (typeof record.available === "number" && Number.isSafeInteger(record.available)) {
      issue.available = record.available;
    }
    if (typeof record.requested === "number" && Number.isSafeInteger(record.requested)) {
      issue.requested = record.requested;
    }
    issues.push(issue as CartPricingIssue);
  }
  return issues;
}

function serializeIssues(issues: readonly CartPricingIssue[]): Prisma.InputJsonValue {
  return issues.map((issue) => ({
    code: issue.code,
    ...(issue.variantId ? { variantId: issue.variantId } : {}),
    ...(issue.bundleId ? { bundleId: issue.bundleId } : {}),
    ...(issue.available !== undefined ? { available: issue.available } : {}),
    ...(issue.requested !== undefined ? { requested: issue.requested } : {}),
  }));
}

function isSellable(variant: VariantWithProduct): boolean {
  return (
    variant.status === "ACTIVE" &&
    variant.deletedAt === null &&
    variant.product.status === "ACTIVE" &&
    variant.product.deletedAt === null &&
    variant.product.brand.deletedAt === null &&
    variant.product.category.deletedAt === null
  );
}

function couponDefinition(coupon: CouponWithRestrictions): PricingCoupon {
  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    percentageBps: coupon.percentageBps,
    amountCents: coupon.amountCents,
    maximumDiscountCents: coupon.maximumDiscountCents,
    minimumSubtotalCents: coupon.minimumSubtotalCents,
    productIds: coupon.products.map((entry) => entry.productId),
    categoryIds: coupon.categories.map((entry) => entry.categoryId),
  };
}

function couponIsCurrent(coupon: CouponWithRestrictions, now: Date): boolean {
  return (
    coupon.status === "ACTIVE" &&
    coupon.deletedAt === null &&
    (coupon.startsAt === null || coupon.startsAt <= now) &&
    (coupon.endsAt === null || coupon.endsAt > now)
  );
}

async function releaseCoupon(
  tx: Prisma.TransactionClient,
  cartId: string,
  now: Date,
  couponId?: string,
): Promise<void> {
  await tx.couponUsage.updateMany({
    where: { cartId, status: "RESERVED", ...(couponId ? { couponId } : {}) },
    data: { status: "RELEASED", releasedAt: now },
  });
}

function bundleDefinition(
  bundle: Bundle & { items: Array<{ variantId: string; quantity: number }> },
): PricingBundle {
  return {
    id: bundle.id,
    basePriceCents: bundle.priceCents,
    discountCents: bundle.discountCents,
    components: Object.fromEntries(bundle.items.map((item) => [item.variantId, item.quantity])),
  };
}

async function storedSnapshot(tx: Prisma.TransactionClient, cartId: string): Promise<CartSnapshot> {
  const cart = await loadCart(tx, cartId);
  const [availability, bundles] = await Promise.all([
    availabilityFor(
      tx,
      cart.items.map((item) => item.variantId),
    ),
    cart.items.some((item) => item.bundleId)
      ? tx.bundle.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  cart.items.map((item) => item.bundleId).filter((id): id is string => id !== null),
                ),
              ],
            },
          },
          include: { items: true },
        })
      : [],
  ]);
  const bundleMap = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const issues = parseIssues(cart.pricingIssues);
  return {
    id: cart.id,
    kind: cart.kind,
    status: cart.status,
    customerId: cart.customerId,
    items: cart.items.map((item) => {
      const bundle = item.bundleId ? bundleMap.get(item.bundleId) : null;
      return {
        id: item.id,
        variantId: item.variantId,
        productId: item.variant.productId,
        productName: item.variant.product.name || item.productNameSnapshot,
        productSlug: item.variant.product.slug || item.productSlugSnapshot,
        sku: item.variant.sku || item.skuSnapshot,
        quantity: item.quantity,
        available: availability.get(item.variantId) ?? 0,
        unitPriceCents: item.unitPriceCents.toString(),
        wholesaleDiscountCents: item.wholesaleDiscountCents.toString(),
        bundleDiscountCents: item.bundleDiscountCents.toString(),
        couponDiscountCents: item.couponDiscountCents.toString(),
        lineTotalCents: item.lineTotalCents.toString(),
        wholesaleTierId: null,
        bundle:
          bundle && item.bundleQuantity !== null
            ? { id: bundle.id, slug: bundle.slug, name: bundle.name, quantity: item.bundleQuantity }
            : null,
      };
    }),
    coupon: cart.coupon
      ? { id: cart.coupon.id, code: cart.coupon.code, name: cart.coupon.name }
      : null,
    subtotalCents: cart.subtotalCents.toString(),
    wholesaleDiscountCents: cart.wholesaleDiscountCents.toString(),
    bundleDiscountCents: cart.bundleDiscountCents.toString(),
    couponDiscountCents: cart.couponDiscountCents.toString(),
    totalCents: cart.totalCents.toString(),
    itemCount: cart.itemCount,
    totalUnits: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    issues,
    canContinue:
      cart.status === "ACTIVE" && !issues.some((issue) => blockingIssueCodes.has(issue.code)),
    expiresAt: cart.expiresAt.toISOString(),
    assistedExpiresAt: cart.assistedExpiresAt?.toISOString() ?? null,
    revalidatedAt: (cart.priceRevalidatedAt ?? cart.updatedAt).toISOString(),
  };
}

function assertStrictMutation(snapshot: CartSnapshot): void {
  const stockIssue = snapshot.issues.find((issue) => issue.code === "STOCK_INSUFFICIENT");
  if (stockIssue) {
    throw new CartStockError(
      "Requested quantity exceeds effective stock.",
      stockIssue.variantId ?? null,
      stockIssue.available ?? null,
    );
  }
  const blocking = snapshot.issues.find(
    (issue) => blockingIssueCodes.has(issue.code) && issue.code !== "CART_EMPTY",
  );
  if (blocking) throw new CartStateError(`Cart cannot be mutated: ${blocking.code}.`);
}

function repricedQuantityData(
  item: CartItem,
  quantity: number,
  bundleQuantity?: number,
): Prisma.CartItemUpdateInput {
  return {
    quantity,
    ...(bundleQuantity === undefined ? {} : { bundleQuantity }),
    wholesaleDiscountCents: 0n,
    bundleDiscountCents: 0n,
    couponDiscountCents: 0n,
    lineTotalCents: assertMoney(item.unitPriceCents * BigInt(quantity), "lineTotalCents"),
  };
}

export class CartService {
  constructor(private readonly db: PrismaClient) {}

  private async revalidateLocked(
    tx: Prisma.TransactionClient,
    cartId: string,
    suppliedNow?: Date,
  ): Promise<CartSnapshot> {
    let cart = await loadCart(tx, cartId);
    const now = suppliedNow ?? (await databaseNow(tx));
    assertActiveCart(cart, now);
    const bundleIds = [
      ...new Set(cart.items.map((item) => item.bundleId).filter((id): id is string => id !== null)),
    ].sort();
    await acquireOperationLocks(
      tx,
      bundleIds.map((id) => `bundle:${id}`),
    );

    const variantIds = cart.items.map((item) => item.variantId);
    const productIds = [...new Set(cart.items.map((item) => item.variant.productId))];
    const categoryIds = [...new Set(cart.items.map((item) => item.variant.product.categoryId))];
    const [availability, tiers, bundleRecords] = await Promise.all([
      availabilityFor(tx, variantIds),
      cart.items.length
        ? tx.wholesaleTier.findMany({
            where: {
              active: true,
              deletedAt: null,
              OR: [
                { scope: "GLOBAL" },
                { scope: "VARIANT", variantId: { in: [...new Set(variantIds)] } },
                { scope: "PRODUCT", productId: { in: productIds } },
                { scope: "CATEGORY", categoryId: { in: categoryIds } },
              ],
            },
          })
        : [],
      bundleIds.length
        ? tx.bundle.findMany({ where: { id: { in: bundleIds } }, include: { items: true } })
        : [],
    ]);
    const tierInputs: PricingTier[] = tiers.map((tier) => ({
      id: tier.id,
      scope: tier.scope,
      variantId: tier.variantId,
      productId: tier.productId,
      categoryId: tier.categoryId,
      minimumQuantity: tier.minimumQuantity,
      unitPriceCents: tier.unitPriceCents,
    }));
    const bundleMap = new Map(bundleRecords.map((bundle) => [bundle.id, bundle]));
    const pricingBundles = new Map<string, PricingBundle>();
    const issues: CartPricingIssue[] = cart.items.length ? [] : [{ code: "CART_EMPTY" }];
    const requestedByVariant = new Map<string, number>();

    for (const item of cart.items) {
      requestedByVariant.set(
        item.variantId,
        (requestedByVariant.get(item.variantId) ?? 0) + item.quantity,
      );
      if (!isSellable(item.variant))
        issues.push({ code: "PRODUCT_UNAVAILABLE", variantId: item.variantId });
    }
    for (const [variantId, requested] of requestedByVariant) {
      const available = availability.get(variantId) ?? 0;
      if (requested > available) {
        issues.push({ code: "STOCK_INSUFFICIENT", variantId, available, requested });
      }
    }

    const bundleGroups = new Map<string, CartItemWithVariant[]>();
    for (const item of cart.items) {
      if (!item.bundleId) continue;
      const group = bundleGroups.get(item.bundleId) ?? [];
      group.push(item);
      bundleGroups.set(item.bundleId, group);
    }
    for (const [bundleId, group] of bundleGroups) {
      const bundle = bundleMap.get(bundleId);
      if (
        !bundle ||
        bundle.status !== "ACTIVE" ||
        bundle.deletedAt !== null ||
        bundle.items.length === 0
      ) {
        issues.push({ code: "BUNDLE_UNAVAILABLE", bundleId });
        continue;
      }
      if (group.some((item) => !isSellable(item.variant))) {
        issues.push({ code: "BUNDLE_UNAVAILABLE", bundleId });
        continue;
      }
      const bundleQuantity = group[0]?.bundleQuantity ?? null;
      const actual = group.map((item) => `${item.variantId}:${item.quantity}`).sort();
      const expected = bundle.items
        .map((item) => `${item.variantId}:${item.quantity * (bundleQuantity ?? 0)}`)
        .sort();
      if (
        !bundleQuantity ||
        group.some((item) => item.bundleQuantity !== bundleQuantity) ||
        group.length !== bundle.items.length ||
        JSON.stringify(actual) !== JSON.stringify(expected)
      ) {
        issues.push({ code: "BUNDLE_CHANGED", bundleId });
        continue;
      }
      const currentComponentsTotal = group.reduce(
        (sum, item) => sum + item.variant.priceCents * BigInt(item.quantity),
        0n,
      );
      const basePerBundle = bundle.priceCents ?? currentComponentsTotal / BigInt(bundleQuantity);
      if (
        bundle.discountCents > basePerBundle ||
        (basePerBundle - bundle.discountCents) * BigInt(bundleQuantity) > currentComponentsTotal
      ) {
        issues.push({ code: "BUNDLE_PRICE_INVALID", bundleId });
        continue;
      }
      pricingBundles.set(bundleId, bundleDefinition(bundle));
    }

    if (cart.coupon && !couponIsCurrent(cart.coupon, now)) {
      issues.push({ code: "COUPON_INVALID" });
      await releaseCoupon(tx, cart.id, now, cart.coupon.id);
      await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } });
      cart = { ...cart, coupon: null };
    }

    const pricingLines: PricingLineInput[] = cart.items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      productId: item.variant.productId,
      categoryId: item.variant.product.categoryId,
      quantity: item.quantity,
      unitPriceCents: item.variant.priceCents,
      bundleId: item.bundleId,
      bundleQuantity: item.bundleQuantity,
    }));
    let pricing: ReturnType<typeof calculateCartPricing>;
    try {
      pricing = calculateCartPricing(
        pricingLines,
        tierInputs,
        pricingBundles,
        cart.coupon ? couponDefinition(cart.coupon) : null,
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      issues.push({ code: "MONEY_OVERFLOW" });
      await tx.cart.update({
        where: { id: cart.id },
        data: { pricingIssues: serializeIssues(issues), priceRevalidatedAt: now },
      });
      return storedSnapshot(tx, cart.id);
    }

    if (cart.coupon) {
      const discountedSubtotal =
        pricing.subtotalCents - pricing.wholesaleDiscountCents - pricing.bundleDiscountCents;
      if (discountedSubtotal < cart.coupon.minimumSubtotalCents) {
        issues.push({ code: "COUPON_MINIMUM_NOT_MET" });
      } else if (
        (cart.coupon.products.length > 0 || cart.coupon.categories.length > 0) &&
        pricing.eligibleCouponSubtotalCents === 0n
      ) {
        issues.push({ code: "COUPON_INVALID" });
      }
    }
    const priceChanged =
      cart.priceRevalidatedAt !== null &&
      cart.items.some((item) => {
        const calculated = pricing.lines.find((line) => line.id === item.id);
        return !calculated || calculated.unitPriceCents !== item.unitPriceCents;
      });
    if (priceChanged) issues.push({ code: "PRICE_CHANGED" });

    for (const item of cart.items) {
      const calculated = pricing.lines.find((line) => line.id === item.id);
      if (!calculated) throw new CartStateError("Cart pricing omitted a persisted line.");
      await tx.cartItem.update({
        where: { id: item.id },
        data: {
          productNameSnapshot: item.variant.product.name,
          productSlugSnapshot: item.variant.product.slug,
          skuSnapshot: item.variant.sku,
          unitPriceCents: calculated.unitPriceCents,
          wholesaleDiscountCents: calculated.wholesaleDiscountCents,
          bundleDiscountCents: calculated.bundleDiscountCents,
          couponDiscountCents: calculated.couponDiscountCents,
          lineTotalCents: calculated.lineTotalCents,
        },
      });
    }
    await tx.cart.update({
      where: { id: cart.id },
      data: {
        subtotalCents: pricing.subtotalCents,
        wholesaleDiscountCents: pricing.wholesaleDiscountCents,
        bundleDiscountCents: pricing.bundleDiscountCents,
        couponDiscountCents: pricing.couponDiscountCents,
        totalCents: pricing.totalCents,
        itemCount: cart.items.length,
        pricingIssues: serializeIssues(issues),
        priceRevalidatedAt: now,
      },
    });
    const snapshot = await storedSnapshot(tx, cart.id);
    return {
      ...snapshot,
      items: snapshot.items.map((line) => ({
        ...line,
        wholesaleTierId:
          pricing.lines.find((candidate) => candidate.id === line.id)?.wholesaleTierId ?? null,
      })),
    };
  }

  private async mutate(
    reference: CartReference,
    audit: PricingMutationAudit | undefined,
    action: string,
    callback: (tx: Prisma.TransactionClient, cart: CartWithItems, now: Date) => Promise<void>,
    strict = true,
  ): Promise<CartSnapshot> {
    return inInventoryTransaction(this.db, async (tx) => {
      const { cart, now } = await lockCart(tx, reference);
      assertActiveCart(cart, now);
      await callback(tx, cart, now);
      await writeCartAudit(tx, audit, action, cart.id);
      const snapshot = await this.revalidateLocked(tx, cart.id, now);
      if (strict) assertStrictMutation(snapshot);
      return snapshot;
    });
  }

  async createStorefrontCart(input: {
    accessTokenHash: Uint8Array;
    expiresAt: Date;
    customerId?: string;
  }): Promise<CartSnapshot> {
    const accessTokenHash = assertTokenHash(input.accessTokenHash, "accessTokenHash");
    const expiresAt = validateExpiration(input.expiresAt, "expiresAt");
    if (input.customerId) assertUuid(input.customerId, "customerId");
    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const now = await databaseNow(tx);
        if (expiresAt <= now)
          throw new CartValidationError("Cart expiration must be in the future.");
        if (input.customerId) {
          const customer = await tx.customer.findFirst({
            where: { id: input.customerId, deletedAt: null, status: { not: "ANONYMIZED" } },
            select: { id: true },
          });
          if (!customer) throw new CartValidationError("Customer is not available.");
        }
        const cart = await tx.cart.create({
          data: {
            accessTokenHash,
            expiresAt,
            customerId: input.customerId ?? null,
            priceRevalidatedAt: now,
          },
        });
        return this.revalidateLocked(tx, cart.id, now);
      });
    } catch (error) {
      if (hasUniqueViolation(error)) throw new CartStateError("Cart access token already exists.");
      throw error;
    }
  }

  async getByAccessToken(accessTokenHash: Uint8Array): Promise<CartSnapshot | null> {
    assertTokenHash(accessTokenHash, "accessTokenHash");
    return inInventoryTransaction(this.db, async (tx) => {
      const locked = await lockCart(tx, { accessTokenHash }).catch((error: unknown) => {
        if (error instanceof CartNotFoundError) return null;
        throw error;
      });
      if (!locked || locked.cart.status !== "ACTIVE" || locked.cart.expiresAt <= locked.now)
        return null;
      return this.revalidateLocked(tx, locked.cart.id, locked.now);
    });
  }

  async getById(cartId: string): Promise<CartSnapshot> {
    assertUuid(cartId, "cartId");
    return inInventoryTransaction(this.db, async (tx) => {
      const { cart, now } = await lockCart(tx, { cartId });
      if (cart.status !== "ACTIVE" || cart.expiresAt <= now) return storedSnapshot(tx, cart.id);
      return this.revalidateLocked(tx, cart.id, now);
    });
  }

  async assignCustomer(reference: CartReference, customerId: string): Promise<CartSnapshot> {
    assertUuid(customerId, "customerId");
    return this.mutate(reference, undefined, "CART_CUSTOMER_ASSIGNED", async (tx, cart) => {
      if (cart.customerId && cart.customerId !== customerId) {
        throw new CartStateError("Cart already belongs to another customer.");
      }
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null, status: { not: "ANONYMIZED" } },
        select: { id: true },
      });
      if (!customer) throw new CartValidationError("Customer is not available.");
      if (cart.customerId === customerId) return;
      await releaseCoupon(tx, cart.id, await databaseNow(tx));
      await tx.cart.update({ where: { id: cart.id }, data: { customerId, couponId: null } });
    });
  }

  async addVariant(
    reference: CartReference,
    variantId: string,
    quantity: number,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    assertUuid(variantId, "variantId");
    assertCartQuantity(quantity);
    return this.mutate(reference, audit, "CART_VARIANT_ADDED", async (tx, cart) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, deletedAt: null },
        include: { product: { include: { brand: true, category: true } } },
      });
      if (!variant || !isSellable(variant as VariantWithProduct)) {
        throw new CartValidationError("Product variant is not sellable.");
      }
      const existing = cart.items.find(
        (item) => item.variantId === variantId && item.bundleId === null,
      );
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      assertCartQuantity(nextQuantity);
      if (!existing && cart.items.length >= maxCartLines)
        throw new CartStateError("Cart line limit reached.");
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: repricedQuantityData(existing, nextQuantity),
        });
      } else {
        const typedVariant = variant as VariantWithProduct;
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            variantId,
            quantity,
            productNameSnapshot: typedVariant.product.name,
            productSlugSnapshot: typedVariant.product.slug,
            skuSnapshot: typedVariant.sku,
            unitPriceCents: typedVariant.priceCents,
            lineTotalCents: assertMoney(
              typedVariant.priceCents * BigInt(quantity),
              "lineTotalCents",
            ),
          },
        });
      }
    });
  }

  async setVariantQuantity(
    reference: CartReference,
    itemId: string,
    quantity: number,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    assertUuid(itemId, "itemId");
    assertCartQuantity(quantity, "quantity", false);
    return this.mutate(reference, audit, "CART_VARIANT_QUANTITY_UPDATED", async (tx, cart) => {
      const item = cart.items.find(
        (candidate) => candidate.id === itemId && candidate.bundleId === null,
      );
      if (!item) throw new CartNotFoundError("Standalone cart item not found.");
      if (quantity === 0) await tx.cartItem.delete({ where: { id: item.id } });
      else {
        await tx.cartItem.update({
          where: { id: item.id },
          data: repricedQuantityData(item, quantity),
        });
      }
    });
  }

  async addBundle(
    reference: CartReference,
    bundleId: string,
    quantity: number,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    assertUuid(bundleId, "bundleId");
    assertCartQuantity(quantity);
    return this.mutate(reference, audit, "CART_BUNDLE_ADDED", async (tx, cart) => {
      await acquireOperationLocks(tx, [`bundle:${bundleId}`]);
      const bundle = await tx.bundle.findFirst({
        where: { id: bundleId, status: "ACTIVE", deletedAt: null },
        include: {
          items: {
            include: {
              variant: { include: { product: { include: { brand: true, category: true } } } },
            },
            orderBy: { variant: { sku: "asc" } },
          },
        },
      });
      if (!bundle || bundle.items.length === 0)
        throw new CartValidationError("Bundle is not available.");
      if (bundle.items.some((item) => !isSellable(item.variant as VariantWithProduct))) {
        throw new CartValidationError("Bundle contains an unavailable component.");
      }
      const existing = cart.items.filter((item) => item.bundleId === bundleId);
      const bundleQuantity = (existing[0]?.bundleQuantity ?? 0) + quantity;
      assertCartQuantity(bundleQuantity, "bundleQuantity");
      if (
        existing.length > 0 &&
        (existing.length !== bundle.items.length ||
          existing.some(
            (item) =>
              item.bundleQuantity !== existing[0]?.bundleQuantity ||
              !bundle.items.some((component) => component.variantId === item.variantId),
          ))
      ) {
        throw new CartStateError(
          "Existing bundle composition changed; remove it before adding again.",
        );
      }
      if (cart.items.length - existing.length + bundle.items.length > maxCartLines) {
        throw new CartStateError("Cart line limit reached.");
      }
      for (const component of bundle.items) {
        const variant = component.variant as VariantWithProduct;
        const itemQuantity = component.quantity * bundleQuantity;
        assertCartQuantity(itemQuantity, "component quantity");
        const current = existing.find((item) => item.variantId === component.variantId);
        if (current) {
          await tx.cartItem.update({
            where: { id: current.id },
            data: repricedQuantityData(current, itemQuantity, bundleQuantity),
          });
        } else {
          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              variantId: component.variantId,
              bundleId,
              quantity: itemQuantity,
              bundleQuantity,
              productNameSnapshot: variant.product.name,
              productSlugSnapshot: variant.product.slug,
              skuSnapshot: variant.sku,
              unitPriceCents: variant.priceCents,
              lineTotalCents: assertMoney(
                variant.priceCents * BigInt(itemQuantity),
                "lineTotalCents",
              ),
            },
          });
        }
      }
    });
  }

  async setBundleQuantity(
    reference: CartReference,
    bundleId: string,
    quantity: number,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    assertUuid(bundleId, "bundleId");
    assertCartQuantity(quantity, "bundleQuantity", false);
    return this.mutate(reference, audit, "CART_BUNDLE_QUANTITY_UPDATED", async (tx, cart) => {
      const group = cart.items.filter((item) => item.bundleId === bundleId);
      if (group.length === 0) throw new CartNotFoundError("Bundle is not in this cart.");
      if (quantity === 0) {
        await tx.cartItem.deleteMany({ where: { cartId: cart.id, bundleId } });
        return;
      }
      const bundle = await tx.bundle.findFirst({
        where: { id: bundleId, status: "ACTIVE", deletedAt: null },
        include: { items: true },
      });
      if (!bundle) throw new CartStateError("Bundle is no longer available.");
      if (group.length !== bundle.items.length)
        throw new CartStateError("Bundle composition changed.");
      for (const component of bundle.items) {
        const item = group.find((candidate) => candidate.variantId === component.variantId);
        if (!item) throw new CartStateError("Bundle composition changed.");
        const itemQuantity = component.quantity * quantity;
        assertCartQuantity(itemQuantity, "component quantity");
        await tx.cartItem.update({
          where: { id: item.id },
          data: repricedQuantityData(item, itemQuantity, quantity),
        });
      }
    });
  }

  async removeItem(
    reference: CartReference,
    itemId: string,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    assertUuid(itemId, "itemId");
    return this.mutate(
      reference,
      audit,
      "CART_ITEM_REMOVED",
      async (tx, cart) => {
        const item = cart.items.find((candidate) => candidate.id === itemId);
        if (!item) throw new CartNotFoundError("Cart item not found.");
        if (item.bundleId)
          await tx.cartItem.deleteMany({ where: { cartId: cart.id, bundleId: item.bundleId } });
        else await tx.cartItem.delete({ where: { id: item.id } });
      },
      false,
    );
  }

  async clear(reference: CartReference, audit?: PricingMutationAudit): Promise<CartSnapshot> {
    return this.mutate(
      reference,
      audit,
      "CART_CLEARED",
      async (tx, cart, now) => {
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await releaseCoupon(tx, cart.id, now);
        await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } });
      },
      false,
    );
  }

  async applyCoupon(
    reference: CartReference,
    rawCode: string,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    let code: string;
    try {
      code = normalizeCouponCode(rawCode);
    } catch {
      throw new CouponError("INVALID_CODE", "Coupon code format is invalid.");
    }
    return inInventoryTransaction(this.db, async (tx) => {
      const coupon = await tx.coupon.findFirst({
        where: { code, deletedAt: null },
        include: { products: true, categories: true },
      });
      if (!coupon) throw new CouponError("NOT_FOUND", "Coupon was not found.");
      await acquireOperationLocks(tx, [`coupon-redemption:${coupon.id}`]);
      const { cart, now } = await lockCart(tx, reference);
      assertActiveCart(cart, now);
      if (cart.items.length === 0)
        throw new CouponError("EMPTY_CART", "Cannot apply a coupon to an empty cart.");
      if (coupon.status !== "ACTIVE") throw new CouponError("INACTIVE", "Coupon is not active.");
      if (!couponIsCurrent(coupon as CouponWithRestrictions, now)) {
        throw new CouponError("SCHEDULE", "Coupon is outside its validity schedule.");
      }
      const persistedUsage = await tx.couponUsage.findFirst({
        where: { couponId: coupon.id, cartId: cart.id, status: "RESERVED" },
      });
      const currentUsage = persistedUsage && persistedUsage.expiresAt > now ? persistedUsage : null;
      if (!currentUsage) {
        const counts = await tx.$queryRaw<Array<{ total: number; customer: number }>>`
          SELECT
            count(*) FILTER (WHERE "status" = 'REDEEMED' OR ("status" = 'RESERVED' AND "expiresAt" > CURRENT_TIMESTAMP))::int AS total,
            count(*) FILTER (WHERE "customerId" = ${cart.customerId}::uuid AND ("status" = 'REDEEMED' OR ("status" = 'RESERVED' AND "expiresAt" > CURRENT_TIMESTAMP)))::int AS customer
          FROM "CouponUsage"
          WHERE "couponId" = ${coupon.id}::uuid
        `;
        const count = counts[0] ?? { total: 0, customer: 0 };
        if (coupon.maximumUsages !== null && count.total >= coupon.maximumUsages) {
          throw new CouponError("MAXIMUM_USAGES", "Coupon redemption limit has been reached.");
        }
        if (
          cart.customerId &&
          coupon.perCustomerUsages !== null &&
          count.customer >= coupon.perCustomerUsages
        ) {
          throw new CouponError("CUSTOMER_USAGES", "Customer coupon limit has been reached.");
        }
      }
      if (!currentUsage) {
        await releaseCoupon(tx, cart.id, now);
        const expiresAt =
          coupon.endsAt && coupon.endsAt < cart.expiresAt ? coupon.endsAt : cart.expiresAt;
        await tx.couponUsage.create({
          data: { couponId: coupon.id, cartId: cart.id, customerId: cart.customerId, expiresAt },
        });
      }
      await tx.cart.update({ where: { id: cart.id }, data: { couponId: coupon.id } });
      await writeCartAudit(tx, audit, "CART_COUPON_APPLIED", cart.id, {
        couponId: coupon.id,
        code: coupon.code,
      });
      const snapshot = await this.revalidateLocked(tx, cart.id, now);
      if (snapshot.issues.some((issue) => issue.code === "COUPON_MINIMUM_NOT_MET")) {
        throw new CouponError(
          "MINIMUM_SUBTOTAL",
          "Cart does not reach the coupon minimum subtotal.",
        );
      }
      if (snapshot.issues.some((issue) => issue.code === "COUPON_INVALID")) {
        throw new CouponError("NO_ELIGIBLE_ITEMS", "Cart has no items eligible for this coupon.");
      }
      return snapshot;
    });
  }

  async removeCoupon(
    reference: CartReference,
    audit?: PricingMutationAudit,
  ): Promise<CartSnapshot> {
    return this.mutate(
      reference,
      audit,
      "CART_COUPON_REMOVED",
      async (tx, cart, now) => {
        await releaseCoupon(tx, cart.id, now);
        await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } });
      },
      false,
    );
  }

  async createAssistedCart(input: {
    accessTokenHash: Uint8Array;
    expiresAt: Date;
    assistedByAdminUserId: string;
    customerId?: string;
    audit: PricingMutationAudit;
  }): Promise<CartSnapshot> {
    const accessTokenHash = assertTokenHash(input.accessTokenHash, "accessTokenHash");
    const expiresAt = validateExpiration(input.expiresAt, "expiresAt");
    assertUuid(input.assistedByAdminUserId, "assistedByAdminUserId");
    if (input.customerId) assertUuid(input.customerId, "customerId");
    return inInventoryTransaction(this.db, async (tx) => {
      const now = await databaseNow(tx);
      if (expiresAt <= now)
        throw new CartValidationError("Assisted cart expiration must be in the future.");
      const admin = await tx.adminUser.findFirst({
        where: { id: input.assistedByAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });
      if (!admin) throw new CartValidationError("Assisted sale administrator is not active.");
      if (input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: input.customerId, deletedAt: null, status: { not: "ANONYMIZED" } },
          select: { id: true },
        });
        if (!customer) throw new CartValidationError("Customer is not available.");
      }
      const cart = await tx.cart.create({
        data: {
          accessTokenHash,
          kind: "ASSISTED",
          assistedByAdminUserId: input.assistedByAdminUserId,
          assistedExpiresAt: expiresAt,
          expiresAt,
          customerId: input.customerId ?? null,
          priceRevalidatedAt: now,
        },
      });
      await writeCartAudit(tx, input.audit, "ASSISTED_CART_CREATED", cart.id, {
        customerId: input.customerId ?? null,
        expiresAt: expiresAt.toISOString(),
      });
      return this.revalidateLocked(tx, cart.id, now);
    });
  }

  async listAssisted(
    options: {
      page?: number;
      pageSize?: number;
      status?: "ACTIVE" | "CONVERTED" | "CANCELLED" | "EXPIRED";
    } = {},
  ) {
    const requestedPage = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    if (
      !Number.isInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 10_000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new CartValidationError("Invalid assisted cart pagination.");
    }
    if (
      options.status &&
      !["ACTIVE", "CONVERTED", "CANCELLED", "EXPIRED"].includes(options.status)
    ) {
      throw new CartValidationError("Invalid assisted cart status.");
    }
    const where: Prisma.CartWhereInput = {
      kind: "ASSISTED",
      ...(options.status ? { status: options.status } : {}),
    };
    const total = await this.db.cart.count({ where });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const items = await this.db.cart.findMany({
      where,
      include: {
        customer: { select: { email: true, givenName: true, familyName: true } },
        assistedBy: { select: { displayName: true, email: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async issueAssistedToken(input: {
    cartId: string;
    assistedTokenHash: Uint8Array;
    expiresAt: Date;
    audit: PricingMutationAudit;
  }): Promise<CartSnapshot> {
    assertUuid(input.cartId, "cartId");
    const assistedTokenHash = assertTokenHash(input.assistedTokenHash, "assistedTokenHash");
    const expiresAt = validateExpiration(input.expiresAt, "expiresAt");
    return inInventoryTransaction(this.db, async (tx) => {
      const { cart, now } = await lockCart(tx, { cartId: input.cartId });
      assertActiveCart(cart, now);
      if (cart.kind !== "ASSISTED" || cart.assistedClaimedAt)
        throw new CartStateError("Assisted cart cannot receive a payment link.");
      if (expiresAt <= now)
        throw new CartValidationError("Payment link expiration must be in the future.");
      const snapshot = await this.revalidateLocked(tx, cart.id, now);
      if (!snapshot.canContinue)
        throw new CartStateError("Resolve cart pricing and stock issues before issuing its link.");
      await tx.cart.update({
        where: { id: cart.id },
        data: { assistedTokenHash, assistedExpiresAt: expiresAt, expiresAt },
      });
      await writeCartAudit(tx, input.audit, "ASSISTED_PAYMENT_LINK_ISSUED", cart.id, {
        expiresAt: expiresAt.toISOString(),
        rotated: cart.assistedTokenHash !== null,
      });
      return storedSnapshot(tx, cart.id);
    });
  }

  async getByAssistedToken(assistedTokenHash: Uint8Array): Promise<CartSnapshot | null> {
    const hash = assertTokenHash(assistedTokenHash, "assistedTokenHash");
    return inInventoryTransaction(this.db, async (tx) => {
      const rows = await tx.$queryRaw<
        Cart[]
      >`SELECT * FROM "Cart" WHERE "assistedTokenHash" = ${hash} FOR UPDATE`;
      if (!rows[0]) return null;
      const cart = await loadCart(tx, rows[0].id);
      const now = await databaseNow(tx);
      if (
        cart.status !== "ACTIVE" ||
        cart.kind !== "ASSISTED" ||
        cart.assistedClaimedAt ||
        !cart.assistedExpiresAt ||
        cart.assistedExpiresAt <= now ||
        cart.expiresAt <= now
      )
        return null;
      return this.revalidateLocked(tx, cart.id, now);
    });
  }

  async claimAssistedCart(input: {
    assistedTokenHash: Uint8Array;
    accessTokenHash: Uint8Array;
    expiresAt: Date;
  }): Promise<CartSnapshot> {
    const assistedTokenHash = assertTokenHash(input.assistedTokenHash, "assistedTokenHash");
    const accessTokenHash = assertTokenHash(input.accessTokenHash, "accessTokenHash");
    const expiresAt = validateExpiration(input.expiresAt, "expiresAt");
    return inInventoryTransaction(this.db, async (tx) => {
      const rows = await tx.$queryRaw<
        Cart[]
      >`SELECT * FROM "Cart" WHERE "assistedTokenHash" = ${assistedTokenHash} FOR UPDATE`;
      if (!rows[0]) throw new CartNotFoundError("Assisted payment link not found.");
      const cart = await loadCart(tx, rows[0].id);
      const now = await databaseNow(tx);
      if (
        cart.status !== "ACTIVE" ||
        cart.kind !== "ASSISTED" ||
        cart.assistedClaimedAt ||
        !cart.assistedExpiresAt ||
        cart.assistedExpiresAt <= now ||
        expiresAt <= now
      )
        throw new CartStateError("Assisted payment link is unavailable or expired.");
      const snapshot = await this.revalidateLocked(tx, cart.id, now);
      if (!snapshot.canContinue)
        throw new CartStateError("Resolve cart issues before accepting the assisted sale.");
      await tx.cart.update({
        where: { id: cart.id },
        data: { assistedTokenHash: null, assistedClaimedAt: now, accessTokenHash, expiresAt },
      });
      return storedSnapshot(tx, cart.id);
    });
  }

  async cancelAssistedCart(cartId: string, audit: PricingMutationAudit): Promise<CartSnapshot> {
    assertUuid(cartId, "cartId");
    return inInventoryTransaction(this.db, async (tx) => {
      const { cart, now } = await lockCart(tx, { cartId });
      if (cart.kind !== "ASSISTED" || cart.status !== "ACTIVE" || cart.assistedClaimedAt) {
        throw new CartStateError("Only unclaimed active assisted carts can be cancelled.");
      }
      await releaseCoupon(tx, cart.id, now);
      await tx.cart.update({
        where: { id: cart.id },
        data: { status: "CANCELLED", couponId: null, assistedTokenHash: null },
      });
      await writeCartAudit(tx, audit, "ASSISTED_CART_CANCELLED", cart.id);
      return storedSnapshot(tx, cart.id);
    });
  }
}
