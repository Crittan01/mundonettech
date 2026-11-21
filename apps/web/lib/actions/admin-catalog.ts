"use server";

import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogQueryError,
  CatalogService,
  type CatalogProductBaseInput,
  type CatalogVariantInput,
} from "@mundonettech/db";
import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, formString, type ActionState } from "@/lib/action-state";
import { getDatabase } from "@/lib/db";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

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
  warrantyMonths: z.string().regex(/^[0-9]+$/),
  seoTitle: z.string().max(200),
  seoDescription: z.string().max(300),
});

const variantSchema = z.object({
  sku: z.string().trim().min(2).max(64),
  priceCents: z.string().regex(/^[0-9]+$/),
  costCents: z.string().regex(/^[0-9]+$/),
  compareAtPriceCents: z.string(),
  gtin: z.string(),
  ean: z.string(),
  mpn: z.string().max(64),
  weightGrams: z.string().regex(/^[0-9]+$/),
  lengthMillimeters: z.string().regex(/^[0-9]+$/),
  widthMillimeters: z.string().regex(/^[0-9]+$/),
  heightMillimeters: z.string().regex(/^[0-9]+$/),
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

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
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    warrantyMonths: Number(parsed.data.warrantyMonths),
    trackSerial: formData.get("trackSerial") === "on",
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
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    ...(formString(formData, "variantId") ? { id: formString(formData, "variantId") } : {}),
    weightGrams: Number(parsed.data.weightGrams),
    lengthMillimeters: Number(parsed.data.lengthMillimeters),
    widthMillimeters: Number(parsed.data.widthMillimeters),
    heightMillimeters: Number(parsed.data.heightMillimeters),
    isDefault: ["on", "true"].includes(formString(formData, "isDefault")),
  };
}

function mutationMessage(error: unknown): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de guardar este cambio.");
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para modificar el catálogo.");
  }
  if (error instanceof CatalogConflictError) {
    return actionError("El slug, SKU, GTIN o EAN ya pertenece a otro registro activo.");
  }
  if (error instanceof CatalogNotFoundError) {
    return actionError("El producto o la variante ya no existe. Recarga la página.");
  }
  if (error instanceof CatalogQueryError) {
    return actionError(
      "Revisa los campos, las referencias y la configuración de la variante principal.",
    );
  }
  return actionError(
    "No pudimos guardar el cambio. Inténtalo de nuevo sin perder los datos del formulario.",
  );
}

function invalidateCatalog(productId: string, slug?: string): void {
  updateTag("catalog");
  if (slug) updateTag(`catalog:product:${slug}`);
  revalidatePath("/admin/catalogo");
  revalidatePath(`/admin/catalogo/${productId}`);
}

export async function createCatalogProductAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const product = baseInput(formData);
  const variant = variantInput(formData);
  if (!product || !variant)
    return actionError("Completa los campos obligatorios del producto y su variante.");
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const context = await getRequestSecurityContext();
    const created = await new CatalogService(getDatabase()).createProduct(
      { ...product, variant },
      {
        actorAdminUserId: session.profile.id,
        ipHash: context.ipHash,
        userAgentHash: context.userAgentHash,
      },
    );
    invalidateCatalog(created.id, product.slug);
    return actionSuccess(
      "Producto creado con su variante inicial y cambio registrado en auditoría.",
    );
  } catch (error) {
    return mutationMessage(error);
  }
}

export async function updateCatalogProductAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const product = baseInput(formData);
  const productId = formString(formData, "productId");
  if (!product || !z.string().uuid().safeParse(productId).success) {
    return actionError("Los datos del producto no son válidos.");
  }
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const context = await getRequestSecurityContext();
    await new CatalogService(getDatabase()).updateProduct(productId, product, {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    invalidateCatalog(productId, product.slug);
    return actionSuccess("Producto actualizado y cambio registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error);
  }
}

export async function upsertCatalogVariantAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const variant = variantInput(formData);
  const productId = formString(formData, "productId");
  if (!variant || !z.string().uuid().safeParse(productId).success) {
    return actionError("Los datos de la variante no son válidos.");
  }
  try {
    const session = await getAdminSession({ permission: "catalog:write", requireRecentMfa: true });
    const context = await getRequestSecurityContext();
    const product = await getDatabase().product.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    await new CatalogService(getDatabase()).upsertVariant(productId, variant, {
      actorAdminUserId: session.profile.id,
      ipHash: context.ipHash,
      userAgentHash: context.userAgentHash,
    });
    invalidateCatalog(productId, product?.slug);
    return actionSuccess("Variante guardada y cambio registrado en auditoría.");
  } catch (error) {
    return mutationMessage(error);
  }
}
