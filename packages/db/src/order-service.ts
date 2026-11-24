import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  assertCartQuantity,
  assertDeliveryPoint,
  assertMoney,
  assertReceiptBalanced,
  availableStock,
  calculateOrderTaxes,
  normalizeEmail,
  roundDivHalfUp,
  type CalculatedOrderTaxLine,
  type DeliveryPoint,
  type StoreTaxRegimeValue,
} from "@mundonettech/core";

import { CartService, CartNotFoundError } from "./cart-service.js";
import { assertProposalIntegrity } from "./b2b-shared.js";
import { CrmService } from "./crm-service.js";
import { LocalDeliveryConflictError, quoteLocalDeliveryZone } from "./local-delivery-service.js";
import type { CartReference, CartSnapshot } from "./cart-types.js";
import type {
  Cart,
  Order,
  OrderItem,
  OrderItemTaxLine,
  OrderReceipt,
  PrismaClient,
  StockLevel,
  StoreSettings,
} from "./generated/client.js";
import { IdempotencyStatus, Prisma } from "./generated/client.js";
import {
  acquireOperationLocks,
  assertUuid,
  compareStrings,
  hasUniqueViolation,
  inInventoryTransaction,
  type StockMovementInput,
} from "./inventory-shared.js";
import { acquireIdempotencyKey, completeIdempotencyKey, databaseNow } from "./primitives.js";
import { reserveStock } from "./stock.js";
import { recordDailyFunnelCounters } from "./funnel-service.js";
import type {
  CheckoutConversionInput,
  CheckoutDefaults,
  CheckoutPreview,
  CheckoutResult,
  LocalDeliveryQuoteSnapshot,
  OrderReceiptSnapshot,
} from "./order-types.js";

const checkoutScope = "checkout";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OrderValidationError extends Error {
  override readonly name = "OrderValidationError" as const;

  constructor(message: string) {
    super(message);
  }
}

export class CheckoutConflictError extends Error {
  override readonly name = "CheckoutConflictError" as const;

  constructor(message: string) {
    super(message);
  }
}

export class CheckoutAuthenticationRequiredError extends Error {
  override readonly name = "CheckoutAuthenticationRequiredError" as const;

  constructor() {
    super("The email belongs to a registered customer; sign in before checkout.");
  }
}

export class CheckoutStockError extends Error {
  override readonly name = "CheckoutStockError" as const;

  constructor(
    readonly variantId: string,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Insufficient stock for variant ${variantId}: ${available} available, ${requested} requested.`,
    );
  }
}

export class CheckoutCouponError extends Error {
  override readonly name = "CheckoutCouponError" as const;

  constructor(message: string) {
    super(message);
  }
}

export class CheckoutReviewRequiredError extends Error {
  override readonly name = "CheckoutReviewRequiredError" as const;

  constructor() {
    super("Pricing, taxes, or delivery terms changed; review the checkout again.");
  }
}

export class ReceiptBalanceError extends Error {
  override readonly name = "ReceiptBalanceError" as const;

  constructor(
    message = "Receipt verification failed because its totals do not balance.",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface RuntimeSettings extends CheckoutDefaults {
  readonly localDeliveryEnabled?: boolean;
}

interface StockAllocation {
  readonly locationId: string;
  readonly quantity: number;
  readonly unitCostWacCents: bigint;
}

type OrderItemWithTaxes = OrderItem & { taxLines: OrderItemTaxLine[] };
type ReceiptWithOrder = OrderReceipt & {
  order: Order & {
    clickCollectLocation: { name: string } | null;
    items: OrderItemWithTaxes[];
  };
};

function hash32(value: Uint8Array, field: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new OrderValidationError(`${field} must contain 32 bytes.`);
  }
  return Uint8Array.from(value);
}

function optionalHash(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  return value === undefined || value === null ? null : hash32(value, field);
}

function text(value: string, field: string, minimumLength: number, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OrderValidationError(
      `${field} must be trimmed, printable and contain ${minimumLength} to ${maximumLength} characters.`,
    );
  }
  return value;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field, 1, maximumLength);
}

function email(value: string): string {
  try {
    return normalizeEmail(value);
  } catch {
    throw new OrderValidationError("email must be a valid normalized email address.");
  }
}

function phone(value: string): string {
  if (typeof value !== "string") throw new OrderValidationError("phoneE164 is required.");
  const compact = value.replace(/[\s()-]/g, "");
  const colombian = /^(?:\+57)?([36][0-9]{9})$/.exec(compact);
  const normalized = colombian?.[1] ? `+57${colombian[1]}` : compact;
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new OrderValidationError(
      "phoneE164 must be a valid Colombian or international E.164 phone.",
    );
  }
  return normalized;
}

function daneCode(value: string, length: 2 | 5, field: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9]{${length}}$`).test(value)) {
    throw new OrderValidationError(`${field} must contain exactly ${length} digits.`);
  }
  return value;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new OrderValidationError(`${field} must be a valid date.`);
  }
  return value;
}

function settingsFromRecord(settings: StoreSettings): RuntimeSettings {
  return {
    taxRegime: settings.taxRegime,
    currency: "COP",
    timeZone: settings.timeZone,
    orderNumberPrefix: settings.orderNumberPrefix,
    orderNumberPadding: settings.orderNumberPadding,
    uvtValueCents: settings.uvtValueCents,
    uvtYear: settings.uvtYear,
    standardShippingCents: settings.standardShippingCents,
    deliveryPromiseDays: settings.deliveryPromiseDays,
    reservationMinutes: settings.reservationMinutes,
    clickAndCollectEnabled: settings.clickAndCollectEnabled,
    localDeliveryEnabled: settings.localDeliveryEnabled,
  };
}

function validateSettings(settings: CheckoutDefaults): RuntimeSettings {
  if (!["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(settings.taxRegime)) {
    throw new OrderValidationError("Invalid tax regime.");
  }
  if (settings.currency !== "COP") throw new OrderValidationError("Checkout currency must be COP.");
  text(settings.timeZone, "timeZone", 1, 64);
  try {
    new Intl.DateTimeFormat("es-CO", { timeZone: settings.timeZone }).format(0);
  } catch {
    throw new OrderValidationError("Invalid IANA time zone.");
  }
  if (!/^[A-Z][A-Z0-9-]{0,11}$/.test(settings.orderNumberPrefix)) {
    throw new OrderValidationError("Invalid order number prefix.");
  }
  if (
    !Number.isInteger(settings.orderNumberPadding) ||
    settings.orderNumberPadding < 1 ||
    settings.orderNumberPadding > 12
  ) {
    throw new OrderValidationError("Order number padding must be between 1 and 12.");
  }
  assertMoney(settings.uvtValueCents, "uvtValueCents", true);
  assertMoney(settings.standardShippingCents, "standardShippingCents");
  if (!Number.isInteger(settings.uvtYear) || settings.uvtYear < 2000 || settings.uvtYear > 9999) {
    throw new OrderValidationError("Invalid UVT year.");
  }
  if (
    !Number.isInteger(settings.deliveryPromiseDays) ||
    settings.deliveryPromiseDays < 1 ||
    settings.deliveryPromiseDays > 365
  ) {
    throw new OrderValidationError("Delivery promise must be between 1 and 365 days.");
  }
  if (
    !Number.isInteger(settings.reservationMinutes) ||
    settings.reservationMinutes < 5 ||
    settings.reservationMinutes > 10_080
  ) {
    throw new OrderValidationError("Reservation minutes must be between 5 and 10080.");
  }
  if (typeof settings.clickAndCollectEnabled !== "boolean") {
    throw new OrderValidationError("Click & Collect setting must be boolean.");
  }
  return settings;
}

async function lockedSettings(
  tx: Prisma.TransactionClient,
  defaults: CheckoutDefaults,
): Promise<RuntimeSettings> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store-settings-default'))`;
  const stored = await tx.storeSettings.findUnique({ where: { key: "default" } });
  return validateSettings(stored ? settingsFromRecord(stored) : defaults);
}

async function b2bProposalForCart(tx: Prisma.TransactionClient, cartId: string) {
  const proposal = await tx.opportunityProposal.findUnique({
    where: { cartId },
    include: { opportunity: true, items: true },
  });
  if (!proposal) throw new CheckoutConflictError("The B2B cart has no source proposal.");
  assertProposalIntegrity(proposal);
  return proposal;
}

async function settingsForCart(
  tx: Prisma.TransactionClient,
  defaults: CheckoutDefaults,
  cart: CartSnapshot,
): Promise<RuntimeSettings> {
  const settings = await lockedSettings(tx, defaults);
  if (cart.kind !== "B2B") return settings;
  const proposal = await b2bProposalForCart(tx, cart.id);
  return validateSettings({
    ...settings,
    taxRegime: proposal.taxRegime,
    uvtValueCents: proposal.uvtValueCents,
    uvtYear: proposal.uvtYear,
    standardShippingCents: proposal.shippingCents,
    deliveryPromiseDays: proposal.deliveryPromiseDays,
    reservationMinutes: proposal.reservationMinutes,
    clickAndCollectEnabled: false,
  });
}

function fingerprint(input: {
  readonly cart: CartSnapshot;
  readonly taxes: readonly CalculatedOrderTaxLine[];
  readonly fulfillmentMethod: "HOME_DELIVERY" | "CLICK_COLLECT" | "LOCAL_DELIVERY";
  readonly clickCollectLocationId: string | null;
  readonly localDeliveryZoneId?: string;
  readonly zoneUpdatedAt?: Date;
  readonly deliveryPoint?: DeliveryPoint;
  readonly deliveryPromiseAt?: Date;
  readonly shippingCents: bigint;
  readonly taxRegime: StoreTaxRegimeValue;
  readonly uvtValueCents: bigint;
  readonly uvtYear: number;
}): string {
  const canonical = {
    cart: {
      id: input.cart.id,
      couponId: input.cart.coupon?.id ?? null,
      items: input.cart.items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        wholesaleDiscountCents: item.wholesaleDiscountCents,
        bundleDiscountCents: item.bundleDiscountCents,
        couponDiscountCents: item.couponDiscountCents,
        lineTotalCents: item.lineTotalCents,
      })),
    },
    taxes: input.taxes.map((line) => ({
      lineId: line.lineId,
      rule: line.rule,
      appliedRateBps: line.appliedRateBps,
      taxableBaseCents: line.taxableBaseCents.toString(),
      taxCents: line.taxCents.toString(),
    })),
    fulfillmentMethod: input.fulfillmentMethod,
    clickCollectLocationId: input.clickCollectLocationId,
    ...(input.fulfillmentMethod === "LOCAL_DELIVERY"
      ? {
          localDeliveryZoneId: input.localDeliveryZoneId,
          zoneUpdatedAt: input.zoneUpdatedAt?.toISOString(),
          deliveryPoint: input.deliveryPoint,
        }
      : {}),
    shippingCents: input.shippingCents.toString(),
    taxRegime: input.taxRegime,
    uvtValueCents: input.uvtValueCents.toString(),
    uvtYear: input.uvtYear,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function taxesForCart(
  tx: Prisma.TransactionClient,
  cart: CartSnapshot,
  settings: RuntimeSettings,
): Promise<CalculatedOrderTaxLine[]> {
  if (cart.kind === "B2B") {
    const proposal = await b2bProposalForCart(tx, cart.id);
    return cart.items.map((item) => {
      const snapshot = proposal.items.find((candidate) => candidate.variantId === item.variantId);
      if (!snapshot || snapshot.lineTotalCents !== BigInt(item.lineTotalCents)) {
        throw new CheckoutConflictError("A B2B tax snapshot is missing or inconsistent.");
      }
      return {
        lineId: item.id,
        taxGroupCode: snapshot.taxGroupCode,
        taxGroupName: snapshot.taxGroupName,
        treatment: snapshot.treatment,
        rule: snapshot.taxRule,
        catalogRateBps: snapshot.catalogRateBps,
        appliedRateBps: snapshot.appliedRateBps,
        uvtLimit: snapshot.uvtLimit,
        uvtValueCents: proposal.uvtValueCents,
        uvtYear: proposal.uvtYear,
        unitValueCents: snapshot.unitValueCents,
        taxableBaseCents: snapshot.taxableBaseCents,
        taxCents: snapshot.taxCents,
      };
    });
  }
  const records = await tx.cartItem.findMany({
    where: { cartId: cart.id },
    select: {
      id: true,
      variant: {
        select: {
          product: {
            select: {
              taxGroup: {
                select: {
                  code: true,
                  name: true,
                  treatment: true,
                  rateBps: true,
                  uvtLimit: true,
                  aboveUvtRateBps: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const groups = new Map(records.map((record) => [record.id, record.variant.product.taxGroup]));
  return calculateOrderTaxes(
    cart.items.map((item) => {
      const group = groups.get(item.id);
      if (!group) throw new CheckoutConflictError("A cart item disappeared during checkout.");
      return {
        lineId: item.id,
        quantity: item.quantity,
        netCents: BigInt(item.lineTotalCents),
        taxGroupCode: group.code,
        taxGroupName: group.name,
        treatment: group.treatment,
        catalogRateBps: group.rateBps,
        uvtLimit: group.uvtLimit,
        aboveUvtRateBps: group.aboveUvtRateBps,
      };
    }),
    {
      regime: settings.taxRegime,
      uvtValueCents: settings.uvtValueCents,
      uvtYear: settings.uvtYear,
    },
  ).lines;
}

function totalTax(lines: readonly CalculatedOrderTaxLine[]): bigint {
  return lines.reduce((total, line) => total + line.taxCents, 0n);
}

function referenceHash(reference: CartReference): Uint8Array<ArrayBuffer> | null {
  return "accessTokenHash" in reference
    ? hash32(reference.accessTokenHash, "accessTokenHash")
    : null;
}

function receiptHash(
  order: Order,
  receipt: { readonly receiptNumber: string; readonly issuedAt: Date },
  items: readonly OrderItemWithTaxes[],
): Uint8Array<ArrayBuffer> {
  const content = {
    orderNumber: order.orderNumber,
    receiptNumber: receipt.receiptNumber,
    issuedAt: receipt.issuedAt.toISOString(),
    taxRegime: order.taxRegime,
    currency: order.currency,
    fulfillmentMethod: order.fulfillmentMethod,
    emailSnapshot: order.emailSnapshot,
    recipientNameSnapshot: order.recipientNameSnapshot,
    phoneE164Snapshot: order.phoneE164Snapshot,
    countryCode: order.countryCode,
    departmentCode: order.departmentCode,
    departmentNameSnapshot: order.departmentNameSnapshot,
    municipalityCode: order.municipalityCode,
    municipalityNameSnapshot: order.municipalityNameSnapshot,
    addressLine1Snapshot: order.addressLine1Snapshot,
    addressLine2Snapshot: order.addressLine2Snapshot,
    neighborhoodSnapshot: order.neighborhoodSnapshot,
    postalCodeSnapshot: order.postalCodeSnapshot,
    deliveryNotesSnapshot: order.deliveryNotesSnapshot,
    clickCollectLocationId: order.clickCollectLocationId,
    subtotalCents: order.subtotalCents.toString(),
    wholesaleDiscountCents: order.wholesaleDiscountCents.toString(),
    bundleDiscountCents: order.bundleDiscountCents.toString(),
    couponDiscountCents: order.couponDiscountCents.toString(),
    discountCents: order.discountCents.toString(),
    taxCents: order.taxCents.toString(),
    shippingCents: order.shippingCents.toString(),
    totalCents: order.totalCents.toString(),
    deliveryPromiseAt: order.deliveryPromiseAt?.toISOString() ?? null,
    items: items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      bundleId: item.bundleId,
      quantity: item.quantity,
      titleSnapshot: item.titleSnapshot,
      productSlugSnapshot: item.productSlugSnapshot,
      skuSnapshot: item.skuSnapshot,
      unitPriceCents: item.unitPriceCents.toString(),
      unitCostWacCents: item.unitCostWacCents.toString(),
      wholesaleDiscountCents: item.wholesaleDiscountCents.toString(),
      bundleDiscountCents: item.bundleDiscountCents.toString(),
      couponDiscountCents: item.couponDiscountCents.toString(),
      discountCents: item.discountCents.toString(),
      lineTotalCents: item.lineTotalCents.toString(),
      taxCents: item.taxCents.toString(),
      taxLines: item.taxLines.map((line) => ({
        taxGroupCode: line.taxGroupCode,
        taxGroupName: line.taxGroupName,
        treatment: line.treatment,
        rule: line.rule,
        catalogRateBps: line.catalogRateBps,
        appliedRateBps: line.appliedRateBps,
        uvtLimit: line.uvtLimit,
        uvtValueCents: line.uvtValueCents.toString(),
        uvtYear: line.uvtYear,
        unitValueCents: line.unitValueCents.toString(),
        taxableBaseCents: line.taxableBaseCents.toString(),
        taxCents: line.taxCents.toString(),
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest();
}

function requiredSnapshot(value: string | null, field: string): string {
  if (value === null) throw new ReceiptBalanceError(`Receipt is missing ${field}.`);
  return value;
}

function receiptSnapshot(record: ReceiptWithOrder): OrderReceiptSnapshot {
  const { order } = record;
  if (
    order.fulfillmentMethod === null ||
    order.taxRegime === null ||
    record.taxRegime !== order.taxRegime ||
    order.currency !== "COP"
  ) {
    throw new ReceiptBalanceError("Receipt fiscal snapshots are incomplete.");
  }
  return {
    id: record.id,
    orderId: order.id,
    orderNumber: order.orderNumber,
    receiptNumber: record.receiptNumber,
    issuedAt: record.issuedAt.toISOString(),
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentMethod: order.fulfillmentMethod,
    taxRegime: order.taxRegime,
    currency: "COP",
    emailSnapshot: requiredSnapshot(order.emailSnapshot, "emailSnapshot"),
    recipientNameSnapshot: requiredSnapshot(order.recipientNameSnapshot, "recipientNameSnapshot"),
    phoneE164Snapshot: requiredSnapshot(order.phoneE164Snapshot, "phoneE164Snapshot"),
    departmentNameSnapshot: requiredSnapshot(
      order.departmentNameSnapshot,
      "departmentNameSnapshot",
    ),
    municipalityNameSnapshot: requiredSnapshot(
      order.municipalityNameSnapshot,
      "municipalityNameSnapshot",
    ),
    addressLine1Snapshot: requiredSnapshot(order.addressLine1Snapshot, "addressLine1Snapshot"),
    addressLine2Snapshot: order.addressLine2Snapshot,
    neighborhoodSnapshot: order.neighborhoodSnapshot,
    postalCodeSnapshot: order.postalCodeSnapshot,
    deliveryNotesSnapshot: order.deliveryNotesSnapshot,
    pickupLocationName: order.clickCollectLocation?.name ?? null,
    couponCodeSnapshot: order.couponCodeSnapshot,
    subtotalCents: record.subtotalCents.toString(),
    wholesaleDiscountCents: order.wholesaleDiscountCents.toString(),
    bundleDiscountCents: order.bundleDiscountCents.toString(),
    couponDiscountCents: order.couponDiscountCents.toString(),
    discountCents: record.discountCents.toString(),
    taxCents: record.taxCents.toString(),
    shippingCents: record.shippingCents.toString(),
    totalCents: record.totalCents.toString(),
    deliveryPromiseAt: requiredSnapshot(
      order.deliveryPromiseAt?.toISOString() ?? null,
      "deliveryPromiseAt",
    ),
    items: order.items.map((item) => ({
      id: item.id,
      skuSnapshot: item.skuSnapshot,
      titleSnapshot: item.titleSnapshot,
      productSlugSnapshot: item.productSlugSnapshot,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents.toString(),
      discountCents: item.discountCents.toString(),
      lineTotalCents: item.lineTotalCents.toString(),
      taxCents: item.taxCents.toString(),
      totalCents: (item.lineTotalCents + item.taxCents).toString(),
      taxLines: item.taxLines.map((line) => ({
        id: line.id,
        taxGroupCode: line.taxGroupCode,
        taxGroupName: line.taxGroupName,
        treatment: line.treatment,
        rule: line.rule,
        catalogRateBps: line.catalogRateBps,
        appliedRateBps: line.appliedRateBps,
        uvtLimit: line.uvtLimit,
        uvtValueCents: line.uvtValueCents.toString(),
        uvtYear: line.uvtYear,
        unitValueCents: line.unitValueCents.toString(),
        taxableBaseCents: line.taxableBaseCents.toString(),
        taxCents: line.taxCents.toString(),
      })),
    })),
  };
}

export class OrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly defaults: CheckoutDefaults,
  ) {
    validateSettings(defaults);
  }

  async preview(reference: CartReference): Promise<CheckoutPreview | null> {
    referenceHash(reference);
    if ("cartId" in reference) assertUuid(reference.cartId, "cartId");
    return inInventoryTransaction(this.db, async (tx) => {
      const carts = new CartService(tx);
      const cart =
        "accessTokenHash" in reference
          ? await carts.getByAccessToken(reference.accessTokenHash)
          : await carts.getById(reference.cartId);
      if (!cart || cart.status !== "ACTIVE") return null;
      const settings = await settingsForCart(tx, this.defaults, cart);
      const taxes = await taxesForCart(tx, cart, settings);
      const merchandiseTotalCents = BigInt(cart.totalCents) + totalTax(taxes);
      const homeFingerprint = fingerprint({
        cart,
        taxes,
        fulfillmentMethod: "HOME_DELIVERY",
        clickCollectLocationId: null,
        shippingCents: settings.standardShippingCents,
        taxRegime: settings.taxRegime,
        uvtValueCents: settings.uvtValueCents,
        uvtYear: settings.uvtYear,
      });
      const requested = new Map<string, number>();
      for (const item of cart.items) {
        requested.set(item.variantId, (requested.get(item.variantId) ?? 0) + item.quantity);
      }
      const locations = settings.clickAndCollectEnabled
        ? await tx.stockLocation.findMany({
            where: {
              type: "CLICK_COLLECT",
              deletedAt: null,
              addressLine1: { not: null },
              municipalityCode: { not: null },
            },
            include: {
              municipality: { include: { department: true } },
              stockLevels: { where: { variantId: { in: [...requested.keys()] } } },
            },
            orderBy: [{ code: "asc" }, { id: "asc" }],
          })
        : [];
      const pickupLocations = locations.map((location) => {
        const available = [...requested].every(([variantId, quantity]) => {
          const stock = location.stockLevels
            .filter((level) => level.variantId === variantId)
            .reduce((sum, level) => sum + availableStock(level), 0);
          return stock >= quantity;
        });
        if (
          !location.addressLine1 ||
          !location.departmentCode ||
          !location.municipalityCode ||
          !location.municipality ||
          location.municipality.departmentCode !== location.departmentCode
        ) {
          throw new OrderValidationError(
            `Pickup location ${location.code} has inconsistent DANE data.`,
          );
        }
        return {
          id: location.id,
          code: location.code,
          name: location.name,
          addressLine1: location.addressLine1,
          departmentCode: location.departmentCode,
          departmentName: location.municipality.department.name,
          municipalityCode: location.municipalityCode,
          municipalityName: location.municipality.name,
          phoneE164: location.phoneE164,
          instructions: location.pickupInstructions,
          available,
          reviewFingerprint: fingerprint({
            cart,
            taxes,
            fulfillmentMethod: "CLICK_COLLECT",
            clickCollectLocationId: location.id,
            shippingCents: 0n,
            taxRegime: settings.taxRegime,
            uvtValueCents: settings.uvtValueCents,
            uvtYear: settings.uvtYear,
          }),
        };
      });
      const [departments, municipalities, customer] = await Promise.all([
        tx.daneDepartment.findMany({ orderBy: [{ name: "asc" }, { code: "asc" }] }),
        tx.daneMunicipality.findMany({ orderBy: [{ name: "asc" }, { code: "asc" }] }),
        cart.customerId
          ? tx.customer.findFirst({
              where: {
                id: cart.customerId,
                deletedAt: null,
                status: { not: "ANONYMIZED" },
              },
              select: {
                id: true,
                email: true,
                givenName: true,
                familyName: true,
                phoneE164: true,
                status: true,
              },
            })
          : null,
      ]);
      return {
        cart,
        customer: customer
          ? {
              id: customer.id,
              email: customer.email,
              givenName: customer.givenName,
              familyName: customer.familyName,
              phoneE164: customer.phoneE164,
              authenticated: customer.status === "ACTIVE",
            }
          : null,
        taxRegime: settings.taxRegime,
        uvtValueCents: settings.uvtValueCents.toString(),
        uvtYear: settings.uvtYear,
        deliveryPromiseDays: settings.deliveryPromiseDays,
        reservationMinutes: settings.reservationMinutes,
        taxLines: taxes.map((line) => ({
          ...line,
          uvtValueCents: line.uvtValueCents.toString(),
          unitValueCents: line.unitValueCents.toString(),
          taxableBaseCents: line.taxableBaseCents.toString(),
          taxCents: line.taxCents.toString(),
        })),
        merchandiseTotalCents: merchandiseTotalCents.toString(),
        homeDelivery: {
          shippingCents: settings.standardShippingCents.toString(),
          totalCents: (merchandiseTotalCents + settings.standardShippingCents).toString(),
          reviewFingerprint: homeFingerprint,
        },
        clickAndCollectEnabled: settings.clickAndCollectEnabled,
        localDeliveryEnabled: settings.localDeliveryEnabled === true,
        pickupLocations,
        departments: departments.map((department) => ({
          code: department.code,
          name: department.name,
        })),
        municipalities: municipalities.map((municipality) => ({
          code: municipality.code,
          departmentCode: municipality.departmentCode,
          name: municipality.name,
          locationType: municipality.locationType,
        })),
      };
    });
  }

  async localDeliveryQuotes(
    reference: CartReference,
    input: { municipalityCode: string; point: DeliveryPoint },
  ): Promise<readonly LocalDeliveryQuoteSnapshot[]> {
    referenceHash(reference);
    if ("cartId" in reference) assertUuid(reference.cartId, "cartId");
    const municipalityCode = daneCode(input.municipalityCode, 5, "municipalityCode");
    const point = assertDeliveryPoint(input.point);
    return inInventoryTransaction(this.db, async (tx) => {
      const carts = new CartService(tx);
      const cart =
        "accessTokenHash" in reference
          ? await carts.getByAccessToken(reference.accessTokenHash)
          : await carts.getById(reference.cartId);
      if (!cart || cart.status !== "ACTIVE") return [];
      const settings = await settingsForCart(tx, this.defaults, cart);
      if (!settings.localDeliveryEnabled) return [];
      const municipality = await tx.daneMunicipality.findUnique({
        where: { code: municipalityCode },
      });
      if (!municipality)
        throw new OrderValidationError("A valid DANE municipality is required for Flex quotes.");
      const taxes = await taxesForCart(tx, cart, settings);
      const merchandiseTotalCents = BigInt(cart.totalCents) + totalTax(taxes);
      const zones = await tx.localDeliveryZone.findMany({
        where: { active: true, deletedAt: null },
        orderBy: [{ code: "asc" }, { id: "asc" }],
        take: 1000,
      });
      const now = await databaseNow(tx);
      const quotes: LocalDeliveryQuoteSnapshot[] = [];
      for (const zone of zones) {
        try {
          const quote = quoteLocalDeliveryZone(zone, {
            municipalityCode,
            point,
            merchandiseTotalCents,
            now,
            timeZone: settings.timeZone,
          });
          quotes.push({
            zoneId: zone.id,
            zoneCode: zone.code,
            shippingCents: quote.shippingCents.toString(),
            totalCents: (merchandiseTotalCents + quote.shippingCents).toString(),
            deliveryPromiseAt: quote.deliveryPromiseAt.toISOString(),
            reviewFingerprint: fingerprint({
              cart,
              taxes,
              fulfillmentMethod: "LOCAL_DELIVERY",
              clickCollectLocationId: null,
              localDeliveryZoneId: zone.id,
              zoneUpdatedAt: zone.updatedAt,
              deliveryPoint: point,
              deliveryPromiseAt: quote.deliveryPromiseAt,
              shippingCents: quote.shippingCents,
              taxRegime: settings.taxRegime,
              uvtValueCents: settings.uvtValueCents,
              uvtYear: settings.uvtYear,
            }),
          });
        } catch (error) {
          if (!(error instanceof LocalDeliveryConflictError)) throw error;
        }
      }
      return quotes.sort((left, right) => {
        const cost =
          left.shippingCents < right.shippingCents
            ? -1
            : left.shippingCents > right.shippingCents
              ? 1
              : 0;
        return cost || compareStrings(left.zoneCode, right.zoneCode);
      });
    });
  }

  async checkout(input: CheckoutConversionInput): Promise<CheckoutResult> {
    const contact = {
      email: email(input.contact.email),
      givenName: text(input.contact.givenName, "givenName", 2, 100),
      familyName: text(input.contact.familyName, "familyName", 2, 100),
      recipientName: text(input.contact.recipientName, "recipientName", 2, 200),
      phoneE164: phone(input.contact.phoneE164),
      buyerDocumentType: optionalText(input.contact.buyerDocumentType, "buyerDocumentType", 2),
      buyerDocumentNumber:
        optionalText(input.contact.buyerDocumentNumber, "buyerDocumentNumber", 30)?.toUpperCase() ??
        null,
      buyerTaxRegime: input.contact.buyerTaxRegime ?? null,
      termsVersion: text(input.contact.termsVersion, "termsVersion", 1, 50),
      privacyPolicyVersion: text(input.contact.privacyPolicyVersion, "privacyPolicyVersion", 1, 50),
      advertisingAccepted: input.contact.advertisingAccepted === true,
      acceptanceProofHash: hash32(input.contact.acceptanceProofHash, "acceptanceProofHash"),
      acceptanceIpHash: optionalHash(input.contact.acceptanceIpHash, "acceptanceIpHash"),
      acceptanceUserAgentHash: optionalHash(
        input.contact.acceptanceUserAgentHash,
        "acceptanceUserAgentHash",
      ),
    };
    const b2bAcceptance = input.b2bAcceptance
      ? {
          proposalId: assertUuid(input.b2bAcceptance.proposalId, "proposalId"),
          signerName: text(input.b2bAcceptance.signerName, "signerName", 2, 200),
          signerDocumentType: text(
            input.b2bAcceptance.signerDocumentType,
            "signerDocumentType",
            2,
            2,
          ),
          signerDocumentNumber: text(
            input.b2bAcceptance.signerDocumentNumber,
            "signerDocumentNumber",
            3,
            30,
          ).toUpperCase(),
        }
      : null;
    if (
      b2bAcceptance &&
      (!["11", "12", "13", "21", "22", "31", "41", "42", "50", "91"].includes(
        b2bAcceptance.signerDocumentType,
      ) ||
        !/^[A-Z0-9.-]{3,30}$/.test(b2bAcceptance.signerDocumentNumber))
    ) {
      throw new OrderValidationError("The B2B signer document is invalid.");
    }
    const idempotency = {
      keyHash: hash32(input.idempotency.keyHash, "keyHash"),
      subjectHash: hash32(input.idempotency.subjectHash, "subjectHash"),
      requestHash: hash32(input.idempotency.requestHash, "requestHash"),
      expiresAt: validDate(input.idempotency.expiresAt, "idempotency.expiresAt"),
    };
    const receiptAccessTokenHash = hash32(input.receiptAccessTokenHash, "receiptAccessTokenHash");
    const receiptDeliveryReference = input.receiptDeliveryReference;
    if (receiptDeliveryReference !== undefined)
      assertUuid(receiptDeliveryReference, "receiptDeliveryReference");
    if (!/^[0-9a-f]{64}$/.test(input.expectedReviewFingerprint)) {
      throw new OrderValidationError("expectedReviewFingerprint must be a SHA-256 hex value.");
    }
    referenceHash(input.cart);
    if ("cartId" in input.cart) assertUuid(input.cart.cartId, "cartId");
    const deliveryNotes = optionalText(input.fulfillment.deliveryNotes, "deliveryNotes", 500);

    try {
      return await inInventoryTransaction(this.db, async (tx) => {
        const acquired = await acquireIdempotencyKey(tx, {
          scope: checkoutScope,
          ...idempotency,
        });
        if (!acquired.acquired) {
          if (
            acquired.status === IdempotencyStatus.SUCCEEDED &&
            acquired.resultType === "Order" &&
            acquired.resultId &&
            uuidPattern.test(acquired.resultId)
          ) {
            const order = await tx.order.findUnique({
              where: { id: acquired.resultId },
              include: { receipt: true },
            });
            if (
              !order?.receipt ||
              !timingSafeEqual(
                Uint8Array.from(order.receipt.accessTokenHash),
                receiptAccessTokenHash,
              )
            ) {
              throw new CheckoutConflictError("The completed checkout replay is inconsistent.");
            }
            return {
              orderId: order.id,
              orderNumber: order.orderNumber,
              receiptNumber: order.receipt.receiptNumber,
              totalCents: order.totalCents.toString(),
              paymentStatus: order.paymentStatus,
              replayed: true,
            };
          }
          throw new CheckoutConflictError("An equivalent checkout is already in progress.");
        }

        const reference = input.cart;
        const peek =
          "cartId" in reference
            ? await tx.cart.findUnique({
                where: { id: reference.cartId },
                select: {
                  couponId: true,
                  kind: true,
                  sourceProposal: { select: { opportunityId: true } },
                },
              })
            : await tx.cart.findUnique({
                where: { accessTokenHash: referenceHash(reference)! },
                select: {
                  couponId: true,
                  kind: true,
                  sourceProposal: { select: { opportunityId: true } },
                },
              });
        const initialLocks = [
          ...(peek?.couponId ? [`coupon-redemption:${peek.couponId}`] : []),
          ...(peek?.kind === "B2B" && peek.sourceProposal?.opportunityId
            ? [`b2b-opportunity:${peek.sourceProposal.opportunityId}`]
            : []),
        ];
        if (initialLocks.length > 0) await acquireOperationLocks(tx, initialLocks);
        const rows =
          "cartId" in reference
            ? await tx.$queryRaw<
                Cart[]
              >`SELECT * FROM "Cart" WHERE "id" = ${reference.cartId}::uuid FOR UPDATE`
            : await tx.$queryRaw<
                Cart[]
              >`SELECT * FROM "Cart" WHERE "accessTokenHash" = ${referenceHash(reference)!} FOR UPDATE`;
        const locked = rows[0];
        if (!locked) throw new CartNotFoundError();
        if (locked.couponId && locked.couponId !== peek?.couponId) {
          await acquireOperationLocks(tx, [`coupon-redemption:${locked.couponId}`]);
        }
        const now = await databaseNow(tx);
        if (locked.status !== "ACTIVE" || locked.expiresAt <= now) {
          throw new CheckoutConflictError("The cart is no longer active or has expired.");
        }
        const cart = await new CartService(tx).getById(locked.id);
        if (!cart.canContinue || cart.items.length === 0) {
          throw new CheckoutConflictError(
            "Resolve all cart product and stock issues before checkout.",
          );
        }
        if (
          cart.issues.some(
            (issue) => issue.code === "COUPON_INVALID" || issue.code === "COUPON_MINIMUM_NOT_MET",
          )
        ) {
          throw new CheckoutCouponError("The cart coupon is no longer eligible.");
        }
        const b2bProposal = cart.kind === "B2B" ? await b2bProposalForCart(tx, cart.id) : null;
        if (cart.kind === "B2B") {
          if (
            !b2bProposal ||
            !b2bAcceptance ||
            b2bAcceptance.proposalId !== b2bProposal.id ||
            input.fulfillment.method !== "HOME_DELIVERY"
          ) {
            throw new OrderValidationError(
              "B2B checkout requires its matching signature and home delivery terms.",
            );
          }
        } else if (b2bAcceptance) {
          throw new OrderValidationError("B2B acceptance is not valid for a storefront cart.");
        }
        const settings = await settingsForCart(tx, this.defaults, cart);
        const taxes = await taxesForCart(tx, cart, settings);
        const isPickup = input.fulfillment.method === "CLICK_COLLECT";
        const isLocal = input.fulfillment.method === "LOCAL_DELIVERY";
        let locationId: string | null = null;
        let municipality: {
          code: string;
          departmentCode: string;
          name: string;
          department: { code: string; name: string };
        } | null = null;
        let pickupLocationName: string | null = null;
        let addressLine1: string;
        let addressLine2: string | null = null;
        let neighborhood: string | null = null;
        let postalCode: string | null = null;
        if (isPickup) {
          if (!settings.clickAndCollectEnabled) {
            throw new OrderValidationError("Click & Collect is disabled.");
          }
          locationId = assertUuid(input.fulfillment.locationId, "locationId");
          const location = await tx.stockLocation.findFirst({
            where: {
              id: locationId,
              type: "CLICK_COLLECT",
              deletedAt: null,
              addressLine1: { not: null },
              municipalityCode: { not: null },
            },
            include: { municipality: { include: { department: true } } },
          });
          if (!location?.municipality || !location.addressLine1 || !location.departmentCode) {
            throw new OrderValidationError(
              "The pickup location is unavailable or incompletely configured.",
            );
          }
          if (location.municipality.departmentCode !== location.departmentCode) {
            throw new OrderValidationError("The pickup location has inconsistent DANE data.");
          }
          municipality = location.municipality;
          pickupLocationName = location.name;
          addressLine1 = location.addressLine1;
        } else {
          const departmentCode = daneCode(input.fulfillment.departmentCode, 2, "departmentCode");
          const municipalityCode = daneCode(
            input.fulfillment.municipalityCode,
            5,
            "municipalityCode",
          );
          municipality = await tx.daneMunicipality.findFirst({
            where: { code: municipalityCode, departmentCode },
            include: { department: true },
          });
          if (!municipality)
            throw new OrderValidationError("The DANE department and municipality do not match.");
          addressLine1 = text(input.fulfillment.addressLine1, "addressLine1", 5, 200);
          addressLine2 = optionalText(input.fulfillment.addressLine2, "addressLine2", 200);
          neighborhood = optionalText(input.fulfillment.neighborhood, "neighborhood", 120);
          postalCode = optionalText(input.fulfillment.postalCode, "postalCode", 6);
          if (postalCode !== null && !/^[0-9]{6}$/.test(postalCode)) {
            throw new OrderValidationError("postalCode must contain six digits.");
          }
        }
        if (!municipality) throw new OrderValidationError("A DANE municipality is required.");
        if ((contact.buyerDocumentType === null) !== (contact.buyerDocumentNumber === null)) {
          throw new OrderValidationError(
            "Buyer document type and number must be provided together.",
          );
        }
        if (
          contact.buyerDocumentType &&
          !["11", "12", "13", "21", "22", "31", "41", "42", "50", "91"].includes(
            contact.buyerDocumentType,
          )
        ) {
          throw new OrderValidationError("buyerDocumentType is not supported by DIAN.");
        }
        if (
          contact.buyerDocumentNumber &&
          !/^[A-Z0-9.-]{3,30}$/.test(contact.buyerDocumentNumber)
        ) {
          throw new OrderValidationError("buyerDocumentNumber has an invalid format.");
        }
        if (
          (settings.taxRegime === "RESPONSABLE_IVA" ||
            input.fulfillment.method === "HOME_DELIVERY") &&
          !contact.buyerDocumentNumber
        ) {
          throw new OrderValidationError(
            "Buyer identification is required for carrier delivery and responsible VAT.",
          );
        }
        if (
          settings.taxRegime === "RESPONSABLE_IVA" &&
          !["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"].includes(contact.buyerTaxRegime ?? "")
        ) {
          throw new OrderValidationError("Buyer tax regime is required for electronic invoicing.");
        }
        let localDeliveryZoneId: string | null = null;
        let deliveryPoint: DeliveryPoint | null = null;
        let localQuote: ReturnType<typeof quoteLocalDeliveryZone> | null = null;
        if (isLocal) {
          if (!settings.localDeliveryEnabled)
            throw new OrderValidationError("Local Flex delivery is disabled.");
          deliveryPoint = assertDeliveryPoint(input.fulfillment.point);
          const zone = await tx.localDeliveryZone.findUnique({
            where: { id: assertUuid(input.fulfillment.zoneId, "zoneId") },
          });
          if (!zone)
            throw new OrderValidationError("The selected local delivery zone no longer exists.");
          localQuote = quoteLocalDeliveryZone(zone, {
            municipalityCode: municipality.code,
            point: deliveryPoint,
            merchandiseTotalCents: BigInt(cart.totalCents) + totalTax(taxes),
            now,
            timeZone: settings.timeZone,
          });
          localDeliveryZoneId = localQuote.zoneId;
        }
        const shippingCents = isPickup
          ? 0n
          : (localQuote?.shippingCents ?? settings.standardShippingCents);
        const deliveryPromiseAt =
          localQuote?.deliveryPromiseAt ??
          new Date(now.getTime() + settings.deliveryPromiseDays * 86_400_000);
        const reviewFingerprint = fingerprint({
          cart,
          taxes,
          fulfillmentMethod: input.fulfillment.method,
          clickCollectLocationId: locationId,
          ...(localQuote && deliveryPoint
            ? {
                localDeliveryZoneId: localQuote.zoneId,
                zoneUpdatedAt: localQuote.zoneUpdatedAt,
                deliveryPoint,
                deliveryPromiseAt: localQuote.deliveryPromiseAt,
              }
            : {}),
          shippingCents,
          taxRegime: settings.taxRegime,
          uvtValueCents: settings.uvtValueCents,
          uvtYear: settings.uvtYear,
        });
        if (reviewFingerprint !== input.expectedReviewFingerprint) {
          throw new CheckoutReviewRequiredError();
        }

        let customerId = locked.customerId;
        if (customerId) {
          const customer = await tx.customer.findFirst({
            where: { id: customerId, deletedAt: null, status: { not: "ANONYMIZED" } },
          });
          if (!customer) throw new CheckoutConflictError("The assigned customer is unavailable.");
          if (customer.email !== contact.email) throw new CheckoutAuthenticationRequiredError();
          if (!customer.givenName || !customer.familyName || !customer.phoneE164) {
            await tx.customer.update({
              where: { id: customer.id },
              data: {
                givenName: customer.givenName ?? contact.givenName,
                familyName: customer.familyName ?? contact.familyName,
                phoneE164: customer.phoneE164 ?? contact.phoneE164,
              },
            });
          }
        } else {
          await acquireOperationLocks(tx, [`checkout-customer:${contact.email}`]);
          const existingRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT "id", "status" FROM "Customer"
            WHERE "email" = ${contact.email} AND "deletedAt" IS NULL FOR UPDATE
          `;
          const existing = existingRows[0];
          if (existing?.status === "ACTIVE" && locked.kind !== "B2B") {
            throw new CheckoutAuthenticationRequiredError();
          }
          if (existing?.status === "ANONYMIZED") {
            throw new CheckoutConflictError("The customer identity is unavailable.");
          }
          if (existing) {
            customerId = existing.id;
            if (existing.status !== "ACTIVE") {
              await tx.customer.update({
                where: { id: existing.id },
                data: {
                  givenName: contact.givenName,
                  familyName: contact.familyName,
                  phoneE164: contact.phoneE164,
                },
              });
            }
          } else {
            const customer = await tx.customer.create({
              data: {
                email: contact.email,
                givenName: contact.givenName,
                familyName: contact.familyName,
                phoneE164: contact.phoneE164,
                status: "GUEST",
              },
            });
            customerId = customer.id;
          }
        }
        await new CrmService(this.db).syncCustomerContactInTransaction(tx, customerId, {
          ...(b2bProposal ? { preferredContactId: b2bProposal.opportunity.contactId } : {}),
        });
        await tx.consent.create({
          data: {
            customerId,
            purpose: "DATA_PROCESSING",
            status: "GRANTED",
            source: "checkout",
            policyVersion: contact.privacyPolicyVersion,
            proofHash: contact.acceptanceProofHash,
            ipHash: contact.acceptanceIpHash,
            userAgentHash: contact.acceptanceUserAgentHash,
            occurredAt: now,
          },
        });
        if (contact.advertisingAccepted === true) {
          const advertisingConsent = await tx.consent.findFirst({
            where: {
              customerId,
              purpose: "ADVERTISING",
              status: "GRANTED",
              revokedBy: null,
            },
            select: { id: true },
          });
          if (!advertisingConsent) {
            await tx.consent.create({
              data: {
                customerId,
                purpose: "ADVERTISING",
                status: "GRANTED",
                source: "checkout",
                policyVersion: contact.privacyPolicyVersion,
                proofHash: contact.acceptanceProofHash,
                ipHash: contact.acceptanceIpHash,
                userAgentHash: contact.acceptanceUserAgentHash,
                occurredAt: now,
              },
            });
          }
        }

        const allocation = await this.planStock(tx, cart, locationId);
        const orderId = randomUUID();
        const reservationKey = `order-reservation:${orderId}`;
        const yearRows = await tx.$queryRaw<Array<{ year: number }>>`
          SELECT EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE ${settings.timeZone}))::int AS year
        `;
        const year = yearRows[0]!.year;
        const sequenceRows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
          INSERT INTO "OrderNumberSequence" ("year", "lastNumber")
          VALUES (${year}, 1)
          ON CONFLICT ("year") DO UPDATE SET "lastNumber" = "OrderNumberSequence"."lastNumber" + 1
          RETURNING "lastNumber"
        `;
        const sequence = sequenceRows[0]!.lastNumber;
        if (sequence > 2_147_483_647)
          throw new CheckoutConflictError("Order number sequence is exhausted.");
        const orderNumber = `${settings.orderNumberPrefix}-${year}-${String(sequence).padStart(settings.orderNumberPadding, "0")}`;
        if (orderNumber.length > 32)
          throw new OrderValidationError("Generated order number exceeds 32 characters.");
        const taxCents = totalTax(taxes);
        const merchandiseTotal = BigInt(cart.totalCents) + taxCents;
        const totalCents = merchandiseTotal + shippingCents;
        assertMoney(totalCents, "totalCents");
        const reservationExpiresAt = new Date(now.getTime() + settings.reservationMinutes * 60_000);
        const created = await tx.order.create({
          data: {
            id: orderId,
            orderNumber,
            cartId: cart.id,
            customerId,
            couponId: cart.coupon?.id ?? null,
            orderStatus: "PENDING",
            paymentStatus: "UNPAID",
            fulfillmentStatus: "UNFULFILLED",
            fulfillmentMethod: input.fulfillment.method,
            taxRegime: settings.taxRegime,
            uvtValueCents: settings.uvtValueCents,
            uvtYear: settings.uvtYear,
            currency: "COP",
            emailSnapshot: contact.email,
            recipientNameSnapshot: contact.recipientName,
            phoneE164Snapshot: contact.phoneE164,
            buyerDocumentTypeSnapshot: contact.buyerDocumentType,
            buyerDocumentNumberSnapshot: contact.buyerDocumentNumber,
            buyerTaxRegimeSnapshot: contact.buyerTaxRegime,
            countryCode: "CO",
            departmentCode: municipality.departmentCode,
            departmentNameSnapshot: municipality.department.name,
            municipalityCode: municipality.code,
            municipalityNameSnapshot: municipality.name,
            addressLine1Snapshot: addressLine1,
            addressLine2Snapshot: addressLine2,
            neighborhoodSnapshot: neighborhood,
            postalCodeSnapshot: postalCode,
            deliveryLatitudeE6: deliveryPoint?.latitudeE6 ?? null,
            deliveryLongitudeE6: deliveryPoint?.longitudeE6 ?? null,
            deliveryNotesSnapshot: deliveryNotes,
            clickCollectLocationId: locationId,
            couponCodeSnapshot: cart.coupon?.code ?? null,
            subtotalCents: BigInt(cart.subtotalCents),
            wholesaleDiscountCents: BigInt(cart.wholesaleDiscountCents),
            bundleDiscountCents: BigInt(cart.bundleDiscountCents),
            couponDiscountCents: BigInt(cart.couponDiscountCents),
            discountCents:
              BigInt(cart.wholesaleDiscountCents) +
              BigInt(cart.bundleDiscountCents) +
              BigInt(cart.couponDiscountCents),
            taxCents,
            shippingCents,
            totalCents,
            reservationKey,
            reservationExpiresAt,
            deliveryPromiseAt,
            termsVersion: contact.termsVersion,
            privacyPolicyVersion: contact.privacyPolicyVersion,
            acceptanceProofHash: contact.acceptanceProofHash,
            acceptanceIpHash: contact.acceptanceIpHash,
            acceptanceUserAgentHash: contact.acceptanceUserAgentHash,
            acceptedAt: now,
          },
        });

        const createdItems: OrderItemWithTaxes[] = [];
        for (const item of cart.items) {
          const allocations = allocation.byCartItem.get(item.id);
          if (!allocations || allocations.length === 0) {
            throw new CheckoutConflictError("Stock allocation omitted an order item.");
          }
          const cost = allocations.reduce(
            (sum, entry) => sum + entry.unitCostWacCents * BigInt(entry.quantity),
            0n,
          );
          const tax = taxes.find((line) => line.lineId === item.id);
          if (!tax) throw new ReceiptBalanceError("Tax calculation omitted an order item.");
          const createdItem = await tx.orderItem.create({
            data: {
              orderId,
              sourceCartItemId: item.id,
              variantId: item.variantId,
              bundleId: item.bundle?.id ?? null,
              quantity: item.quantity,
              titleSnapshot: item.productName,
              productSlugSnapshot: item.productSlug,
              skuSnapshot: item.sku,
              unitPriceCents: BigInt(item.unitPriceCents),
              unitCostWacCents: roundDivHalfUp(cost, BigInt(item.quantity)),
              wholesaleDiscountCents: BigInt(item.wholesaleDiscountCents),
              bundleDiscountCents: BigInt(item.bundleDiscountCents),
              couponDiscountCents: BigInt(item.couponDiscountCents),
              discountCents:
                BigInt(item.wholesaleDiscountCents) +
                BigInt(item.bundleDiscountCents) +
                BigInt(item.couponDiscountCents),
              lineTotalCents: BigInt(item.lineTotalCents),
              taxCents: tax.taxCents,
            },
          });
          const taxLine = await tx.orderItemTaxLine.create({
            data: {
              orderItemId: createdItem.id,
              taxGroupCode: tax.taxGroupCode,
              taxGroupName: tax.taxGroupName,
              treatment: tax.treatment,
              rule: tax.rule,
              catalogRateBps: tax.catalogRateBps,
              appliedRateBps: tax.appliedRateBps,
              uvtLimit: tax.uvtLimit,
              uvtValueCents: tax.uvtValueCents,
              uvtYear: tax.uvtYear,
              unitValueCents: tax.unitValueCents,
              taxableBaseCents: tax.taxableBaseCents,
              taxCents: tax.taxCents,
            },
          });
          for (const entry of allocations) {
            await tx.orderItemReservation.create({
              data: {
                orderItemId: createdItem.id,
                locationId: entry.locationId,
                quantity: entry.quantity,
                unitCostWacCents: entry.unitCostWacCents,
              },
            });
          }
          createdItems.push({ ...createdItem, taxLines: [taxLine] });
        }
        await reserveStock(tx, { operationKey: reservationKey, items: allocation.movements });

        const itemIdByCartItem = new Map(
          createdItems.map((item) => [item.sourceCartItemId!, item.id] as const),
        );
        const shipmentGroups = new Map<string, Array<{ cartItemId: string; quantity: number }>>();
        for (const [cartItemId, entries] of allocation.byCartItem) {
          for (const entry of entries) {
            const group = shipmentGroups.get(entry.locationId) ?? [];
            group.push({ cartItemId, quantity: entry.quantity });
            shipmentGroups.set(entry.locationId, group);
          }
        }
        const createdItemByCartItem = new Map(
          createdItems.map((item) => [item.sourceCartItemId!, item] as const),
        );
        const declarationProgress = new Map<string, { quantity: number; value: bigint }>();
        let shippingAssigned = false;
        for (const [originLocationId, entries] of [...shipmentGroups].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )) {
          const shipment = await tx.shipment.create({
            data: {
              orderId,
              originLocationId,
              localDeliveryZoneId,
              kind: isPickup ? "CLICK_COLLECT" : "DELIVERY",
              shippingCents: !shippingAssigned ? shippingCents : 0n,
              promisedAt: deliveryPromiseAt,
            },
          });
          shippingAssigned = true;
          for (const entry of entries) {
            const orderItem = createdItemByCartItem.get(entry.cartItemId)!;
            const previous = declarationProgress.get(entry.cartItemId) ?? {
              quantity: 0,
              value: 0n,
            };
            const quantity = previous.quantity + entry.quantity;
            const declaredValueCents =
              roundDivHalfUp(
                (orderItem.lineTotalCents + orderItem.taxCents) * BigInt(quantity),
                BigInt(orderItem.quantity),
              ) - previous.value;
            declarationProgress.set(entry.cartItemId, {
              quantity,
              value: previous.value + declaredValueCents,
            });
            await tx.shipmentItem.create({
              data: {
                shipmentId: shipment.id,
                orderItemId: itemIdByCartItem.get(entry.cartItemId)!,
                quantity: entry.quantity,
                declaredValueCents,
              },
            });
          }
        }
        if (!shippingAssigned) throw new CheckoutConflictError("No shipment could be created.");

        if (cart.coupon) {
          const coupon = await tx.coupon.findUnique({ where: { id: cart.coupon.id } });
          if (
            !coupon ||
            coupon.status !== "ACTIVE" ||
            coupon.deletedAt !== null ||
            (coupon.startsAt !== null && coupon.startsAt > now) ||
            (coupon.endsAt !== null && coupon.endsAt <= now)
          ) {
            throw new CheckoutCouponError("The coupon is no longer active.");
          }
          const usage = await tx.couponUsage.findFirst({
            where: { couponId: coupon.id, cartId: cart.id, status: "RESERVED" },
          });
          if (!usage || usage.expiresAt <= now) {
            throw new CheckoutCouponError("The coupon reservation expired; apply it again.");
          }
          const counts = await tx.$queryRaw<Array<{ total: number; customer: number }>>`
            SELECT
              count(*) FILTER (WHERE "status" = 'REDEEMED' OR ("status" = 'RESERVED' AND "expiresAt" > CURRENT_TIMESTAMP))::int AS total,
              count(*) FILTER (WHERE "customerId" = ${customerId}::uuid AND ("status" = 'REDEEMED' OR ("status" = 'RESERVED' AND "expiresAt" > CURRENT_TIMESTAMP)))::int AS customer
            FROM "CouponUsage"
            WHERE "couponId" = ${coupon.id}::uuid AND "id" <> ${usage.id}::uuid
          `;
          const count = counts[0] ?? { total: 0, customer: 0 };
          if (coupon.maximumUsages !== null && count.total >= coupon.maximumUsages) {
            throw new CheckoutCouponError("The coupon redemption limit has been reached.");
          }
          if (
            customerId &&
            coupon.perCustomerUsages !== null &&
            count.customer >= coupon.perCustomerUsages
          ) {
            throw new CheckoutCouponError("The customer coupon limit has been reached.");
          }
          const redeemed = await tx.couponUsage.updateMany({
            where: { id: usage.id, status: "RESERVED" },
            data: { status: "REDEEMED", redeemedAt: now, orderId, customerId },
          });
          if (redeemed.count !== 1)
            throw new CheckoutCouponError("The coupon was consumed concurrently.");
        }

        await tx.cart.update({
          where: { id: cart.id },
          data: { status: "CONVERTED", customerId },
        });
        if (cart.kind !== "B2B") {
          await tx.abandonedCart.upsert({
            where: { cartId: cart.id },
            create: {
              cartId: cart.id,
              customerId,
              contactEmail: contact.email,
              status: "RECOVERED",
              lastActivityAt: cart.revalidatedAt ? new Date(cart.revalidatedAt) : now,
              recoveredAt: now,
            },
            update: {
              customerId,
              contactEmail: contact.email,
              status: "RECOVERED",
              recoveredAt: now,
              expiredAt: null,
            },
          });
        }
        const order = await tx.order.update({
          where: { id: created.id },
          data: { orderStatus: "CONFIRMED", confirmedAt: now },
        });
        await tx.orderStatusEvent.create({
          data: {
            orderId,
            orderStatus: "CONFIRMED",
            paymentStatus: "UNPAID",
            fulfillmentStatus: "UNFULFILLED",
            reason: b2bProposal ? "B2B_PROPOSAL_ACCEPTED" : "CHECKOUT_CONFIRMED",
            metadata: {
              fulfillmentMethod: input.fulfillment.method,
              pickupLocationName,
              ...(b2bProposal
                ? { proposalId: b2bProposal.id, proposalVersion: b2bProposal.version }
                : {}),
            },
          },
        });
        assertReceiptBalanced({
          items: createdItems.map((item) => ({
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            discountCents: item.discountCents,
            lineTotalCents: item.lineTotalCents,
            taxCents: item.taxCents,
          })),
          subtotalCents: order.subtotalCents,
          discountCents: order.discountCents,
          taxCents: order.taxCents,
          shippingCents: order.shippingCents,
          totalCents: order.totalCents,
        });
        const receiptNumber = `R-${order.orderNumber}`;
        const issuedAt = await databaseNow(tx);
        const contentHash = receiptHash(order, { receiptNumber, issuedAt }, createdItems);
        const receipt = await tx.orderReceipt.create({
          data: {
            orderId,
            receiptNumber,
            accessTokenHash: receiptAccessTokenHash,
            taxRegime: order.taxRegime!,
            currency: "COP",
            subtotalCents: order.subtotalCents,
            discountCents: order.discountCents,
            taxCents: order.taxCents,
            shippingCents: order.shippingCents,
            totalCents: order.totalCents,
            contentHash,
            issuedAt,
          },
        });
        if (b2bProposal && b2bAcceptance) {
          const converted = await tx.opportunityProposal.updateMany({
            where: { id: b2bProposal.id, status: "SENT", orderId: null },
            data: {
              status: "CONVERTED",
              orderId,
              acceptedAt: now,
              convertedAt: now,
              signerName: b2bAcceptance.signerName,
              signerDocumentType: b2bAcceptance.signerDocumentType,
              signerDocumentNumber: b2bAcceptance.signerDocumentNumber,
              acceptanceProofHash: contact.acceptanceProofHash,
              acceptanceIpHash: contact.acceptanceIpHash,
              acceptanceUserAgentHash: contact.acceptanceUserAgentHash,
            },
          });
          if (converted.count !== 1) {
            throw new CheckoutConflictError("The B2B proposal was accepted concurrently.");
          }
          const won = await tx.opportunity.updateMany({
            where: {
              id: b2bProposal.opportunityId,
              currentVersion: b2bProposal.version,
              status: "PROPOSAL_SENT",
            },
            data: { status: "WON", version: { increment: 1 } },
          });
          if (won.count !== 1) {
            throw new CheckoutConflictError("The B2B opportunity changed during acceptance.");
          }
        }
        await tx.domainOutbox.create({
          data: {
            eventType: "order.confirmed.v1",
            aggregateType: "Order",
            aggregateId: orderId,
            deduplicationKey: `order:${orderId}:confirmed:v1`,
            payload: {
              orderId,
              orderNumber: order.orderNumber,
              receiptNumber: receipt.receiptNumber,
              fulfillmentMethod: input.fulfillment.method,
              ...(receiptDeliveryReference ? { receiptDeliveryReference } : {}),
              totalCents: order.totalCents.toString(),
              paymentStatus: order.paymentStatus,
            },
          },
        });
        await recordDailyFunnelCounters(tx, { ordersConfirmed: 1n });
        const completed = await completeIdempotencyKey(tx, {
          scope: checkoutScope,
          ...idempotency,
          status: IdempotencyStatus.SUCCEEDED,
          responseStatus: 201,
          resultType: "Order",
          resultId: orderId,
        });
        if (!completed) throw new CheckoutConflictError("Unable to seal checkout idempotency.");
        return {
          orderId,
          orderNumber: order.orderNumber,
          receiptNumber: receipt.receiptNumber,
          totalCents: order.totalCents.toString(),
          paymentStatus: order.paymentStatus,
          replayed: false,
        };
      });
    } catch (error) {
      if (error instanceof OrderValidationError) throw error;
      if (error instanceof ReceiptBalanceError || error instanceof RangeError) {
        const keyHex = Buffer.from(idempotency.keyHash).toString("hex");
        await this.db.domainOutbox
          .upsert({
            where: { deduplicationKey: `receipt-emission-blocked:${keyHex}:v1` },
            create: {
              eventType: "order.receipt.emission_blocked.v1",
              aggregateType: "CheckoutSubmission",
              aggregateId: keyHex,
              deduplicationKey: `receipt-emission-blocked:${keyHex}:v1`,
              payload: { submissionKeyHash: keyHex },
            },
            update: {},
          })
          .catch(() => undefined);
        if (error instanceof ReceiptBalanceError) throw error;
        throw new ReceiptBalanceError(error.message, { cause: error });
      }
      if (hasUniqueViolation(error)) {
        throw new CheckoutConflictError(
          "A unique checkout, receipt, or inventory operation already exists.",
        );
      }
      throw error;
    }
  }

  private async planStock(
    tx: Prisma.TransactionClient,
    cart: CartSnapshot,
    pickupLocationId: string | null,
  ): Promise<{
    readonly byCartItem: Map<string, StockAllocation[]>;
    readonly movements: StockMovementInput[];
  }> {
    const variantIds = [...new Set(cart.items.map((item) => item.variantId))].sort();
    const levels = await tx.$queryRaw<Array<StockLevel & { locationCode: string }>>(Prisma.sql`
      SELECT level.*, location."code" AS "locationCode"
      FROM "StockLevel" level
      JOIN "StockLocation" location ON location."id" = level."locationId"
      WHERE level."variantId" = ANY(${variantIds}::uuid[])
        AND location."deletedAt" IS NULL AND location."type" <> 'QUARANTINE'
        AND (${pickupLocationId}::uuid IS NULL OR level."locationId" = ${pickupLocationId}::uuid)
      ORDER BY level."variantId" ASC, level."locationId" ASC
      FOR UPDATE OF level
    `);
    const remaining = new Map<string, number>();
    for (const level of levels) {
      remaining.set(`${level.variantId}:${level.locationId}`, availableStock(level));
    }
    const byCartItem = new Map<string, StockAllocation[]>();
    const movementMap = new Map<string, StockMovementInput>();
    for (const item of cart.items) {
      assertCartQuantity(item.quantity);
      const candidates = levels.filter((level) => level.variantId === item.variantId);
      const available = candidates.reduce(
        (sum, level) => sum + (remaining.get(`${level.variantId}:${level.locationId}`) ?? 0),
        0,
      );
      if (available < item.quantity)
        throw new CheckoutStockError(item.variantId, available, item.quantity);
      let needed = item.quantity;
      const allocations: StockAllocation[] = [];
      for (const level of candidates) {
        if (needed === 0) break;
        const key = `${level.variantId}:${level.locationId}`;
        const stock = remaining.get(key) ?? 0;
        const quantity = Math.min(stock, needed);
        if (quantity === 0) continue;
        allocations.push({
          locationId: level.locationId,
          quantity,
          unitCostWacCents: level.weightedAvgCostCents,
        });
        remaining.set(key, stock - quantity);
        needed -= quantity;
        const movementKey = `${item.variantId}:${level.locationId}`;
        const movement = movementMap.get(movementKey);
        if (movement) {
          movementMap.set(movementKey, { ...movement, quantity: movement.quantity + quantity });
        } else {
          movementMap.set(movementKey, {
            variantId: item.variantId,
            locationId: level.locationId,
            quantity,
          });
        }
      }
      if (needed !== 0)
        throw new CheckoutStockError(item.variantId, available - needed, item.quantity);
      byCartItem.set(item.id, allocations);
    }
    return {
      byCartItem,
      movements: [...movementMap.values()].sort(
        (left, right) =>
          compareStrings(left.variantId, right.variantId) ||
          compareStrings(left.locationId, right.locationId),
      ),
    };
  }

  async getReceiptByToken(accessTokenHash: Uint8Array): Promise<OrderReceiptSnapshot | null> {
    const hash = hash32(accessTokenHash, "accessTokenHash");
    const record = await this.db.orderReceipt.findUnique({
      where: { accessTokenHash: hash },
      include: {
        order: {
          include: {
            clickCollectLocation: { select: { name: true } },
            items: { include: { taxLines: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          },
        },
      },
    });
    if (!record) return null;
    const typed = record as ReceiptWithOrder;
    try {
      const expected = receiptHash(
        typed.order,
        { receiptNumber: typed.receiptNumber, issuedAt: typed.issuedAt },
        typed.order.items,
      );
      const actual = Uint8Array.from(record.contentHash);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new ReceiptBalanceError();
      }
      const snapshot = receiptSnapshot(typed);
      assertReceiptBalanced({
        items: typed.order.items.map((item) => ({
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          lineTotalCents: item.lineTotalCents,
          taxCents: item.taxCents,
        })),
        subtotalCents: typed.subtotalCents,
        discountCents: typed.discountCents,
        taxCents: typed.taxCents,
        shippingCents: typed.shippingCents,
        totalCents: typed.totalCents,
      });
      return snapshot;
    } catch (error) {
      await this.db.domainOutbox.upsert({
        where: { deduplicationKey: `receipt:${record.id}:integrity-failed:v1` },
        create: {
          eventType: "order.receipt.integrity_failed.v1",
          aggregateType: "OrderReceipt",
          aggregateId: record.id,
          deduplicationKey: `receipt:${record.id}:integrity-failed:v1`,
          payload: { orderId: record.orderId, receiptId: record.id },
        },
        update: {},
      });
      if (error instanceof ReceiptBalanceError) throw error;
      throw new ReceiptBalanceError(
        error instanceof Error ? error.message : "Receipt verification failed.",
      );
    }
  }
}
