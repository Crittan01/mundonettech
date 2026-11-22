import {
  assertDeliveryPoint,
  assertDeliveryPolygon,
  assertMoney,
  localDeliveryPromise,
  pointInDeliveryPolygon,
  type DeliveryPoint,
} from "@mundonettech/core";

import { Prisma, type LocalDeliveryZone, type PrismaClient } from "./generated/client.js";
import { assertUuid, compareStrings } from "./inventory-shared.js";

export class LocalDeliveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDeliveryValidationError";
  }
}

export class LocalDeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDeliveryConflictError";
  }
}

export class LocalDeliveryNotFoundError extends Error {
  constructor(message = "Local delivery zone not found.") {
    super(message);
    this.name = "LocalDeliveryNotFoundError";
  }
}

export interface LocalDeliveryZoneInput {
  readonly id?: string;
  readonly expectedUpdatedAt?: Date;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly municipalityCodes: readonly string[];
  readonly polygon: readonly DeliveryPoint[];
  readonly baseFeeCents: bigint;
  readonly freeShippingThresholdCents: bigint | null;
  readonly cutoffMinutes: number;
  readonly deliveryPromiseMinutes: number;
}

export interface DeliveryMutationAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface LocalDeliveryQuote {
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly zoneUpdatedAt: Date;
  readonly shippingCents: bigint;
  readonly deliveryPromiseAt: Date;
}

function text(value: string, field: string, maximum: number, minimum = 1): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LocalDeliveryValidationError(
      `${field} must be trimmed and contain ${minimum} to ${maximum} printable characters.`,
    );
  }
  return value;
}

function auditHash(
  value: Uint8Array | null | undefined,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new LocalDeliveryValidationError(`${field} must contain 32 bytes.`);
  return Uint8Array.from(value);
}

function zonePolygon(value: unknown): readonly DeliveryPoint[] {
  if (!Array.isArray(value))
    throw new LocalDeliveryValidationError("Stored delivery polygon is invalid.");
  try {
    return assertDeliveryPolygon(
      value.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
          throw new Error("point required");
        const point = entry as Record<string, unknown>;
        if (typeof point.latitudeE6 !== "number" || typeof point.longitudeE6 !== "number")
          throw new Error("coordinates required");
        return { latitudeE6: point.latitudeE6, longitudeE6: point.longitudeE6 };
      }),
    );
  } catch (error) {
    if (error instanceof LocalDeliveryValidationError) throw error;
    throw new LocalDeliveryValidationError("Stored delivery polygon is invalid.");
  }
}

function municipalityCodes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((code) => typeof code !== "string" || !/^[0-9]{5}$/.test(code))
  ) {
    throw new LocalDeliveryValidationError(
      "municipalityCodes must be a non-empty array of five-digit DANE codes.",
    );
  }
  const codes = value as string[];
  if (new Set(codes).size !== codes.length)
    throw new LocalDeliveryValidationError("municipalityCodes cannot contain duplicates.");
  return [...codes].sort(compareStrings);
}

export function quoteLocalDeliveryZone(
  zone: LocalDeliveryZone,
  options: {
    readonly municipalityCode: string;
    readonly point: DeliveryPoint;
    readonly merchandiseTotalCents: bigint;
    readonly now: Date;
    readonly timeZone: string;
  },
): LocalDeliveryQuote {
  if (!zone.active || zone.deletedAt)
    throw new LocalDeliveryConflictError("Local delivery zone is not active.");
  if (
    !municipalityCodes(zone.municipalityCodes).includes(options.municipalityCode) ||
    !pointInDeliveryPolygon(assertDeliveryPoint(options.point), zonePolygon(zone.polygon))
  ) {
    throw new LocalDeliveryConflictError("The destination is outside this local delivery zone.");
  }
  assertMoney(options.merchandiseTotalCents, "merchandiseTotalCents");
  const shippingCents =
    zone.freeShippingThresholdCents !== null &&
    options.merchandiseTotalCents >= zone.freeShippingThresholdCents
      ? 0n
      : zone.baseFeeCents;
  return {
    zoneId: zone.id,
    zoneCode: zone.code,
    zoneUpdatedAt: zone.updatedAt,
    shippingCents,
    deliveryPromiseAt: localDeliveryPromise({
      now: options.now,
      cutoffMinutes: zone.cutoffMinutes,
      deliveryPromiseMinutes: zone.deliveryPromiseMinutes,
      timeZone: options.timeZone,
    }),
  };
}

export class LocalDeliveryService {
  constructor(private readonly db: PrismaClient) {}

  async list(includeArchived = false): Promise<readonly LocalDeliveryZone[]> {
    return this.db.localDeliveryZone.findMany({
      where: includeArchived ? {} : { deletedAt: null },
      orderBy: [{ code: "asc" }, { createdAt: "asc" }],
      take: 1000,
    });
  }

  async save(
    input: LocalDeliveryZoneInput,
    audit: DeliveryMutationAudit,
  ): Promise<LocalDeliveryZone> {
    assertUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (audit.requestId !== undefined) assertUuid(audit.requestId, "requestId");
    const actor = await this.db.adminUser.findFirst({
      where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"].includes(actor.role))
      throw new LocalDeliveryValidationError(
        "Administrator is not authorized to manage delivery zones.",
      );
    const code = text(input.code, "code", 40, 2).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code))
      throw new LocalDeliveryValidationError(
        "code must use uppercase letters, digits, dashes or underscores.",
      );
    const name = text(input.name, "name", 120, 2);
    const municipalities = municipalityCodes(input.municipalityCodes);
    const polygon = assertDeliveryPolygon(input.polygon);
    assertMoney(input.baseFeeCents, "baseFeeCents");
    if (input.freeShippingThresholdCents !== null)
      assertMoney(input.freeShippingThresholdCents, "freeShippingThresholdCents");
    if (
      !Number.isInteger(input.cutoffMinutes) ||
      input.cutoffMinutes < 0 ||
      input.cutoffMinutes > 1439
    )
      throw new LocalDeliveryValidationError("cutoffMinutes must be between 0 and 1439.");
    if (
      !Number.isInteger(input.deliveryPromiseMinutes) ||
      input.deliveryPromiseMinutes < 5 ||
      input.deliveryPromiseMinutes > 10080
    )
      throw new LocalDeliveryValidationError("deliveryPromiseMinutes must be between 5 and 10080.");
    const existingMunicipalities = await this.db.daneMunicipality.count({
      where: { code: { in: [...municipalities] } },
    });
    if (existingMunicipalities !== municipalities.length)
      throw new LocalDeliveryValidationError(
        "Every local delivery municipality must exist in the DANE catalog.",
      );
    return this.db.$transaction(async (tx) => {
      const data = {
        code,
        name,
        active: input.active,
        municipalityCodes: [...municipalities],
        polygon: polygon.map((point) => ({
          latitudeE6: point.latitudeE6,
          longitudeE6: point.longitudeE6,
        })),
        baseFeeCents: input.baseFeeCents,
        freeShippingThresholdCents: input.freeShippingThresholdCents,
        cutoffMinutes: input.cutoffMinutes,
        deliveryPromiseMinutes: input.deliveryPromiseMinutes,
        updatedByAdminUserId: audit.actorAdminUserId,
      };
      let saved: LocalDeliveryZone;
      if (input.id) {
        assertUuid(input.id, "id");
        if (
          !(input.expectedUpdatedAt instanceof Date) ||
          Number.isNaN(input.expectedUpdatedAt.getTime())
        )
          throw new LocalDeliveryValidationError(
            "expectedUpdatedAt is required when editing a zone.",
          );
        const updated = await tx.localDeliveryZone.updateMany({
          where: { id: input.id, updatedAt: input.expectedUpdatedAt, deletedAt: null },
          data,
        });
        if (updated.count !== 1)
          throw new LocalDeliveryConflictError(
            "The zone changed concurrently or is archived; reload before saving.",
          );
        saved = await tx.localDeliveryZone.findUniqueOrThrow({ where: { id: input.id } });
      } else {
        try {
          saved = await tx.localDeliveryZone.create({
            data: { ...data, createdByAdminUserId: audit.actorAdminUserId },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
            throw new LocalDeliveryConflictError("An active zone already uses this code.");
          throw error;
        }
      }
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: input.id ? "LOCAL_DELIVERY_ZONE_UPDATED" : "LOCAL_DELIVERY_ZONE_CREATED",
          targetType: "LocalDeliveryZone",
          targetId: saved.id,
          requestId: audit.requestId ?? null,
          ipHash: auditHash(audit.ipHash, "ipHash"),
          userAgentHash: auditHash(audit.userAgentHash, "userAgentHash"),
          metadata: {
            code,
            active: saved.active,
            baseFeeCents: saved.baseFeeCents.toString(),
            version: saved.updatedAt.toISOString(),
          },
        },
      });
      return saved;
    });
  }

  async archive(id: string, expectedUpdatedAt: Date, audit: DeliveryMutationAudit): Promise<void> {
    assertUuid(id, "id");
    if (!(expectedUpdatedAt instanceof Date) || Number.isNaN(expectedUpdatedAt.getTime()))
      throw new LocalDeliveryValidationError("expectedUpdatedAt must be valid.");
    await this.db.$transaction(async (tx) => {
      const actor = await tx.adminUser.findFirst({
        where: { id: audit.actorAdminUserId, status: "ACTIVE", deletedAt: null },
        select: { role: true },
      });
      if (!actor || !["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"].includes(actor.role)) {
        throw new LocalDeliveryValidationError(
          "Administrator is not authorized to archive delivery zones.",
        );
      }
      const updated = await tx.localDeliveryZone.updateMany({
        where: { id, updatedAt: expectedUpdatedAt, deletedAt: null },
        data: {
          active: false,
          deletedAt: new Date(),
          updatedByAdminUserId: audit.actorAdminUserId,
        },
      });
      if (updated.count !== 1)
        throw new LocalDeliveryConflictError(
          "The zone changed concurrently or is already archived.",
        );
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: "LOCAL_DELIVERY_ZONE_ARCHIVED",
          targetType: "LocalDeliveryZone",
          targetId: id,
          requestId: audit.requestId ?? null,
          ipHash: auditHash(audit.ipHash, "ipHash"),
          userAgentHash: auditHash(audit.userAgentHash, "userAgentHash"),
          metadata: {},
        },
      });
    });
  }

  quote(
    zoneId: string,
    options: Omit<Parameters<typeof quoteLocalDeliveryZone>[1], "now"> & { now?: Date },
  ): Promise<LocalDeliveryQuote> {
    assertUuid(zoneId, "zoneId");
    return this.db.localDeliveryZone.findUnique({ where: { id: zoneId } }).then((zone) => {
      if (!zone) throw new LocalDeliveryNotFoundError();
      return quoteLocalDeliveryZone(zone, { ...options, now: options.now ?? new Date() });
    });
  }
}
