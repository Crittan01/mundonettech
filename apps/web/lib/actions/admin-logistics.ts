"use server";

import { randomUUID } from "node:crypto";

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
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { shippingService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

async function authorize() {
  const session = await getAdminSession({
    permission: "fulfillment:write",
    requireRecentMfa: true,
  });
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
  if (!/^[0-9]+$/.test(value)) throw new TypeError("Money must be integer cents.");
  return BigInt(value);
}

function coordinateE6(value: string, minimum: number, maximum: number): number {
  const match = /^(-?)([0-9]{1,3})(?:\.([0-9]{1,6}))?$/.exec(value.trim());
  if (!match) throw new TypeError("Coordinates must use at most six decimal places.");
  const scaled =
    (match[1] === "-" ? -1 : 1) *
    (Number(match[2]) * 1_000_000 + Number((match[3] ?? "").padEnd(6, "0") || 0));
  if (!Number.isSafeInteger(scaled) || scaled < minimum || scaled > maximum)
    throw new RangeError("Coordinate is outside its valid range.");
  return scaled;
}

const packageSchema = z
  .array(
    z.object({
      weightGrams: z.number().int().positive().max(10_000_000),
      lengthMillimeters: z.number().int().positive().max(100_000),
      widthMillimeters: z.number().int().positive().max(100_000),
      heightMillimeters: z.number().int().positive().max(100_000),
      items: z
        .array(
          z.object({ shipmentItemId: z.string().uuid(), quantity: z.number().int().positive() }),
        )
        .min(1),
    }),
  )
  .min(1)
  .max(1000);

export async function startPickingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    await shippingService().startPicking(
      z.string().uuid().parse(formString(formData, "shipmentId")),
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess("Alistamiento iniciado y auditado.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function packShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const packages = packageSchema.parse(JSON.parse(formString(formData, "packages")));
    const result = await shippingService().pack(
      z.string().uuid().parse(formString(formData, "shipmentId")),
      packages,
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess(`${result.packageIds.length} bultos sellados con cobertura exacta.`);
  } catch (error) {
    return failure(error, values);
  }
}

export async function processLabelAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await shippingService().processLabel(
      z.string().uuid().parse(formString(formData, "packageId")),
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidatePath("/admin/logistica");
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
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const result = await shippingService().reconcileLabel(
      z.string().uuid().parse(formString(formData, "packageId")),
      `admin:${audit.actorAdminUserId}`,
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess(
      result.status === "LABELLED"
        ? "Guía conciliada sin duplicar cobro."
        : "El proveedor confirmó que no existe la guía; el bulto puede solicitarse de nuevo.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function dispatchShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const shipmentId = z.string().uuid().parse(formString(formData, "shipmentId"));
    const driverName = formString(formData, "driverName").trim();
    const driverPhoneE164 = formString(formData, "driverPhoneE164").trim();
    const rawSerialUnitIds = formString(formData, "serialUnitIds");
    const serialUnitIds = rawSerialUnitIds
      ? z.array(z.string().uuid()).max(10_000).parse(JSON.parse(rawSerialUnitIds))
      : undefined;
    await shippingService().markShipped(
      shipmentId,
      audit,
      driverName || driverPhoneE164 ? { name: driverName, phoneE164: driverPhoneE164 } : undefined,
      serialUnitIds,
    );
    revalidatePath("/admin/logistica");
    revalidatePath("/admin/pedidos");
    revalidatePath("/admin/hoy");
    return actionSuccess(
      "Seriales asignados y despacho confirmado con eventos y notificación encolados.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function deliverShipmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    await shippingService().markDelivered(
      z.string().uuid().parse(formString(formData, "shipmentId")),
      audit,
    );
    revalidatePath("/admin/logistica");
    return actionSuccess("Entrega confirmada y evento monotónico registrado.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function saveDeliveryZoneAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
    const id = formString(formData, "zoneId");
    const expected = formString(formData, "expectedUpdatedAt");
    const municipalityCodes = formString(formData, "municipalityCodes")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    const polygon = formString(formData, "polygon")
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [latitude = "", longitude = ""] = pair.split(",");
        return {
          latitudeE6: coordinateE6(latitude, -90_000_000, 90_000_000),
          longitudeE6: coordinateE6(longitude, -180_000_000, 180_000_000),
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
        code: formString(formData, "code"),
        name: formString(formData, "name"),
        active: formString(formData, "active") === "on",
        municipalityCodes,
        polygon,
        baseFeeCents: cents(formString(formData, "baseFeeCents")),
        freeShippingThresholdCents: freeThreshold ? cents(freeThreshold) : null,
        cutoffMinutes: z.coerce
          .number()
          .int()
          .min(0)
          .max(1439)
          .parse(formString(formData, "cutoffMinutes")),
        deliveryPromiseMinutes: z.coerce
          .number()
          .int()
          .min(5)
          .max(10080)
          .parse(formString(formData, "deliveryPromiseMinutes")),
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
  const values = formSnapshot(formData);
  try {
    const audit = await authorize();
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
