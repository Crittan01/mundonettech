import { createHash, randomUUID } from "node:crypto";

import {
  ShippingProviderCode,
  type OrderFulfillmentStatus,
  type ShipmentPackageStatus,
} from "@mundonettech/db";

import { AveonlineShippingProvider, parseAveonlineCredentials } from "./shipping-providers.js";
import { assertIntegrationUuid, integrationDigest, integrationText } from "./integration-utils.js";
import {
  assertFulfillmentActor,
  assertPaidOrder,
  lockFulfillment,
  lockOrder,
  lockPackage,
  lockShipment,
  positiveInteger,
  shippingWorkerId,
  writeShippingAudit,
  writeShippingOutbox,
  type ShippingTransaction,
} from "./shipping-shared.js";
import {
  ShippingConflictError,
  ShippingNotFoundError,
  ShippingProviderError,
  ShippingValidationError,
  type ShippingAuditContext,
  type ShippingLabelRequest,
  type ShippingLabelResult,
  type ShippingPackageInput,
  type ShippingProvider,
  type ShippingServiceOptions,
} from "./shipping-types.js";

export interface PackShipmentResult {
  readonly fulfillmentId: string;
  readonly status: OrderFulfillmentStatus;
  readonly packageIds: readonly string[];
}

export interface LabelProcessResult {
  readonly packageId: string;
  readonly status: ShipmentPackageStatus;
  readonly trackingCode: string | null;
  readonly replayed: boolean;
}

function roundDiv(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new ShippingValidationError("Declared value divisor must be positive.");
  return (value + divisor / 2n) / divisor;
}

function localTracking(requestKey: string): string {
  return `FLEX-${createHash("sha256").update(requestKey).digest("hex").slice(0, 20).toUpperCase()}`;
}

export class ShippingService {
  constructor(
    private readonly db: import("@mundonettech/db").PrismaClient,
    private readonly options: ShippingServiceOptions,
  ) {}

  private provider(
    credentials: import("./shipping-types.js").AveonlineCredentials,
  ): ShippingProvider {
    return (
      this.options.providerFactory?.(credentials) ?? new AveonlineShippingProvider(credentials)
    );
  }

  async ensureFulfillments(
    orderId: string,
    credentialId?: string,
    audit?: ShippingAuditContext,
  ): Promise<readonly string[]> {
    assertIntegrationUuid(orderId, "orderId");
    if (credentialId !== undefined) assertIntegrationUuid(credentialId, "credentialId");
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { shipments: true },
    });
    if (!order) throw new ShippingNotFoundError("Order not found.");
    await assertPaidOrder(this.db, order);
    let aveonlineCredentialId: string | null = null;
    if (order.fulfillmentMethod === "HOME_DELIVERY") {
      const credentials = await this.options.vault.list({ includeRevoked: false, limit: 100 });
      const active = credentials.items.filter(
        (item) => item.provider === "aveonline" && !item.revokedAt,
      );
      const selected = credentialId
        ? active.find((item) => item.id === credentialId)
        : active.length === 1
          ? active[0]
          : null;
      if (!selected || (credentials.items.length === 100 && credentialId === undefined)) {
        throw new ShippingConflictError(
          "An explicit active Aveonline credential is required before fulfillment.",
        );
      }
      aveonlineCredentialId = selected.id;
    }
    return this.db.$transaction(async (tx) => {
      if (audit) await assertFulfillmentActor(tx, audit.actorAdminUserId);
      const locked = await lockOrder(tx, orderId);
      await assertPaidOrder(tx, locked);
      const shipments = await tx.shipment.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (shipments.length === 0)
        throw new ShippingConflictError("The order has no shipments to fulfill.");
      const ids: string[] = [];
      for (const shipment of shipments) {
        const existing = await tx.orderFulfillment.findUnique({
          where: { shipmentId: shipment.id },
        });
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        if (shipment.status === "CANCELLED") continue;
        const provider =
          locked.fulfillmentMethod === "CLICK_COLLECT"
            ? ShippingProviderCode.PICKUP
            : locked.fulfillmentMethod === "LOCAL_DELIVERY"
              ? ShippingProviderCode.FLEX
              : ShippingProviderCode.AVEONLINE;
        if (provider === ShippingProviderCode.FLEX && !shipment.localDeliveryZoneId) {
          throw new ShippingConflictError(
            "Local delivery shipment is missing its sealed zone.",
            "ZONE_UNAVAILABLE",
          );
        }
        const fulfillment = await tx.orderFulfillment.create({
          data: {
            orderId,
            shipmentId: shipment.id,
            provider,
            credentialId:
              provider === ShippingProviderCode.AVEONLINE ? aveonlineCredentialId : null,
            environment:
              provider === ShippingProviderCode.AVEONLINE ? this.options.environment : null,
          },
        });
        await tx.shipmentEvent.create({
          data: {
            shipmentId: shipment.id,
            type: "FULFILLMENT_CREATED",
            eventKey: `fulfillment-created:${fulfillment.id}`,
            metadata: { fulfillmentId: fulfillment.id, provider },
          },
        });
        await writeShippingOutbox(tx, {
          eventType: "shipping.fulfillment.created.v1",
          aggregateType: "OrderFulfillment",
          aggregateId: fulfillment.id,
          deduplicationKey: `fulfillment:${fulfillment.id}:created:v1`,
          payload: { orderId, shipmentId: shipment.id, fulfillmentId: fulfillment.id },
        });
        if (audit) {
          await writeShippingAudit(tx, {
            action: "ORDER_FULFILLMENT_CREATED",
            targetType: "OrderFulfillment",
            targetId: fulfillment.id,
            audit,
            metadata: { orderId, shipmentId: shipment.id, provider },
          });
        }
        ids.push(fulfillment.id);
      }
      return ids;
    });
  }

  async startPicking(shipmentId: string, audit: ShippingAuditContext): Promise<string> {
    assertIntegrationUuid(shipmentId, "shipmentId");
    const shipment = await this.db.shipment.findUnique({
      where: { id: shipmentId },
      select: { orderId: true },
    });
    if (!shipment) throw new ShippingNotFoundError("Shipment not found.");
    await this.ensureFulfillments(shipment.orderId, undefined, audit);
    return this.db.$transaction(async (tx) => {
      await assertFulfillmentActor(tx, audit.actorAdminUserId);
      const fulfillment = await lockFulfillment(tx, shipmentId);
      if (fulfillment.status !== "PENDING") {
        if (["PICKING", "PACKED", "LABELLED", "SHIPPED", "DELIVERED"].includes(fulfillment.status))
          return fulfillment.id;
        throw new ShippingConflictError("Fulfillment cannot start picking in its current state.");
      }
      const order = await lockOrder(tx, fulfillment.orderId);
      await assertPaidOrder(tx, order);
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: "PICKING", version: { increment: 1 } },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          actorAdminUserId: audit.actorAdminUserId,
          type: "PICKING_STARTED",
          eventKey: `picking:${fulfillment.id}`,
        },
      });
      await writeShippingAudit(tx, {
        action: "FULFILLMENT_PICKING_STARTED",
        targetType: "OrderFulfillment",
        targetId: fulfillment.id,
        audit,
        metadata: { orderId: fulfillment.orderId, shipmentId },
      });
      return fulfillment.id;
    });
  }

  async pack(
    shipmentId: string,
    packages: readonly ShippingPackageInput[],
    audit: ShippingAuditContext,
  ): Promise<PackShipmentResult> {
    assertIntegrationUuid(shipmentId, "shipmentId");
    if (!Array.isArray(packages) || packages.length < 1 || packages.length > 1000) {
      throw new ShippingValidationError(
        "At least one and at most 1000 physical packages are required.",
      );
    }
    if (packages.reduce((sum, record) => sum + record.items.length, 0) > 10_000) {
      throw new ShippingValidationError("Package content lines exceed the request resource limit.");
    }
    return this.db.$transaction(async (tx) => {
      await assertFulfillmentActor(tx, audit.actorAdminUserId);
      const fulfillment = await lockFulfillment(tx, shipmentId);
      if (fulfillment.status !== "PICKING")
        throw new ShippingConflictError("Only an active picking fulfillment can be packed.");
      const shipment = await lockShipment(tx, shipmentId);
      if (shipment.status !== "PENDING")
        throw new ShippingConflictError("Only a pending shipment can be packed.");
      const existingPackages = await tx.shipmentPackage.count({ where: { shipmentId } });
      if (existingPackages !== 0)
        throw new ShippingConflictError(
          "Shipment packages already exist and cannot be replaced implicitly.",
          "IDEMPOTENCY_CONFLICT",
        );
      const allItems = await tx.shipmentItem.findMany({
        where: { shipment: { orderId: fulfillment.orderId } },
        include: { orderItem: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const items = allItems.filter((item) => item.shipmentId === shipmentId);
      if (items.length === 0) throw new ShippingConflictError("Shipment has no items to pack.");
      const cumulative = new Map<string, { quantity: number; value: bigint }>();
      const declaredByShipmentItem = new Map<string, bigint>();
      for (const item of allItems) {
        const previous = cumulative.get(item.orderItemId) ?? { quantity: 0, value: 0n };
        const quantity = previous.quantity + item.quantity;
        const total = item.orderItem.lineTotalCents + item.orderItem.taxCents;
        const allocated =
          item.declaredValueCents ??
          roundDiv(total * BigInt(quantity), BigInt(item.orderItem.quantity)) - previous.value;
        declaredByShipmentItem.set(item.id, allocated);
        cumulative.set(item.orderItemId, { quantity, value: previous.value + allocated });
      }
      const expectedQuantities = new Map(items.map((item) => [item.id, item.quantity]));
      const seen = new Map<string, number>();
      for (const record of packages) {
        positiveInteger(record.weightGrams, "weightGrams", 10_000_000);
        positiveInteger(record.lengthMillimeters, "lengthMillimeters", 100_000);
        positiveInteger(record.widthMillimeters, "widthMillimeters", 100_000);
        positiveInteger(record.heightMillimeters, "heightMillimeters", 100_000);
        if (!Array.isArray(record.items) || record.items.length === 0)
          throw new ShippingValidationError("Every package must contain at least one item.");
        const unique = new Set<string>();
        for (const content of record.items) {
          assertIntegrationUuid(content.shipmentItemId, "shipmentItemId");
          positiveInteger(content.quantity, "quantity");
          if (!expectedQuantities.has(content.shipmentItemId))
            throw new ShippingValidationError("Package content does not belong to this shipment.");
          if (unique.has(content.shipmentItemId))
            throw new ShippingValidationError("A shipment item can appear only once per package.");
          unique.add(content.shipmentItemId);
          seen.set(
            content.shipmentItemId,
            (seen.get(content.shipmentItemId) ?? 0) + content.quantity,
          );
        }
      }
      for (const [itemId, quantity] of expectedQuantities) {
        if (seen.get(itemId) !== quantity)
          throw new ShippingConflictError(
            "Packed quantities must exactly cover every shipment item.",
            "PACKAGE_INCOMPLETE",
          );
      }
      const packageIds: string[] = [];
      const packedSoFar = new Map<string, number>();
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      for (const [index, record] of packages.entries()) {
        const packageNumber = index + 1;
        const requestKey = `shipment:${shipmentId}:package:${packageNumber}:v1`;
        const contents: Array<{
          shipmentItemId: string;
          quantity: number;
          declaredValueCents: bigint;
        }> = record.items.map((content: ShippingPackageInput["items"][number]) => {
          const parentValue = declaredByShipmentItem.get(content.shipmentItemId)!;
          const parentQuantity = expectedQuantities.get(content.shipmentItemId)!;
          const priorInPackages = packedSoFar.get(content.shipmentItemId) ?? 0;
          const cumulativeQuantity = priorInPackages + content.quantity;
          const before = roundDiv(parentValue * BigInt(priorInPackages), BigInt(parentQuantity));
          const after = roundDiv(parentValue * BigInt(cumulativeQuantity), BigInt(parentQuantity));
          packedSoFar.set(content.shipmentItemId, cumulativeQuantity);
          return { ...content, declaredValueCents: after - before };
        });
        const declaredValueCents = contents.reduce(
          (sum, content) => sum + content.declaredValueCents,
          0n,
        );
        const requestHash = integrationDigest({
          requestKey,
          orderId: fulfillment.orderId,
          record,
          contents,
        });
        const local = fulfillment.provider !== ShippingProviderCode.AVEONLINE;
        const trackingCode = local ? localTracking(requestKey) : null;
        const created = await tx.shipmentPackage.create({
          data: {
            shipmentId,
            packageNumber,
            status: local ? "LABELLED" : "SEALED",
            weightGrams: record.weightGrams,
            lengthMillimeters: record.lengthMillimeters,
            widthMillimeters: record.widthMillimeters,
            heightMillimeters: record.heightMillimeters,
            declaredValueCents,
            requestKey,
            requestHash,
            credentialId: fulfillment.credentialId,
            providerReference: local ? requestKey : null,
            trackingCode,
            labelledAt: local ? now : null,
            items: {
              create: contents.map((content) => ({
                shipmentItemId: content.shipmentItemId,
                quantity: content.quantity,
                declaredValueCents: content.declaredValueCents,
              })),
            },
          },
        });
        packageIds.push(created.id);
        await tx.shipmentEvent.create({
          data: {
            shipmentId,
            packageId: created.id,
            actorAdminUserId: audit.actorAdminUserId,
            type: "PACKAGE_SEALED",
            eventKey: `package-sealed:${created.id}`,
            metadata: {
              packageNumber,
              declaredValueCents: declaredValueCents.toString(),
              weightGrams: record.weightGrams,
            },
          },
        });
        if (!local) {
          await writeShippingOutbox(tx, {
            eventType: "shipping.label.requested.v1",
            aggregateType: "ShipmentPackage",
            aggregateId: created.id,
            deduplicationKey: `shipment-package:${created.id}:label-requested:v1`,
            payload: { orderId: fulfillment.orderId, shipmentId, packageId: created.id },
          });
        }
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: "PACKED", version: { increment: 1 } },
      });
      let status: OrderFulfillmentStatus = "PACKED";
      if (fulfillment.provider !== ShippingProviderCode.AVEONLINE) {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: "LABELLED", version: { increment: 1 } },
        });
        status = "LABELLED";
      }
      const firstTracking =
        fulfillment.provider !== ShippingProviderCode.AVEONLINE
          ? localTracking(`shipment:${shipmentId}:package:1:v1`)
          : null;
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: "READY",
          readyAt: now,
          trackingCode: firstTracking,
          carrier: firstTracking ? fulfillment.provider : null,
        },
      });
      await writeShippingAudit(tx, {
        action: "FULFILLMENT_PACKED",
        targetType: "OrderFulfillment",
        targetId: fulfillment.id,
        audit,
        metadata: { shipmentId, packageIds, packageCount: packageIds.length },
      });
      return { fulfillmentId: fulfillment.id, status, packageIds };
    });
  }

  private async credentials(credentialId: string) {
    const plaintext = await this.options.vault.reveal(credentialId);
    try {
      return parseAveonlineCredentials(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  private async labelRequest(
    packageId: string,
  ): Promise<{ request: ShippingLabelRequest; provider: ShippingProvider }> {
    const record = await this.db.shipmentPackage.findUnique({
      where: { id: packageId },
      include: {
        items: { include: { shipmentItem: { include: { orderItem: true } } } },
        shipment: {
          include: {
            order: {
              include: {
                paymentAttempts: {
                  where: { provider: "COD", status: { in: ["PENDING", "PROCESSING"] } },
                },
              },
            },
            originLocation: { include: { municipality: { include: { department: true } } } },
          },
        },
      },
    });
    if (!record?.credentialId)
      throw new ShippingNotFoundError("Aveonline package or credential not found.");
    const order = record.shipment.order;
    const origin = record.shipment.originLocation;
    if (
      !origin.addressLine1 ||
      !origin.departmentCode ||
      !origin.municipalityCode ||
      !origin.municipality ||
      !origin.phoneE164 ||
      !order.recipientNameSnapshot ||
      !order.emailSnapshot ||
      !order.phoneE164Snapshot ||
      !order.buyerDocumentNumberSnapshot ||
      !order.addressLine1Snapshot ||
      !order.departmentCode ||
      !order.departmentNameSnapshot ||
      !order.municipalityCode ||
      !order.municipalityNameSnapshot
    ) {
      throw new ShippingValidationError(
        "Order and origin snapshots are incomplete for carrier label generation.",
      );
    }
    const credentials = await this.credentials(record.credentialId);
    const request: ShippingLabelRequest = {
      packageId: record.id,
      requestKey: record.requestKey,
      orderNumber: order.orderNumber,
      origin: {
        name: credentials.originLegalName,
        documentNumber: credentials.companyDocument,
        email: credentials.originEmail,
        phoneE164: origin.phoneE164,
        addressLine1: origin.addressLine1,
        neighborhood: null,
        departmentCode: origin.departmentCode,
        departmentName: origin.municipality.department.name,
        municipalityCode: origin.municipalityCode,
        municipalityName: origin.municipality.name,
      },
      destination: {
        name: order.recipientNameSnapshot,
        documentNumber: order.buyerDocumentNumberSnapshot,
        email: order.emailSnapshot,
        phoneE164: order.phoneE164Snapshot,
        addressLine1: order.addressLine1Snapshot,
        neighborhood: order.neighborhoodSnapshot,
        departmentCode: order.departmentCode,
        departmentName: order.departmentNameSnapshot,
        municipalityCode: order.municipalityCode,
        municipalityName: order.municipalityNameSnapshot,
      },
      declaredValueCents: record.declaredValueCents,
      weightGrams: record.weightGrams,
      lengthMillimeters: record.lengthMillimeters,
      widthMillimeters: record.widthMillimeters,
      heightMillimeters: record.heightMillimeters,
      cashOnDeliveryCents: order.paymentAttempts.reduce(
        (sum, attempt) => sum + attempt.amountCents,
        0n,
      ),
      contents: record.items.map((item) => ({
        sku: item.shipmentItem.orderItem.skuSnapshot,
        title: item.shipmentItem.orderItem.titleSnapshot,
        quantity: item.quantity,
        declaredValueCents: item.declaredValueCents,
      })),
    };
    return { request, provider: this.provider(credentials) };
  }

  private async persistLabel(
    packageId: string,
    result: ShippingLabelResult,
    workerId: string,
    audit?: ShippingAuditContext,
  ): Promise<LabelProcessResult> {
    return this.db.$transaction(async (tx) => {
      const record = await lockPackage(tx, packageId);
      if (["LABELLED", "SHIPPED", "DELIVERED"].includes(record.status)) {
        return {
          packageId,
          status: record.status,
          trackingCode: record.trackingCode,
          replayed: true,
        };
      }
      if (!["CLAIMED", "RECONCILING"].includes(record.status))
        throw new ShippingConflictError("Only a claimed package can accept a provider label.");
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      await tx.shipmentPackage.update({
        where: { id: packageId },
        data: {
          status: "LABELLED",
          providerReference: result.providerReference,
          trackingCode: result.trackingCode,
          labelUrl: result.labelUrl,
          labelledAt: now,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastError: null,
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: record.shipmentId,
          packageId,
          type: "LABEL_GENERATED",
          eventKey: `label-generated:${packageId}`,
          providerEventId: result.providerReference,
          metadata: { carrier: result.carrier, trackingCode: result.trackingCode },
        },
      });
      const fulfillment = await lockFulfillment(tx, record.shipmentId);
      const pending = await tx.shipmentPackage.count({
        where: {
          shipmentId: record.shipmentId,
          status: { notIn: ["LABELLED", "SHIPPED", "DELIVERED"] },
        },
      });
      if (pending === 0 && ["PACKED", "RECONCILING"].includes(fulfillment.status)) {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: "LABELLED", version: { increment: 1 } },
        });
      }
      const shipment = await lockShipment(tx, record.shipmentId);
      if (!shipment.trackingCode) {
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { trackingCode: result.trackingCode, carrier: result.carrier },
        });
      }
      await writeShippingOutbox(tx, {
        eventType: "shipping.label.generated.v1",
        aggregateType: "ShipmentPackage",
        aggregateId: packageId,
        deduplicationKey: `shipment-package:${packageId}:label-generated:v1`,
        payload: {
          orderId: fulfillment.orderId,
          shipmentId: record.shipmentId,
          packageId,
          workerId,
        },
      });
      if (audit) {
        await writeShippingAudit(tx, {
          action: "SHIPMENT_LABEL_GENERATED",
          targetType: "ShipmentPackage",
          targetId: packageId,
          audit,
          metadata: {
            orderId: fulfillment.orderId,
            shipmentId: record.shipmentId,
            providerReference: result.providerReference,
          },
        });
      }
      return { packageId, status: "LABELLED", trackingCode: result.trackingCode, replayed: false };
    });
  }

  private async failLabel(
    packageId: string,
    workerId: string,
    uncertain: boolean,
    code: string,
    audit?: ShippingAuditContext,
  ): Promise<LabelProcessResult> {
    return this.db.$transaction(async (tx) => {
      const record = await lockPackage(tx, packageId);
      if (record.status !== "CLAIMED") {
        return {
          packageId,
          status: record.status,
          trackingCode: record.trackingCode,
          replayed: true,
        };
      }
      const status: ShipmentPackageStatus = uncertain ? "RECONCILING" : "SEALED";
      await tx.shipmentPackage.update({
        where: { id: packageId },
        data: {
          status,
          claimedBy: uncertain ? record.claimedBy : null,
          claimedAt: uncertain ? record.claimedAt : null,
          claimExpiresAt: uncertain ? record.claimExpiresAt : null,
          requestStartedAt: uncertain ? record.requestStartedAt : null,
          lastError: integrationText(code, "errorCode", 200),
        },
      });
      const fulfillment = await lockFulfillment(tx, record.shipmentId);
      if (uncertain && fulfillment.status === "PACKED") {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: "RECONCILING", version: { increment: 1 } },
        });
      }
      await tx.shipmentEvent.create({
        data: {
          shipmentId: record.shipmentId,
          packageId,
          type: uncertain ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED",
          eventKey: `${uncertain ? "provider-uncertain" : "provider-rejected"}:${packageId}:${record.requestStartedAt?.toISOString() ?? workerId}`,
          metadata: { code: integrationText(code, "errorCode", 200) },
        },
      });
      if (uncertain) {
        await writeShippingOutbox(tx, {
          eventType: "shipping.provider.uncertain.v1",
          aggregateType: "ShipmentPackage",
          aggregateId: packageId,
          deduplicationKey: `shipment-package:${packageId}:provider-uncertain:v1`,
          payload: { orderId: fulfillment.orderId, shipmentId: record.shipmentId, packageId },
        });
      }
      if (audit) {
        await writeShippingAudit(tx, {
          action: uncertain ? "SHIPMENT_LABEL_MARKED_UNCERTAIN" : "SHIPMENT_LABEL_REJECTED",
          targetType: "ShipmentPackage",
          targetId: packageId,
          audit,
          metadata: {
            orderId: fulfillment.orderId,
            shipmentId: record.shipmentId,
            code: integrationText(code, "errorCode", 200),
          },
        });
      }
      return { packageId, status, trackingCode: null, replayed: false };
    });
  }

  async processLabel(
    packageId: string,
    workerIdInput: string,
    audit?: ShippingAuditContext,
  ): Promise<LabelProcessResult> {
    assertIntegrationUuid(packageId, "packageId");
    const workerId = shippingWorkerId(workerIdInput);
    const claimSeconds = this.options.claimSeconds ?? 300;
    if (!Number.isInteger(claimSeconds) || claimSeconds < 60 || claimSeconds > 900)
      throw new ShippingValidationError("claimSeconds must be between 60 and 900.");
    const claim = await this.db.$transaction(async (tx) => {
      const peek = await tx.shipmentPackage.findUnique({
        where: { id: packageId },
        select: { shipmentId: true },
      });
      if (!peek) throw new ShippingNotFoundError("Shipment package not found.");
      const fulfillment = await lockFulfillment(tx, peek.shipmentId);
      const record = await lockPackage(tx, packageId);
      if (["LABELLED", "SHIPPED", "DELIVERED"].includes(record.status))
        return { outcome: "REPLAY" as const, record };
      if (record.status === "RECONCILING") return { outcome: "UNCERTAIN" as const, record };
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      const activeClaim = record.claimExpiresAt && record.claimExpiresAt > now;
      if (record.status === "CLAIMED" && activeClaim)
        throw new ShippingConflictError("Another worker already owns this package claim.");
      if (record.status === "CLAIMED" && record.requestStartedAt) {
        await tx.shipmentPackage.update({
          where: { id: packageId },
          data: { status: "RECONCILING" },
        });
        if (fulfillment.status === "PACKED")
          await tx.orderFulfillment.update({
            where: { id: fulfillment.id },
            data: { status: "RECONCILING", version: { increment: 1 } },
          });
        return { outcome: "UNCERTAIN" as const, record };
      }
      if (record.status !== "SEALED" && record.status !== "CLAIMED")
        throw new ShippingConflictError("Package cannot be claimed in its current state.");
      const siblingClaim = await tx.shipmentPackage.findFirst({
        where: {
          shipmentId: record.shipmentId,
          id: { not: packageId },
          status: { in: ["CLAIMED", "RECONCILING"] },
        },
        select: { id: true },
      });
      if (siblingClaim) {
        throw new ShippingConflictError(
          "Another package on this shipment has an active or uncertain claim.",
          "SIBLING_CLAIM_ACTIVE",
        );
      }
      await tx.shipmentPackage.update({
        where: { id: packageId },
        data: {
          status: "CLAIMED",
          claimedBy: workerId,
          claimedAt: now,
          claimExpiresAt: new Date(now.getTime() + claimSeconds * 1000),
          requestStartedAt: null,
          lastError: null,
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: record.shipmentId,
          packageId,
          type: "LABEL_CLAIMED",
          eventKey: `label-claimed:${packageId}:${randomUUID()}`,
          metadata: { workerId },
        },
      });
      if (audit) {
        await assertFulfillmentActor(tx, audit.actorAdminUserId);
        await writeShippingAudit(tx, {
          action: "SHIPMENT_LABEL_CLAIMED",
          targetType: "ShipmentPackage",
          targetId: packageId,
          audit,
          metadata: { shipmentId: record.shipmentId, requestKey: record.requestKey },
        });
      }
      return { outcome: "CLAIMED" as const, record };
    });
    if (claim.outcome === "REPLAY")
      return {
        packageId,
        status: claim.record.status,
        trackingCode: claim.record.trackingCode,
        replayed: true,
      };
    if (claim.outcome === "UNCERTAIN")
      return { packageId, status: "RECONCILING", trackingCode: null, replayed: false };
    await this.db.$transaction(async (tx) => {
      const startedRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      await tx.shipmentPackage.updateMany({
        where: { id: packageId, status: "CLAIMED", claimedBy: workerId, requestStartedAt: null },
        data: { requestStartedAt: startedRows[0]!.now },
      });
    });
    try {
      const { request, provider } = await this.labelRequest(packageId);
      const result = await provider.createLabel(request);
      return await this.persistLabel(packageId, result, workerId, audit);
    } catch (error) {
      const uncertain =
        error instanceof ShippingProviderError &&
        ["NETWORK_UNCERTAIN", "INVALID_RESPONSE"].includes(error.code);
      const code =
        error instanceof ShippingProviderError
          ? error.code
          : error instanceof ShippingValidationError
            ? error.message
            : "PROVIDER_FAILURE";
      return this.failLabel(packageId, workerId, uncertain, code, audit);
    }
  }

  async reconcileLabel(
    packageId: string,
    workerIdInput: string,
    audit?: ShippingAuditContext,
  ): Promise<LabelProcessResult> {
    assertIntegrationUuid(packageId, "packageId");
    const workerId = shippingWorkerId(workerIdInput);
    const current = await this.db.shipmentPackage.findUnique({ where: { id: packageId } });
    if (!current) throw new ShippingNotFoundError("Shipment package not found.");
    if (["LABELLED", "SHIPPED", "DELIVERED"].includes(current.status))
      return {
        packageId,
        status: current.status,
        trackingCode: current.trackingCode,
        replayed: true,
      };
    if (current.status !== "RECONCILING")
      throw new ShippingConflictError("Only an uncertain package requires reconciliation.");
    if (audit) {
      await this.db.$transaction(async (tx) => {
        await assertFulfillmentActor(tx, audit.actorAdminUserId);
        await writeShippingAudit(tx, {
          action: "SHIPMENT_LABEL_RECONCILIATION_STARTED",
          targetType: "ShipmentPackage",
          targetId: packageId,
          audit,
        });
      });
    }
    const { provider } = await this.labelRequest(packageId);
    const result = await provider.findLabel(current.requestKey);
    if (result) return this.persistLabel(packageId, result, workerId, audit);
    return this.db.$transaction(async (tx) => {
      const record = await lockPackage(tx, packageId);
      if (record.status !== "RECONCILING")
        return {
          packageId,
          status: record.status,
          trackingCode: record.trackingCode,
          replayed: true,
        };
      await tx.shipmentPackage.update({
        where: { id: packageId },
        data: {
          status: "SEALED",
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          requestStartedAt: null,
          lastError: "PROVIDER_CONFIRMED_NOT_FOUND",
        },
      });
      const fulfillment = await lockFulfillment(tx, record.shipmentId);
      if (fulfillment.status === "RECONCILING")
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: "PACKED", version: { increment: 1 } },
        });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: record.shipmentId,
          packageId,
          type: "PROVIDER_REJECTED",
          eventKey: `provider-not-found:${packageId}:${randomUUID()}`,
          metadata: { code: "PROVIDER_CONFIRMED_NOT_FOUND" },
        },
      });
      return { packageId, status: "SEALED" as const, trackingCode: null, replayed: false };
    });
  }

  private async refreshOrder(
    tx: ShippingTransaction,
    orderId: string,
    reason: string,
  ): Promise<void> {
    const order = await lockOrder(tx, orderId);
    const shipments = await tx.shipment.findMany({ where: { orderId }, select: { status: true } });
    const active = shipments.filter((shipment) => shipment.status !== "CANCELLED");
    const shipped = active.filter((shipment) =>
      ["SHIPPED", "DELIVERED"].includes(shipment.status),
    ).length;
    const fulfillmentStatus =
      active.length > 0 && shipped === active.length
        ? "FULFILLED"
        : shipped > 0
          ? "PARTIALLY_FULFILLED"
          : "UNFULFILLED";
    if (order.fulfillmentStatus !== fulfillmentStatus) {
      await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus } });
      await tx.orderStatusEvent.create({
        data: {
          orderId,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus,
          reason,
        },
      });
    }
  }

  private async transitionShipment(
    shipmentId: string,
    target: "SHIPPED" | "DELIVERED",
    audit: ShippingAuditContext,
    driver?: { name: string; phoneE164: string },
  ): Promise<void> {
    assertIntegrationUuid(shipmentId, "shipmentId");
    await this.db.$transaction(async (tx) => {
      await assertFulfillmentActor(tx, audit.actorAdminUserId);
      const fulfillment = await lockFulfillment(tx, shipmentId);
      if (fulfillment.status !== (target === "SHIPPED" ? "LABELLED" : "SHIPPED"))
        throw new ShippingConflictError(`Fulfillment cannot transition to ${target}.`);
      const shipment = await lockShipment(tx, shipmentId);
      const packages = await tx.shipmentPackage.findMany({
        where: { shipmentId },
        orderBy: [{ packageNumber: "asc" }, { id: "asc" }],
      });
      if (
        packages.length === 0 ||
        packages.some((record) => record.status !== (target === "SHIPPED" ? "LABELLED" : "SHIPPED"))
      ) {
        throw new ShippingConflictError(
          "Every package must reach the preceding state before shipment transition.",
          "PACKAGE_INCOMPLETE",
        );
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      for (const record of packages) {
        await tx.shipmentPackage.update({
          where: { id: record.id },
          data:
            target === "SHIPPED"
              ? { status: "SHIPPED", shippedAt: now }
              : { status: "DELIVERED", deliveredAt: now },
        });
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: target, version: { increment: 1 } },
      });
      let localDriverName = shipment.localDriverName;
      let localDriverPhoneE164 = shipment.localDriverPhoneE164;
      if (
        target === "SHIPPED" &&
        fulfillment.provider === ShippingProviderCode.FLEX &&
        !localDriverName
      ) {
        if (!driver)
          throw new ShippingValidationError(
            "Flex dispatch requires verified driver identity and phone.",
          );
        localDriverName = integrationText(driver.name, "driver.name", 200, 2);
        if (!/^\+[1-9][0-9]{7,14}$/.test(driver.phoneE164))
          throw new ShippingValidationError("driver.phoneE164 must be a valid E.164 phone.");
        localDriverPhoneE164 = driver.phoneE164;
      }
      await tx.shipment.update({
        where: { id: shipmentId },
        data:
          target === "SHIPPED"
            ? { status: "SHIPPED", shippedAt: now, localDriverName, localDriverPhoneE164 }
            : { status: "DELIVERED", deliveredAt: now },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId,
          actorAdminUserId: audit.actorAdminUserId,
          type: target,
          eventKey: `${target.toLowerCase()}:${fulfillment.id}`,
          metadata: { packageCount: packages.length },
        },
      });
      await this.refreshOrder(
        tx,
        fulfillment.orderId,
        target === "SHIPPED" ? "Carrier or Flex dispatch confirmed" : "Delivery confirmed",
      );
      await writeShippingAudit(tx, {
        action: target === "SHIPPED" ? "SHIPMENT_DISPATCHED" : "SHIPMENT_DELIVERED",
        targetType: "OrderFulfillment",
        targetId: fulfillment.id,
        audit,
        metadata: { orderId: fulfillment.orderId, shipmentId, packageCount: packages.length },
      });
      await writeShippingOutbox(tx, {
        eventType:
          target === "SHIPPED" ? "shipping.shipment.shipped.v1" : "shipping.shipment.delivered.v1",
        aggregateType: "Shipment",
        aggregateId: shipmentId,
        deduplicationKey: `shipment:${shipmentId}:${target.toLowerCase()}:v1`,
        payload: { orderId: fulfillment.orderId, shipmentId },
      });
    });
  }

  async markShipped(
    shipmentId: string,
    audit: ShippingAuditContext,
    driver?: { name: string; phoneE164: string },
  ): Promise<void> {
    return this.transitionShipment(shipmentId, "SHIPPED", audit, driver);
  }

  async markDelivered(shipmentId: string, audit: ShippingAuditContext): Promise<void> {
    return this.transitionShipment(shipmentId, "DELIVERED", audit);
  }
}
