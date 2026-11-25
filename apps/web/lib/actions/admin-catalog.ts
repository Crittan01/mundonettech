"use server";

import {
  AdminActorAuthorizationError,
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogQueryError,
  CatalogService,
  type CatalogProductBaseInput,
  type CatalogVariantInput,
} from "@mundonettech/db";
import {
  ProductMediaNotFoundError,
  ProductMediaService,
  ProductMediaValidationError,
  type ProductMediaAudit,
} from "@mundonettech/media";
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
import { getDatabase } from "@/lib/db";
import {
  AdminAuthorizationError,
  getAdminSession,
  type AdminSession,
} from "@/lib/security/admin-auth";
import {
  getRequestSecurityContext,
  type RequestSecurityContext,
} from "@/lib/security/request-context";

const baseSchema = z.object({
  slug: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  shortDescription: z.string().max(500),
  description: z.string().max(50_000),
  brandId: z.string().uuid(),
  categoryId: z.string().uuid(),
  taxGroupId: z.string().uuid(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  authenticity: z.enum(["ORIGINAL", "CERTIFIED_COMPATIBLE", "OEM"]),
  retractPolicy: z.enum(["STANDARD", "LEGAL_EXCEPTION_REVIEW"]),
  warrantyMonths: z
    .string()
    .regex(/^[0-9]+$/)
    .max(4),
  seoTitle: z.string().max(200),
  seoDescription: z.string().max(300),
});

const variantSchema = z.object({
  sku: z.string().trim().min(2).max(64),
  priceCents: z
    .string()
    .regex(/^[0-9]+$/)
    .max(19),
  costCents: z
    .string()
    .regex(/^[0-9]+$/)
    .max(19),
  compareAtPriceCents: z.string().max(19),
  gtin: z.string().max(18),
  ean: z.string().max(13),
  mpn: z.string().max(64),
  weightGrams: z
    .string()
    .regex(/^[0-9]+$/)
    .max(10),
  lengthMillimeters: z
    .string()
    .regex(/^[0-9]+$/)
    .max(10),
  widthMillimeters: z
    .string()
    .regex(/^[0-9]+$/)
    .max(10),
  heightMillimeters: z
    .string()
    .regex(/^[0-9]+$/)
    .max(10),
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

function formBoolean(formData: FormData, key: string): boolean | null {
  const value = formString(formData, key);
  if (value === "" || value === "false") return false;
  if (value === "on" || value === "true") return true;
  return null;
}

function baseInput(formData: FormData): CatalogProductBaseInput | null {
  const parsed = baseSchema.safeParse({
    slug: formString(formData, "slug"),
    name: formString(formData, "name"),
    shortDescription: formString(formData, "shortDescription"),
    description: formString(formData, "description"),
    brandId: formString(formData, "brandId"),
    categoryId: formString(formData, "categoryId"),
    taxGroupId: formString(formData, "taxGroupId"),
    status: formString(formData, "status"),
    authenticity: formString(formData, "authenticity"),
    retractPolicy: formString(formData, "retractPolicy"),
    warrantyMonths: formString(formData, "warrantyMonths"),
    seoTitle: formString(formData, "seoTitle"),
    seoDescription: formString(formData, "seoDescription"),
  });
  const trackSerial = formBoolean(formData, "trackSerial");
  if (!parsed.success || trackSerial === null) return null;
  return {
    ...parsed.data,
    warrantyMonths: Number(parsed.data.warrantyMonths),
    trackSerial,
  };
}

function variantInput(formData: FormData): CatalogVariantInput | null {
  const parsed = variantSchema.safeParse({
    sku: formString(formData, "sku"),
    priceCents: formString(formData, "priceCents"),
    costCents: formString(formData, "costCents"),
    compareAtPriceCents: formString(formData, "compareAtPriceCents"),
    gtin: formString(formData, "gtin"),
    ean: formString(formData, "ean"),
    mpn: formString(formData, "mpn"),
    weightGrams: formString(formData, "weightGrams"),
    lengthMillimeters: formString(formData, "lengthMillimeters"),
    widthMillimeters: formString(formData, "widthMillimeters"),
    heightMillimeters: formString(formData, "heightMillimeters"),
    status: formString(formData, "status"),
  });
  const variantId = formString(formData, "variantId");
  const isDefault = formBoolean(formData, "isDefault");
  if (
    !parsed.success ||
    isDefault === null ||
    (variantId && !z.string().uuid().safeParse(variantId).success)
  ) {
    return null;
  }
  return {
    ...parsed.data,
    ...(variantId ? { id: variantId } : {}),
    weightGrams: Number(parsed.data.weightGrams),
    lengthMillimeters: Number(parsed.data.lengthMillimeters),
    widthMillimeters: Number(parsed.data.widthMillimeters),
    heightMillimeters: Number(parsed.data.heightMillimeters),
    isDefault,
  };
}

const catalogSnapshotFields = new Set([
  "productId",
  "variantId",
  "slug",
  "name",
  "shortDescription",
  "description",
  "brandId",
  "categoryId",
  "taxGroupId",
  "status",
  "authenticity",
  "retractPolicy",
  "warrantyMonths",
  "trackSerial",
  "seoTitle",
  "seoDescription",
  "sku",
  "priceCents",
  "compareAtPriceCents",
  "gtin",
  "ean",
  "mpn",
  "weightGrams",
  "lengthMillimeters",
  "widthMillimeters",
  "heightMillimeters",
  "isDefault",
  "attributeId",
  "attributeValueId",
  "value",
  "deviceId",
  "fit",
  "notes",
  "altText",
  "mediaId",
  "position",
]);

function catalogSnapshot(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formSnapshot(formData)).filter(([key]) => catalogSnapshotFields.has(key)),
  );
}

function mutationMessage(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de guardar este cambio.", values);
  }
  if (error instanceof AdminAuthorizationError || error instanceof AdminActorAuthorizationError) {
    return actionError("Tu sesión no está autorizada para modificar el catálogo.", values);
  }
  if (error instanceof CatalogConflictError) {
    if (error.code === "SERIAL_TRACKING_LOCKED") {
      return actionError(
        "No puedes cambiar el control por serial/IMEI porque este producto ya tiene registros en inventario.",
        values,
      );
    }
    if (error.code === "INVENTORY_LIFECYCLE_LOCKED") {
      return actionError(
        "No puedes archivar un registro con stock activo, unidades serializadas u órdenes de compra abiertas.",
        values,
      );
    }
    return actionError(
      "El slug, SKU, GTIN, EAN o atributo ya pertenece a otro registro activo.",
      values,
    );
  }
  if (error instanceof CatalogNotFoundError) {
    return actionError("El registro solicitado ya no existe. Recarga la página.", values);
  }
  if (error instanceof CatalogQueryError) {
    switch (error.code) {
      case "INVALID_GS1":
        return actionError(
          "El código GTIN no es válido. Verifica la longitud (8, 12, 13, 14 o 18 dígitos) y su dígito de control GS1.",
          values,
        );
      case "INVALID_EAN":
        return actionError(
          "El código EAN debe tener 8 o 13 dígitos con dígito de control GS1 válido.",
          values,
        );
      case "INVALID_SKU":
        return actionError(
          "El SKU debe tener entre 2 y 64 caracteres alfanuméricos (A-Z, 0-9, punto, guion o guion bajo).",
          values,
        );
      case "INVALID_MONEY":
        return actionError(
          "Revisa los montos en centavos COP: deben ser enteros no negativos y el precio anterior no puede ser menor al precio vigente.",
          values,
        );
      case "INVALID_SLUG":
        return actionError(
          "El slug solo admite letras minúsculas, números y guiones simples sin espacios.",
          values,
        );
      case "INVALID_ATTRIBUTE":
        return actionError(
          "El valor del atributo no coincide con el tipo esperado (texto, entero, decimal, booleano, URL https o JSON).",
          values,
        );
      case "INACTIVE_DEFAULT":
        return actionError("Una variante inactiva no puede marcarse como principal.", values);
      case "NO_ACTIVE_VARIANT":
        return actionError(
          "Un producto activo debe conservar al menos una variante activa.",
          values,
        );
      default:
        return actionError(
          "Revisa los campos, las referencias seleccionadas y la configuración del producto.",
          values,
        );
    }
  }
  return actionError(
    "No pudimos guardar el cambio. Inténtalo de nuevo sin perder los datos del formulario.",
    values,
  );
}

function invalidateCatalog(options: {
  productId: string;
  slug?: string;
  previousSlug?: string;
  includeReviews?: boolean;
}): void {
  updateTag("catalog");
  updateTag("catalog:search");
  updateTag("catalog:compare");
  updateTag("catalog:cms-grid");
  updateTag("merchant-feed");
  updateTag("meta-catalog-feed");
  updateTag("sitemap");
  if (options.slug) {
    updateTag(`catalog:product:${options.slug}`);
    if (options.includeReviews) updateTag(`reviews:${options.slug}`);
  }
  if (options.previousSlug && options.previousSlug !== options.slug) {
    updateTag(`catalog:product:${options.previousSlug}`);
    if (options.includeReviews) updateTag(`reviews:${options.previousSlug}`);
  }
  revalidatePath("/admin/catalogo");
  revalidatePath(`/admin/catalogo/${options.productId}`);
}

export async function createCatalogProductAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  let createdId: string;
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const product = baseInput(formData);
    const variant = variantInput(formData);
    if (!product || !variant) {
      return actionError(
        "Completa correctamente los campos obligatorios del producto y su variante inicial.",
        values,
      );
    }
    const context = await getRequestSecurityContext();
    const created = await new CatalogService(getDatabase()).createProduct(
      { ...product, variant },
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog({ productId: created.id, slug: created.slug });
    createdId = created.id;
  } catch (error) {
    return mutationMessage(error, values);
  }
  redirect(`/admin/catalogo/${createdId}?created=1`);
}

export async function updateCatalogProductAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const product = baseInput(formData);
    const productId = formString(formData, "productId");
    if (!product || !z.string().uuid().safeParse(productId).success) {
      return actionError("Los datos del producto no son válidos.", values);
    }
    const context = await getRequestSecurityContext();
    const updated = await new CatalogService(getDatabase()).updateProduct(productId, product, {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    invalidateCatalog({
      productId,
      slug: updated.slug,
      previousSlug: updated.previousSlug,
      includeReviews: true,
    });
    return actionSuccess("Producto actualizado y cambio registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

export async function upsertCatalogVariantAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const variant = variantInput(formData);
    const productId = formString(formData, "productId");
    if (!variant || !z.string().uuid().safeParse(productId).success) {
      return actionError("Los datos de la variante no son válidos.", values);
    }
    const context = await getRequestSecurityContext();
    const saved = await new CatalogService(getDatabase()).upsertVariant(productId, variant, {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    invalidateCatalog({ productId, slug: saved.slug });
    return actionSuccess("Variante guardada y cambio registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

export async function upsertCatalogAttributeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const productId = formString(formData, "productId");
    const attributeId = formString(formData, "attributeId");
    const attributeValueId = formString(formData, "attributeValueId");
    const value = formString(formData, "value");
    if (
      !z.string().uuid().safeParse(productId).success ||
      !z.string().uuid().safeParse(attributeId).success ||
      (attributeValueId && !z.string().uuid().safeParse(attributeValueId).success) ||
      !value.trim() ||
      value.length > 100_000
    ) {
      return actionError("Selecciona un atributo técnico e ingresa un valor válido.", values);
    }
    const context = await getRequestSecurityContext();
    const saved = await new CatalogService(getDatabase()).upsertProductAttribute(
      productId,
      {
        ...(attributeValueId ? { id: attributeValueId } : {}),
        attributeId,
        value,
      },
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog({ productId, slug: saved.slug });
    return actionSuccess("Atributo técnico guardado y registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

export async function removeCatalogAttributeAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const productId = formString(formData, "productId");
    const attributeValueId = formString(formData, "attributeValueId");
    if (
      !z.string().uuid().safeParse(productId).success ||
      !z.string().uuid().safeParse(attributeValueId).success
    ) {
      return actionError("El atributo seleccionado no es válido.", values);
    }
    const context = await getRequestSecurityContext();
    const removed = await new CatalogService(getDatabase()).removeProductAttribute(
      productId,
      attributeValueId,
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog({ productId, slug: removed.slug });
    return actionSuccess("Atributo eliminado y registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

export async function upsertCatalogCompatibilityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const parsed = z
      .object({
        productId: z.string().uuid(),
        deviceId: z.string().uuid(),
        fit: z.enum(["EXACT", "ADAPTER", "NOT_COMPATIBLE"]),
        notes: z.string().max(500),
      })
      .strict()
      .safeParse({
        productId: formString(formData, "productId"),
        deviceId: formString(formData, "deviceId"),
        fit: formString(formData, "fit"),
        notes: formString(formData, "notes"),
      });
    if (!parsed.success) {
      return actionError("Selecciona un dispositivo y el tipo de ajuste.", values);
    }
    const context = await getRequestSecurityContext();
    const saved = await new CatalogService(getDatabase()).upsertProductCompatibility(
      parsed.data.productId,
      {
        deviceId: parsed.data.deviceId,
        fit: parsed.data.fit,
        ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      },
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog({ productId: parsed.data.productId, slug: saved.slug });
    return actionSuccess("Compatibilidad guardada y registrada en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

export async function removeCatalogCompatibilityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const productId = formString(formData, "productId");
    const compatibilityId = formString(formData, "compatibilityId");
    if (
      !z.string().uuid().safeParse(productId).success ||
      !z.string().uuid().safeParse(compatibilityId).success
    ) {
      return actionError("El vínculo de compatibilidad no es válido.", values);
    }
    const context = await getRequestSecurityContext();
    const removed = await new CatalogService(getDatabase()).removeProductCompatibility(
      productId,
      compatibilityId,
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog({ productId, slug: removed.slug });
    return actionSuccess("Compatibilidad eliminada y registrada en auditoría.");
  } catch (error) {
    return mutationMessage(error, values);
  }
}

async function authorizeMediaMutation(): Promise<{
  session: AdminSession;
  request: RequestSecurityContext;
}> {
  const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
  return { session, request: await getRequestSecurityContext() };
}

function mediaAudit(session: AdminSession, request: RequestSecurityContext): ProductMediaAudit {
  return {
    actorAdminUserId: session.profile.id,
    ipHash: request.ipHash,
    userAgentHash: request.userAgentHash,
  };
}

function mediaMutationError(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de modificar los medios.", values);
  }
  if (error instanceof AdminAuthorizationError || error instanceof AdminActorAuthorizationError) {
    return actionError("Tu sesión no está autorizada para modificar el catálogo.", values);
  }
  if (error instanceof ProductMediaNotFoundError) {
    return actionError(
      "El producto, la variante o el medio ya no están disponibles. Recarga la página.",
      values,
    );
  }
  if (error instanceof ProductMediaValidationError || error instanceof z.ZodError) {
    if (error instanceof Error && /position/i.test(error.message)) {
      return actionError("La posición debe estar dentro del rango de medios activos.", values);
    }
    if (error instanceof Error && /Alt text/i.test(error.message)) {
      return actionError(
        "Escribe un texto alternativo descriptivo, sin HTML ni caracteres de control.",
        values,
      );
    }
    return actionError("Revisa el texto alternativo y la posición del medio.", values);
  }
  return actionError(
    "No pudimos actualizar el medio. Recarga la página e inténtalo de nuevo.",
    values,
  );
}

export async function updateCatalogMediaAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  try {
    const { session, request } = await authorizeMediaMutation();
    const productId = formString(formData, "productId");
    const mediaId = formString(formData, "mediaId");
    const position = formString(formData, "position");
    if (!/^[0-9]+$/.test(position)) {
      throw new ProductMediaValidationError("Invalid position.");
    }
    const result = await new ProductMediaService(getDatabase(), null).update(
      z.string().uuid().parse(productId),
      z.string().uuid().parse(mediaId),
      {
        altText: formString(formData, "altText").trim(),
        position: Number(position),
      },
      mediaAudit(session, request),
    );
    invalidateCatalog({ productId, slug: result.slug });
    return actionSuccess("Texto alternativo y orden actualizados en el catálogo.");
  } catch (error) {
    return mediaMutationError(error, values);
  }
}

export async function archiveCatalogMediaAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = catalogSnapshot(formData);
  const productId = formString(formData, "productId");
  try {
    const { session, request } = await authorizeMediaMutation();
    const result = await new ProductMediaService(getDatabase(), null).archive(
      z.string().uuid().parse(productId),
      z.string().uuid().parse(formString(formData, "mediaId")),
      mediaAudit(session, request),
    );
    invalidateCatalog({ productId, slug: result.slug });
  } catch (error) {
    return mediaMutationError(error, values);
  }
  redirect(`/admin/catalogo/${productId}?mediaArchived=1#admin-product-media`);
}
