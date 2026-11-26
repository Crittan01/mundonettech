"use server";

import { randomUUID } from "node:crypto";

import { parseCoordinateE6 as coordinateE6 } from "@mundonettech/core";
import {
  LocalDeliveryConflictError,
  LocalDeliveryService,
  LocalDeliveryValidationError,
} from "@mundonettech/db";
import {
  ShippingAuthorizationError,
  ShippingConflictError,
  ShippingNotFoundError,
  ShippingProviderError,
  ShippingValidationError,
} from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formEntries,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { shippingService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const snapshotFields = new Set([
  "code",
  "active",
  "baseFeeCents",
  "freeShippingThresholdCents",
  "cutoffMinutes",
  "deliveryPromiseMinutes",
]);
function safeSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(
      ([key, value]) => snapshotFields.has(key) && value.length <= 256,
    ),
  );
}

function assertClosedForm(formData: FormData, allowedFields: readonly string[]): void {
  const shape: Record<string, z.ZodOptional<z.ZodString>> = {};
  const values: Record<string, string> = {};
  for (const field of allowedFields) shape[field] = z.string().optional();
  for (const [key, value] of formEntries(formData)) {
    if (typeof value !== "string" || Object.hasOwn(values, key)) {
      throw new TypeError("Form fields must be unique strings.");
    }
    values[key] = value;
  }
  z.object(shape).strict().parse(values);
}

async function authorize(
  formData: FormData,
  allowedFields: readonly string[],
  requireDeliveryZoneManager = false,
) {
  const session = await getAdminSession({
    permission: "fulfillment:write",
    requireRecentMfa: true,
  });
  if (
    requireDeliveryZoneManager &&
    !["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"].includes(session.profile.role)
  ) {
    throw new AdminAuthorizationError("FORBIDDEN");
  }
  assertClosedForm(formData, allowedFields);
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
    requestId: randomUUID(),
  };
}

function failure(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador antes de cambiar la operación logística.", values);
  if (error instanceof AdminAuthorizationError || error instanceof ShippingAuthorizationError)
    return actionError("Tu sesión no está autorizada para esta operación logística.", values);
  if (error instanceof LocalDeliveryConflictError)
    return actionError(
      "La zona cambió en otra sesión o perdió cobertura. Recarga antes de continuar.",
      values,
    );
  if (error instanceof ShippingConflictError) {
    const messages = {
      PACKAGE_INCOMPLETE: "Los bultos deben cubrir exactamente cantidades y valores de cada línea.",
      PROVIDER_UNCERTAIN:
        "El resultado externo es incierto. Ejecuta conciliación antes de reintentar.",
      ZONE_UNAVAILABLE: "La zona Flex no está disponible o perdió cobertura.",
      IDEMPOTENCY_CONFLICT:
        "La operación ya existe o cambió en otra sesión. Recarga antes de continuar.",
      SERIAL_ASSIGNMENT_INCOMPLETE:
        "Selecciona seriales vendidos de este pedido, bodega y variante hasta cubrir exactamente cada cantidad.",
      SIBLING_CLAIM_ACTIVE:
        "Otro bulto de este envío tiene una solicitud o conciliación activa. Concilia o termina ese bulto antes de continuar.",
      INVALID_STATE: "El estado logístico cambió. Recarga y revisa la operación.",
    } as const;
    return actionError(
      messages[error.code as keyof typeof messages] ??
        "El estado logístico cambió. Recarga y revisa.",
      values,
    );
  }
  if (error instanceof ShippingProviderError)
    return actionError(
      "El proveedor no confirmó un resultado válido. Revisa conciliación antes de reintentar.",
      values,
    );
  if (error instanceof ShippingNotFoundError)
    return actionError("El envío o bulto ya no está disponible.", values);
  if (
    error instanceof ShippingValidationError ||
    error instanceof LocalDeliveryValidationError ||
    error instanceof z.ZodError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return actionError(
      "Revisa identificadores, medidas enteras, cantidades, coordenadas, tarifas y campos obligatorios.",
      values,
    );
  }
  return actionError(
    "No pudimos completar la operación logística. Recarga e inténtalo de nuevo.",
    values,
  );
}

function cents(value: string): bigint {
  if (!/^[0-9]{1,19}$/.test(value)) throw new TypeError("Money must be integer cents.");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new RangeError("Money exceeds BIGINT.");
  return parsed;
}

function integer(value: string, minimum: number, maximum: number): number {
  const normalized = z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,9})$/)
    .parse(value);
  return z.number().int().min(minimum).max(maximum).parse(Number(normalized));
}

const packageSchema = z
  .array(
    z
      .object({
        weightGrams: z.number().int().positive().max(10_000_000),
        lengthMillimeters: z.number().int().positive().max(100_000),
        widthMillimeters: z.number().int().positive().max(100_000),
        heightMillimeters: z.number().int().positive().max(100_000),
        items: z
          .array(
            z
              .object({
                shipmentItemId: z.string().uuid(),
                quantity: z.number().int().positive().max(1_000_000_000),
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      })
      .strict(),
  )
  .min(1)
  .max(1000);

function revalidateLogistics(orderId?: string | null): void {
  revalidatePath("/admin/logistica");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/hoy");
  if (orderId) revalidatePath(`/admin/pedidos/${orderId}`);
}

interface OptionalLogisticsLookupDb {
  shipment?: {
    findUnique?: (args: {
      where: { id: string };
      select: { orderId: true };
    }) => Promise<{ orderId: string } | null>;
  };
  shipmentPackage?: {
    findUnique?: (args: {
      where: { id: string };
      select: { shipment: { select: { orderId: true } } };
    }) => Promise<{ shipment: { orderId: string } } | null>;
  };
}

async function resolveShipmentOrderId(shipmentId: string): Promise<string | null> {
  const db = getDatabase() as unknown as OptionalLogisticsLookupDb;
  const shipment = await db.shipment?.findUnique?.({
    where: { id: shipmentId },
    select: { orderId: true },
  });
  return shipment?.orderId ?? null;
}

async function resolvePackageOrderId(packageId: string): Promise<string | null> {
  const db = getDatabase() as unknown as OptionalLogisticsLookupDb;
  const pkg = await db.shipmentPackage?.findUnique?.({
    where: { id: packageId },
    select: { shipment: { select: { orderId: true } } },
  });
  return pkg?.shipment.orderId ?? null;
}

export async function startPickingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["shipmentId"]);
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    await shippingService().startPicking(shipmentId, audit);
    revalidateLogistics(await resolveShipmentOrderId(shipmentId));
    return actionSuccess("Alistamiento iniciado y auditado.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function packShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["shipmentId", "packages"]);
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    const packages = packageSchema.parse(
      JSON.parse(z.string().max(2_000_000).parse(formString(formData, "packages"))),
    );
    const result = await shippingService().pack(shipmentId, packages, audit);
    revalidateLogistics(await resolveShipmentOrderId(shipmentId));
    return actionSuccess(`${result.packageIds.length} bultos sellados con cobertura exacta.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function processLabelAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["packageId"]);
    const packageId = z.string().uuid().parse(formString(formData, "packageId"));
    const result = await shippingService().processLabel(
      packageId,
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidateLogistics(await resolvePackageOrderId(packageId));
    return actionSuccess(
      result.status === "LABELLED"
        ? `Guía ${result.trackingCode} persistida.`
        : `Resultado ${result.status}: revisa el siguiente paso antes de reintentar.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function reconcileLabelAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["packageId"]);
    const packageId = z.string().uuid().parse(formString(formData, "packageId"));
    const result = await shippingService().reconcileLabel(
      packageId,
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidateLogistics(await resolvePackageOrderId(packageId));
    return actionSuccess(
      result.status === "LABELLED"
        ? "Guía conciliada sin duplicar cobro."
        : result.status === "SEALED"
          ? "El proveedor confirmó que no existe la guía; el bulto puede solicitarse de nuevo."
          : `Resultado ${result.status}: el intento cambió durante la conciliación; recarga antes de continuar.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function assignShipmentSerialsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["shipmentId", "serialUnitIds"]);
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    const serialUnitIds = z
      .array(z.string().uuid())
      .max(10_000)
      .parse(
        JSON.parse(
          z
            .string()
            .max(500_000)
            .parse(formString(formData, "serialUnitIds") || "[]"),
        ),
      );
    const count = await shippingService().assignSerialUnits(shipmentId, serialUnitIds, audit);
    revalidateLogistics(await resolveShipmentOrderId(shipmentId));
    return actionSuccess(`${count} seriales asignados al envío y auditados.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function dispatchShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, [
      "shipmentId",
      "driverName",
      "driverPhoneE164",
      "serialUnitIds",
    ]);
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    const driverName = z.string().max(200).parse(formString(formData, "driverName")).trim();
    const driverPhoneE164 = z
      .string()
      .max(16)
      .parse(formString(formData, "driverPhoneE164"))
      .trim();
    const rawSerialUnitIds = z.string().max(500_000).parse(formString(formData, "serialUnitIds"));
    const serialUnitIds = rawSerialUnitIds
      ? z.array(z.string().uuid()).max(10_000).parse(JSON.parse(rawSerialUnitIds))
      : undefined;
    await shippingService().markShipped(
      shipmentId,
      audit,
      driverName || driverPhoneE164 ? { name: driverName, phoneE164: driverPhoneE164 } : undefined,
      serialUnitIds,
    );
    revalidateLogistics(await resolveShipmentOrderId(shipmentId));
    return actionSuccess(
      serialUnitIds?.length
        ? "Seriales asignados y despacho confirmado con eventos y notificación encolados."
        : "Despacho confirmado con eventos y notificación encolados.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function deliverShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["shipmentId"]);
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    await shippingService().markDelivered(shipmentId, audit);
    revalidateLogistics(await resolveShipmentOrderId(shipmentId));
    return actionSuccess("Entrega confirmada y evento monotónico registrado.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function saveDeliveryZoneAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(
      formData,
      [
        "zoneId",
        "expectedUpdatedAt",
        "code",
        "name",
        "active",
        "municipalityCodes",
        "polygon",
        "baseFeeCents",
        "freeShippingThresholdCents",
        "cutoffMinutes",
        "deliveryPromiseMinutes",
      ],
      true,
    );
    const id = formString(formData, "zoneId");
    const expected = formString(formData, "expectedUpdatedAt");
    const municipalityCodes = z
      .array(z.string().regex(/^[0-9]{5}$/))
      .min(1)
      .max(1122)
      .parse(
        formString(formData, "municipalityCodes")
          .split(",")
          .map((code) => code.trim())
          .filter(Boolean),
      );
    const polygon = z
      .array(z.string())
      .min(3)
      .max(500)
      .parse(
        formString(formData, "polygon")
          .split(";")
          .map((pair) => pair.trim())
          .filter(Boolean),
      )
      .map((pair) => {
        const [latitude = "", longitude = ""] = pair.split(",");
        return {
          latitudeE6: coordinateE6(latitude, "latitudeE6", -90_000_000, 90_000_000),
          longitudeE6: coordinateE6(longitude, "longitudeE6", -180_000_000, 180_000_000),
        };
      });
    const freeThreshold = formString(formData, "freeShippingThresholdCents");
    await new LocalDeliveryService(getDatabase()).save(
      {
        ...(id
          ? {
              id: z.string().uuid().parse(id),
              expectedUpdatedAt: new Date(z.string().datetime().parse(expected)),
            }
          : {}),
        code: z.string().min(2).max(40).parse(formString(formData, "code")),
        name: z.string().min(2).max(120).parse(formString(formData, "name")),
        active: z.enum(["", "on"]).parse(formString(formData, "active")) === "on",
        municipalityCodes,
        polygon,
        baseFeeCents: cents(formString(formData, "baseFeeCents")),
        freeShippingThresholdCents: freeThreshold ? cents(freeThreshold) : null,
        cutoffMinutes: integer(formString(formData, "cutoffMinutes"), 0, 1439),
        deliveryPromiseMinutes: integer(formString(formData, "deliveryPromiseMinutes"), 5, 10080),
      },
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess(
      id
        ? "Zona Flex actualizada con control optimista."
        : "Zona Flex creada y disponible para cotización.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function archiveDeliveryZoneAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = safeSnapshot(formData);
  try {
    const audit = await authorize(formData, ["zoneId", "expectedUpdatedAt"], true);
    await new LocalDeliveryService(getDatabase()).archive(
      z.string().uuid().parse(formString(formData, "zoneId")),
      new Date(z.string().datetime().parse(formString(formData, "expectedUpdatedAt"))),
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess("Zona archivada sin alterar envíos históricos.");
  } catch (error) {
    return failure(error, values);
  }
}
