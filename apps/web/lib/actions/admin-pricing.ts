"use server";

import {
  PricingConflictError,
  PricingNotFoundError,
  PricingService,
  PricingValidationError,
  type BundleInput,
  type CouponInput,
  type WholesaleTierInput,
} from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  actionError,
  actionSuccess,
  formSnapshot,
  formString,
  type ActionState,
} from "@/lib/action-state";
import { bogotaInputValue } from "@/lib/admin-pricing-presenters";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const idSchema = z.string().uuid();
const integerSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(2_147_483_647));
const optionalIdSchema = z.union([idSchema, z.literal("")]);

function integer(value: string): number | null {
  const parsed = integerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function localDate(value: string): Date | null | undefined {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}:00-05:00`);
  return Number.isNaN(parsed.getTime()) || bogotaInputValue(parsed) !== value ? undefined : parsed;
}

function slugs(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bundleItems(value: string): BundleInput["items"] | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const items: Array<{ sku: string; quantity: number }> = [];
  for (const line of lines) {
    const match = /^([^|]+)\|([0-9]+)$/.exec(line);
    const quantity = match?.[2] ? integer(match[2]) : null;
    if (!match?.[1] || quantity === null || quantity < 1) return null;
    items.push({ sku: match[1].trim(), quantity });
  }
  return items;
}

async function auditContext() {
  const session = await getAdminSession({ permission: "pricing:write", requireRecentMfa: true });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash,
  };
}

function invalidate(): void {
  updateTag("catalog");
  updateTag("catalog:search");
  updateTag("catalog:compare");
  updateTag("catalog:cms-grid");
  revalidatePath("/admin/precios");
}

function message(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError(
      "Confirma tu autenticador antes de modificar precios o promociones.",
      values,
    );
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para esta mutación comercial.", values);
  }
  if (error instanceof PricingConflictError) {
    return error.message.includes("composition")
      ? actionError(
          "No puedes cambiar la composición de un bundle presente en carritos activos. Archívalo y crea una versión nueva.",
          values,
        )
      : actionError(
          "Ya existe un registro activo con el mismo alcance, cantidad, código o slug. Revisa los datos sin perder el formulario.",
          values,
        );
  }
  if (error instanceof PricingNotFoundError) {
    return actionError(
      "No se encontró una referencia o el registro ya fue archivado. Revisa SKU/slugs y recarga.",
      values,
    );
  }
  if (
    error instanceof PricingValidationError ||
    error instanceof RangeError ||
    error instanceof TypeError
  ) {
    return actionError(
      "Revisa montos enteros no negativos, referencias, cantidades, fechas y límites. Ningún cambio fue aplicado.",
      values,
    );
  }
  return actionError(
    "No pudimos guardar el cambio. La transacción se revirtió completa; inténtalo de nuevo.",
    values,
  );
}

export async function saveWholesaleTierAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const id = formString(formData, "id");
  const minimumQuantity = integer(formString(formData, "minimumQuantity"));
  const scope = formString(formData, "scope");
  if (
    !optionalIdSchema.safeParse(id).success ||
    minimumQuantity === null ||
    minimumQuantity < 1 ||
    !["GLOBAL", "CATEGORY", "PRODUCT", "VARIANT"].includes(scope)
  )
    return actionError("Revisa el alcance, la referencia y la cantidad mínima.", values);
  const input: WholesaleTierInput = {
    scope: scope as WholesaleTierInput["scope"],
    target: formString(formData, "target"),
    minimumQuantity,
    unitPriceCents: formString(formData, "unitPriceCents"),
    active: formString(formData, "active") === "on" || formString(formData, "active") === "true",
  };
  let createdId: string;
  try {
    const audit = await auditContext();
    const saved = await new PricingService(getDatabase()).upsertWholesaleTier(
      id || null,
      input,
      audit,
    );
    invalidate();
    if (id) return actionSuccess("Escala mayorista actualizada y auditoría registrada.");
    createdId = saved.id;
  } catch (error) {
    return message(error, values);
  }
  redirect(`/admin/precios/mayoristas/${createdId}?creado=1`);
}

export async function saveCouponAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const id = formString(formData, "id");
  const discountType = formString(formData, "discountType");
  const status = formString(formData, "status");
  const startsAt = localDate(formString(formData, "startsAt"));
  const endsAt = localDate(formString(formData, "endsAt"));
  const percentageBps = formString(formData, "percentageBps")
    ? integer(formString(formData, "percentageBps"))
    : undefined;
  const maximumUsages = formString(formData, "maximumUsages")
    ? integer(formString(formData, "maximumUsages"))
    : undefined;
  const perCustomerUsages = formString(formData, "perCustomerUsages")
    ? integer(formString(formData, "perCustomerUsages"))
    : undefined;
  if (
    !optionalIdSchema.safeParse(id).success ||
    !["PERCENTAGE", "FIXED_AMOUNT"].includes(discountType) ||
    !["DRAFT", "ACTIVE"].includes(status) ||
    startsAt === undefined ||
    endsAt === undefined ||
    percentageBps === null ||
    maximumUsages === null ||
    perCustomerUsages === null
  )
    return actionError("Revisa tipo, estado, fechas, porcentaje y límites del cupón.", values);
  const input: CouponInput = {
    code: formString(formData, "code"),
    name: formString(formData, "name"),
    discountType: discountType as CouponInput["discountType"],
    status: status as CouponInput["status"],
    ...(percentageBps !== undefined ? { percentageBps } : {}),
    amountCents: formString(formData, "amountCents"),
    maximumDiscountCents: formString(formData, "maximumDiscountCents"),
    minimumSubtotalCents: formString(formData, "minimumSubtotalCents"),
    startsAt,
    endsAt,
    ...(maximumUsages !== undefined ? { maximumUsages } : {}),
    ...(perCustomerUsages !== undefined ? { perCustomerUsages } : {}),
    productSlugs: slugs(formString(formData, "productSlugs")),
    categorySlugs: slugs(formString(formData, "categorySlugs")),
  };
  let createdId: string;
  try {
    const audit = await auditContext();
    const saved = await new PricingService(getDatabase()).upsertCoupon(id || null, input, audit);
    invalidate();
    if (id) return actionSuccess("Cupón actualizado con referencias y límites persistentes.");
    createdId = saved.id;
  } catch (error) {
    return message(error, values);
  }
  redirect(`/admin/precios/cupones/${createdId}?creado=1`);
}

export async function saveBundleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const id = formString(formData, "id");
  const status = formString(formData, "status");
  const items = bundleItems(formString(formData, "items"));
  if (!optionalIdSchema.safeParse(id).success || !["DRAFT", "ACTIVE"].includes(status) || !items) {
    return actionError(
      "Cada componente debe usar una línea con el formato SKU | cantidad positiva.",
      values,
    );
  }
  const input: BundleInput = {
    slug: formString(formData, "slug"),
    name: formString(formData, "name"),
    description: formString(formData, "description"),
    status: status as BundleInput["status"],
    priceCents: formString(formData, "priceCents"),
    discountCents: formString(formData, "discountCents"),
    items,
  };
  let createdId: string;
  try {
    const audit = await auditContext();
    const saved = await new PricingService(getDatabase()).upsertBundle(id || null, input, audit);
    invalidate();
    if (id)
      return actionSuccess(
        "Bundle actualizado; carritos existentes conservan protección de composición.",
      );
    createdId = saved.id;
  } catch (error) {
    return message(error, values);
  }
  redirect(`/admin/precios/bundles/${createdId}?creado=1`);
}

export async function archivePricingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  const id = formString(formData, "id");
  const kind = formString(formData, "kind");
  if (!idSchema.safeParse(id).success || !["mayoristas", "cupones", "bundles"].includes(kind)) {
    return actionError("El registro que intentas archivar no es válido.", values);
  }
  try {
    const audit = await auditContext();
    const service = new PricingService(getDatabase());
    if (kind === "mayoristas") await service.archiveWholesaleTier(id, audit);
    else if (kind === "cupones") await service.archiveCoupon(id, audit);
    else await service.archiveBundle(id, audit);
    invalidate();
  } catch (error) {
    return message(error, values);
  }
  redirect(`/admin/precios?vista=${kind}&archivado=1`);
}
