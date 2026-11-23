import { createHmac, timingSafeEqual } from "node:crypto";

import { parseHttpJson } from "./integration-http.js";
import {
  MercadoLibreCatalogError,
  MercadoLibreUserProductsClient,
} from "./mercado-libre-catalog.js";
import type { MercadoLibreTokenCredential } from "./mercado-libre.js";

const maximumResponseBytes = 1_000_000;

export type MercadoLibreResourceKind = "orders" | "packs" | "shipments";

export interface MercadoLibreNotification {
  readonly notificationId: string;
  readonly signatureId: string;
  readonly externalAccountId: string;
  readonly kind: MercadoLibreResourceKind;
  readonly externalId: string;
}

export interface MercadoLibrePackSnapshot {
  readonly externalId: string;
  readonly externalShipmentId: string | null;
  readonly orderIds: readonly string[];
  readonly status: "PENDING" | "RELEASED" | "ERROR" | "PENDING_CANCEL" | "CANCELLED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MercadoLibrePaymentSnapshot {
  readonly externalId: string;
  readonly status: string;
  readonly capturedCents: bigint;
  readonly refundedCents: bigint;
  readonly marketplaceFeeCents: bigint;
  readonly occurredAt: Date;
}

export interface MercadoLibreOrderSnapshot {
  readonly externalId: string;
  readonly externalPackId: string | null;
  readonly externalShipmentId: string | null;
  readonly externalItemId: string;
  readonly externalUserProductId: string | null;
  readonly sellerSku: string | null;
  readonly remoteStatus: string;
  readonly status: "PENDING" | "PAID" | "CANCELLED";
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly grossAmountCents: bigint;
  readonly paidAmountCents: bigint;
  readonly capturedAmountCents: bigint;
  readonly refundedAmountCents: bigint;
  readonly expectedFeeCents: bigint;
  readonly marketplaceFeeCents: bigint;
  readonly shippingChargeCents: bigint;
  readonly stockReferences: readonly { readonly storeId: string; readonly networkNodeId: string }[];
  readonly payments: readonly MercadoLibrePaymentSnapshot[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

export interface MercadoLibreShipmentSnapshot {
  readonly externalId: string;
  readonly externalOrderId: string | null;
  readonly externalPackId: string | null;
  readonly logisticType: "ME2" | "FLEX" | "FULL";
  readonly status:
    "PENDING" | "READY_TO_SHIP" | "SHIPPED" | "DELIVERED" | "NOT_DELIVERED" | "CANCELLED";
  readonly remoteSubstatus: string | null;
  readonly trackingNumber: string | null;
  readonly costCents: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
}

function invalid(message: string): never {
  throw new MercadoLibreCatalogError("INVALID_RESPONSE", message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("Mercado Libre returned an invalid object.");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function externalId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value) && BigInt(value) > 0n) return value;
  return invalid(`${field} is not a valid Mercado Libre identifier.`);
}

function optionalExternalId(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === 0 || value === "0"
    ? null
    : externalId(value, field);
}

function itemId(value: unknown): string {
  if (typeof value !== "string" || !/^MCO[0-9]{1,59}$/.test(value)) {
    return invalid("The order item identifier is invalid.");
  }
  return value;
}

function userProductId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^MCO[A-Z0-9]{2,61}$/.test(value)) {
    return invalid("The order User Product identifier is invalid.");
  }
  return value;
}

function text(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${field} is invalid.`);
  }
  return value;
}

function money(value: unknown, field: string): bigint {
  if (typeof value !== "number" && typeof value !== "string") {
    return invalid(`${field} is not an amount.`);
  }
  if (typeof value === "number" && !Number.isFinite(value))
    return invalid(`${field} is not finite.`);
  const raw = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return invalid(`${field} must be a non-negative decimal amount.`);
  const integer = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    return invalid(`${field} has an invalid exponent.`);
  }
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  const scale = fraction.length - exponent;
  let cents: bigint;
  if (scale <= 2) {
    cents = BigInt(digits) * 10n ** BigInt(2 - scale);
  } else {
    const divisor = 10n ** BigInt(scale - 2);
    const amount = BigInt(digits);
    if (amount % divisor !== 0n) return invalid(`${field} has more than two decimal places.`);
    cents = amount / divisor;
  }
  if (cents > 9_223_372_036_854_775_807n) return invalid(`${field} exceeds INT8.`);
  return cents;
}

function positiveMoney(value: unknown, field: string): bigint {
  const result = money(value, field);
  if (result <= 0n) return invalid(`${field} must be positive.`);
  return result;
}

function sumMoney(values: readonly bigint[], field: string): bigint {
  const result = values.reduce((sum, value) => sum + value, 0n);
  if (result > 9_223_372_036_854_775_807n) invalid(`${field} exceeds INT8.`);
  return result;
}

function date(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return invalid(`${field} is not an ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return invalid(`${field} is not a valid timestamp.`);
  return parsed;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : date(value, field);
}

function positiveQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    return invalid("The order quantity is invalid.");
  }
  return value;
}

function parsePack(body: string, expectedId: string): MercadoLibrePackSnapshot {
  const root = record(parseHttpJson(body));
  const id = externalId(root.id, "pack id");
  if (id !== expectedId) invalid("The pack response identifier does not match the request.");
  if (!Array.isArray(root.orders) || root.orders.length < 1 || root.orders.length > 100) {
    invalid("A pack must contain between one and one hundred orders.");
  }
  const orderIds = root.orders.map((entry) => externalId(record(entry).id, "order id"));
  if (new Set(orderIds).size !== orderIds.length) invalid("The pack contains duplicate orders.");
  const status = text(root.status, "pack status", 30);
  const statuses = {
    pending: "PENDING",
    released: "RELEASED",
    error: "ERROR",
    pending_cancel: "PENDING_CANCEL",
    cancelled: "CANCELLED",
  } as const;
  if (!(status in statuses)) invalid("The pack status is not supported.");
  const createdAt = date(root.date_created, "pack date_created");
  const updatedAt = date(root.last_updated, "pack last_updated");
  if (updatedAt < createdAt) invalid("The pack timestamps are inconsistent.");
  return {
    externalId: id,
    externalShipmentId: optionalExternalId(optionalRecord(root.shipment).id, "shipment id"),
    orderIds,
    status: statuses[status as keyof typeof statuses],
    createdAt,
    updatedAt,
  };
}

function parsePayment(value: unknown, orderUpdatedAt: Date): MercadoLibrePaymentSnapshot {
  const root = record(value);
  const status = text(root.status, "payment status", 40);
  const supported = new Set([
    "approved",
    "partially_refunded",
    "refunded",
    "charged_back",
    "authorized",
    "pending",
    "in_process",
    "in_mediation",
    "rejected",
    "cancelled",
    "voided",
  ]);
  if (!supported.has(status)) invalid("The payment status is not supported.");
  if (root.currency_id !== undefined && root.currency_id !== "COP") {
    invalid("Only COP payments are supported.");
  }
  const captures = ["approved", "partially_refunded", "refunded", "charged_back"].includes(status);
  const capturedCents = captures ? money(root.total_paid_amount ?? 0, "total_paid_amount") : 0n;
  const refundedCents = captures
    ? money(root.transaction_amount_refunded ?? 0, "transaction_amount_refunded")
    : 0n;
  const marketplaceFeeCents = captures ? money(root.marketplace_fee ?? 0, "marketplace_fee") : 0n;
  if (refundedCents > capturedCents) invalid("A payment refund exceeds its capture.");
  const occurredAt =
    optionalDate(root.date_last_modified, "payment date_last_modified") ??
    optionalDate(root.date_approved, "payment date_approved") ??
    optionalDate(root.date_created, "payment date_created") ??
    orderUpdatedAt;
  return {
    externalId: externalId(root.id, "payment id"),
    status,
    capturedCents,
    refundedCents,
    marketplaceFeeCents,
    occurredAt,
  };
}

function parseOrder(
  body: string,
  expectedId: string,
  expectedSellerId: string,
): MercadoLibreOrderSnapshot {
  const root = record(parseHttpJson(body));
  const id = externalId(root.id, "order id");
  if (id !== expectedId) invalid("The order response identifier does not match the request.");
  const sellerId = externalId(optionalRecord(root.seller).id, "seller id");
  if (sellerId !== expectedSellerId) invalid("The order belongs to another seller.");
  if (root.currency_id !== "COP") invalid("Only COP orders are supported.");
  if (!Array.isArray(root.order_items) || root.order_items.length !== 1) {
    invalid("Mercado Libre orders must contain exactly one item line.");
  }
  const line = record(root.order_items[0]);
  const item = record(line.item);
  const quantity = positiveQuantity(line.quantity);
  const unitPriceCents = positiveMoney(line.unit_price, "unit_price");
  const grossAmountCents = positiveMoney(root.total_amount, "total_amount");
  if (grossAmountCents !== unitPriceCents * BigInt(quantity)) {
    invalid("The order total does not balance its item line.");
  }
  const saleFeeCents = money(line.sale_fee ?? 0, "sale_fee");
  const createdAt = date(root.date_created, "order date_created");
  const updatedAt = date(root.last_updated, "order last_updated");
  if (updatedAt < createdAt) invalid("The order timestamps are inconsistent.");
  if (!Array.isArray(root.payments) || root.payments.length > 100) {
    invalid("The order contains an invalid payments collection.");
  }
  const payments = root.payments.map((payment) => parsePayment(payment, updatedAt));
  if (new Set(payments.map((payment) => payment.externalId)).size !== payments.length) {
    invalid("The order contains duplicate payments.");
  }
  const capturedAmountCents = sumMoney(
    payments.map((payment) => payment.capturedCents),
    "captured amount",
  );
  const refundedAmountCents = sumMoney(
    payments.map((payment) => payment.refundedCents),
    "refunded amount",
  );
  const marketplaceFeeCents = sumMoney(
    payments.map((payment) => payment.marketplaceFeeCents),
    "marketplace fee",
  );
  const paidAmountCents = money(root.paid_amount ?? 0, "paid_amount");
  if (refundedAmountCents > capturedAmountCents) invalid("Order refunds exceed captures.");
  const remoteStatus = text(root.status, "order status", 40);
  const statuses = new Set([
    "payment_required",
    "payment_in_process",
    "partially_paid",
    "paid",
    "confirmed",
    "cancelled",
    "invalid",
  ]);
  if (!statuses.has(remoteStatus)) invalid("The order status is not supported.");
  const status = ["cancelled", "invalid"].includes(remoteStatus)
    ? "CANCELLED"
    : remoteStatus === "paid"
      ? "PAID"
      : "PENDING";
  if (status === "PAID" && capturedAmountCents === 0n) {
    invalid("A paid order has no approved payment capture.");
  }
  if (status === "PAID" && paidAmountCents === 0n) invalid("A paid order has no paid amount.");
  const sellerSku =
    item.seller_sku === null || item.seller_sku === undefined || item.seller_sku === ""
      ? null
      : text(item.seller_sku, "seller_sku", 64);
  const stockReferences = !Array.isArray(line.stock)
    ? []
    : line.stock.slice(0, 20).map((entry) => {
        const stock = record(entry);
        return {
          storeId: text(stock.store_id, "stock store_id", 64),
          networkNodeId: text(stock.network_node_id, "stock network_node_id", 64),
        };
      });
  return {
    externalId: id,
    externalPackId: optionalExternalId(root.pack_id, "pack id"),
    externalShipmentId: optionalExternalId(optionalRecord(root.shipping).id, "shipment id"),
    externalItemId: itemId(item.id),
    externalUserProductId: userProductId(item.user_product_id),
    sellerSku,
    remoteStatus,
    status,
    quantity,
    unitPriceCents,
    grossAmountCents,
    paidAmountCents,
    capturedAmountCents,
    refundedAmountCents,
    expectedFeeCents: saleFeeCents * BigInt(quantity),
    marketplaceFeeCents,
    shippingChargeCents: money(root.shipping_cost ?? 0, "shipping_cost"),
    stockReferences,
    payments,
    createdAt,
    updatedAt,
    closedAt: optionalDate(root.date_closed, "order date_closed"),
  };
}

function parseShipment(body: string, expectedId: string): MercadoLibreShipmentSnapshot {
  const root = record(parseHttpJson(body));
  const id = externalId(root.id, "shipment id");
  if (id !== expectedId) invalid("The shipment response identifier does not match the request.");
  const providerStatus = text(root.status, "shipment status", 40);
  const statusMap = {
    pending: "PENDING",
    handling: "READY_TO_SHIP",
    ready_to_ship: "READY_TO_SHIP",
    ready_to_print: "READY_TO_SHIP",
    printed: "READY_TO_SHIP",
    shipped: "SHIPPED",
    in_transit: "SHIPPED",
    out_for_delivery: "SHIPPED",
    delivered: "DELIVERED",
    not_delivered: "NOT_DELIVERED",
    returned: "NOT_DELIVERED",
    returning: "NOT_DELIVERED",
    lost: "NOT_DELIVERED",
    cancelled: "CANCELLED",
  } as const;
  if (!(providerStatus in statusMap)) invalid("The shipment status is not supported.");
  const status = statusMap[providerStatus as keyof typeof statusMap];
  const logistic =
    root.logistic_type === null || root.logistic_type === undefined
      ? null
      : text(root.logistic_type, "logistic_type", 40);
  const mode = root.mode === null || root.mode === undefined ? null : text(root.mode, "mode", 30);
  const logisticType =
    logistic === "fulfillment"
      ? "FULL"
      : logistic === "self_service"
        ? "FLEX"
        : logistic && ["cross_docking", "xd_drop_off", "drop_off", "remote"].includes(logistic)
          ? "ME2"
          : mode === "me2"
            ? "ME2"
            : invalid("The shipment logistics mode is not supported.");
  const remoteSubstatus =
    root.substatus === null || root.substatus === undefined
      ? null
      : text(root.substatus, "shipment substatus", 80);
  if (remoteSubstatus && !/^[a-z][a-z0-9_]{0,79}$/.test(remoteSubstatus)) {
    invalid("The shipment substatus is invalid.");
  }
  const trackingNumber =
    root.tracking_number === null ||
    root.tracking_number === undefined ||
    root.tracking_number === ""
      ? null
      : text(root.tracking_number, "tracking_number", 120);
  if (trackingNumber && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(trackingNumber)) {
    invalid("The shipment tracking number is invalid.");
  }
  const createdAt = date(root.date_created, "shipment date_created");
  const updatedAt = date(root.last_updated, "shipment last_updated");
  if (updatedAt < createdAt) invalid("The shipment timestamps are inconsistent.");
  const shippedAt = ["SHIPPED", "DELIVERED", "NOT_DELIVERED"].includes(status)
    ? (optionalDate(root.date_shipped, "shipment date_shipped") ?? updatedAt)
    : null;
  const deliveredAt =
    status === "DELIVERED"
      ? (optionalDate(root.date_delivered, "shipment date_delivered") ?? updatedAt)
      : null;
  return {
    externalId: id,
    externalOrderId: optionalExternalId(root.order_id, "shipment order_id"),
    externalPackId: optionalExternalId(root.pack_id, "shipment pack_id"),
    logisticType,
    status,
    remoteSubstatus,
    trackingNumber,
    costCents: money(root.cost ?? optionalRecord(root.shipping_option).cost ?? 0, "shipment cost"),
    createdAt,
    updatedAt,
    shippedAt,
    deliveredAt,
  };
}

export function parseMercadoLibreNotification(
  body: string,
  requestId?: string | null,
): MercadoLibreNotification {
  if (typeof body !== "string" || body.length < 2 || body.length > 16_384) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification size is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification is not valid JSON.");
  }
  let root: Record<string, unknown>;
  try {
    root = record(parsed);
  } catch {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification must be an object.");
  }
  const topic = root.topic ?? root.type;
  const topicMap = {
    orders_v2: "orders",
    orders: "orders",
    packs: "packs",
    shipments: "shipments",
  } as const;
  if (typeof topic !== "string" || !(topic in topicMap)) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification topic is not supported.");
  }
  const resource = text(root.resource, "notification resource", 200);
  const kind = topicMap[topic as keyof typeof topicMap];
  const match = new RegExp(`^/${kind}/([0-9]{1,20})$`).exec(resource);
  if (!match?.[1]) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification resource is invalid.");
  }
  const data = optionalRecord(root.data);
  const token = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return String(value);
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)) return value;
    return null;
  };
  const signatureId = token(data.id);
  if (data.id !== undefined && signatureId === null) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification data.id is invalid.");
  }
  const persistedId = signatureId ?? token(root._id) ?? token(requestId);
  if (!persistedId) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      "The notification requires data.id or x-request-id.",
    );
  }
  return {
    notificationId: persistedId,
    signatureId: signatureId ?? "",
    externalAccountId: externalId(root.user_id, "notification user_id"),
    kind,
    externalId: match[1],
  };
}

export function verifyMercadoLibreNotificationSignature(options: {
  readonly notificationId: string;
  readonly requestId: string | null;
  readonly signature: string | null;
  readonly clientSecret: string;
}): void {
  if (!options.requestId || !/^[A-Za-z0-9_-]{8,160}$/.test(options.requestId)) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification request ID is missing.");
  }
  const pairs = (options.signature ?? "").split(",").map((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification signature is invalid.");
    }
    return [part.slice(0, separator), part.slice(separator + 1)] as const;
  });
  if (pairs.length !== 2 || new Set(pairs.map(([key]) => key)).size !== 2) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification signature is invalid.");
  }
  const parts = new Map(pairs);
  const timestamp = parts.get("ts");
  const supplied = parts.get("v1");
  if (
    !timestamp ||
    !/^[0-9]{10,16}$/.test(timestamp) ||
    !supplied ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    BigInt(timestamp) > BigInt(Date.now() + 300_000)
  ) {
    throw new MercadoLibreCatalogError("INVALID_INPUT", "The notification signature is invalid.");
  }
  const manifest = `id:${options.notificationId};request-id:${options.requestId};ts:${timestamp};`;
  const expected = createHmac("sha256", options.clientSecret).update(manifest).digest();
  const actual = Buffer.from(supplied, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new MercadoLibreCatalogError(
      "INVALID_INPUT",
      "The notification signature does not match.",
    );
  }
}

export class MercadoLibreOrderClient extends MercadoLibreUserProductsClient {
  async getPack(
    credential: MercadoLibreTokenCredential,
    externalIdValue: string,
  ): Promise<MercadoLibrePackSnapshot> {
    const id = externalId(externalIdValue, "pack id");
    const response = await this.request(credential, "GET", `packs/${id}`, undefined, {
      "x-format-response": "true",
    });
    if (response.body.length > maximumResponseBytes) invalid("The pack response is too large.");
    return parsePack(response.body, id);
  }

  async getOrder(
    credential: MercadoLibreTokenCredential,
    externalIdValue: string,
  ): Promise<MercadoLibreOrderSnapshot> {
    const id = externalId(externalIdValue, "order id");
    const response = await this.request(credential, "GET", `orders/${id}`);
    if (response.body.length > maximumResponseBytes) invalid("The order response is too large.");
    return parseOrder(response.body, id, credential.externalAccountId);
  }

  async getShipment(
    credential: MercadoLibreTokenCredential,
    externalIdValue: string,
  ): Promise<MercadoLibreShipmentSnapshot> {
    const id = externalId(externalIdValue, "shipment id");
    const response = await this.request(credential, "GET", `shipments/${id}`);
    if (response.body.length > maximumResponseBytes) invalid("The shipment response is too large.");
    return parseShipment(response.body, id);
  }
}
