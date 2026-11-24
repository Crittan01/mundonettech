"use server";

import { randomUUID } from "node:crypto";

import { parseDecimalCopToCents, parseWholeCopToCents } from "@mundonettech/core";
import { ChannelCatalogError, type ChannelOfferConfiguration } from "@mundonettech/integrations";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, actionSuccess, formString, type ActionState } from "@/lib/action-state";
import { channelCatalogService } from "@/lib/integrations";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const listingSchema = z.object({
  accountId: z.string().uuid(),
  variantId: z.string().uuid(),
  externalCategoryId: z.string().regex(/^MCO[0-9]{1,27}$/),
  familyName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  sellerStoreId: z.union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)]),
  sellerNetworkNodeId: z.union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)]),
});

const copPattern = /^[0-9]+(?:[.,][0-9]{1,2})?$/;
const wholeCopPattern = /^[0-9]+$/;

const offerSchema = z.object({
  pricingMode: z.enum(["FORMULA", "MANUAL"]),
  listingTypeId: z.enum(["gold_special", "gold_pro"]),
  logisticType: z.enum(["CROSS_DOCKING", "FULFILLMENT"]),
  commissionBps: z.string().regex(/^[0-9]{1,4}$/),
  fixedFeeCop: z.string().max(22).regex(copPattern),
  shippingCostCop: z.string().max(22).regex(copPattern),
  targetNetCop: z.string().max(22),
  manualPriceCop: z.string().max(22),
});
const versionSchema = z
  .string()
  .regex(/^[0-9]{1,10}$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(2_147_483_647));

const publicValueKeys = [
  "accountId",
  "variantId",
  "externalCategoryId",
  "familyName",
  "sellerStoreId",
  "sellerNetworkNodeId",
  "pricingMode",
  "listingTypeId",
  "logisticType",
  "commissionBps",
  "fixedFeeCop",
  "shippingCostCop",
  "targetNetCop",
  "manualPriceCop",
] as const;

function publicValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of publicValueKeys) values[key] = formString(formData, key);
  return values;
}

function cents(value: string): bigint {
  return BigInt(parseDecimalCopToCents(value));
}

function wholeCents(value: string): bigint {
  return BigInt(parseWholeCopToCents(value));
}

function optionalCents(value: string): bigint | null {
  return value ? cents(value) : null;
}

function optionalWholeCents(value: string): bigint | null {
  return value ? wholeCents(value) : null;
}

function parseOffer(formData: FormData): ChannelOfferConfiguration {
  const parsed = offerSchema.safeParse({
    pricingMode: formString(formData, "pricingMode"),
    listingTypeId: formString(formData, "listingTypeId"),
    logisticType: formString(formData, "logisticType"),
    commissionBps: formString(formData, "commissionBps"),
    fixedFeeCop: formString(formData, "fixedFeeCop") || "0",
    shippingCostCop: formString(formData, "shippingCostCop") || "0",
    targetNetCop: formString(formData, "targetNetCop"),
    manualPriceCop: formString(formData, "manualPriceCop"),
  });
  if (!parsed.success) {
    throw new ChannelCatalogError("INVALID_INPUT", "The channel offer fields are invalid.");
  }
  const data = parsed.data;
  const commissionBps = Number(data.commissionBps);
  if (commissionBps > 5_000) {
    throw new ChannelCatalogError("INVALID_INPUT", "The commission cannot exceed 50 percent.");
  }
  if (data.pricingMode === "FORMULA" && !copPattern.test(data.targetNetCop)) {
    throw new ChannelCatalogError("INVALID_INPUT", "A formula offer requires a target net amount.");
  }
  if (data.pricingMode === "MANUAL" && !wholeCopPattern.test(data.manualPriceCop)) {
    throw new ChannelCatalogError("INVALID_INPUT", "A manual offer requires a whole COP price.");
  }
  return {
    mode: data.pricingMode,
    listingTypeId: data.listingTypeId,
    fulfillment: data.logisticType === "FULFILLMENT",
    commissionBps,
    fixedFeeCents: cents(data.fixedFeeCop || "0"),
    shippingCostCents: cents(data.shippingCostCop || "0"),
    targetNetCents: data.pricingMode === "FORMULA" ? optionalCents(data.targetNetCop) : null,
    manualPriceCents:
      data.pricingMode === "MANUAL" ? optionalWholeCents(data.manualPriceCop) : null,
  };
}

async function authorize() {
  const session = await getAdminSession({
    permission: "integrations:write",
    requireRecentMfa: true,
  });
  const context = await getRequestSecurityContext();
  return {
    actorAdminUserId: session.profile.id,
    requestId: randomUUID(),
    ipHash: context.ipHash,
    userAgentHash: context.userAgentHash ?? null,
  };
}

function failure(error: unknown, values?: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError(
      "Confirma tu autenticador antes de sincronizar el catálogo del canal.",
      values,
    );
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para administrar publicaciones.", values);
  }
  if (error instanceof ChannelCatalogError) {
    const messages: Partial<Record<ChannelCatalogError["code"], string>> = {
      INVALID_INPUT: "Revisa categoría, precios, comisión, flete y datos de la variante.",
      NOT_FOUND: "La publicación, oferta o variante ya no está disponible.",
      FORBIDDEN: "Tu rol no permite modificar este catálogo de canal.",
      CONFLICT: "El estado cambió o el precio cae en la zona muerta. Revisa antes de continuar.",
      REAUTH_REQUIRED: "Reconecta la cuenta de Mercado Libre antes de sincronizar.",
      RECONCILE_REQUIRED: "Primero concilia el resultado remoto; no se creará un duplicado.",
      PROVIDER_REJECTED:
        "Mercado Libre rechazó los datos. Revisa la configuración del vendedor y la categoría.",
      PROVIDER_UNCERTAIN:
        "El resultado es incierto. Concilia el estado remoto antes de reintentar.",
      VERSION_CONFLICT: "El stock remoto cambió varias veces. Concilia y vuelve a sincronizar.",
    };
    return actionError(messages[error.code] ?? "No pudimos completar la sincronización.", values);
  }
  if (error instanceof z.ZodError) {
    return actionError("Revisa los identificadores y campos de sincronización.", values);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return actionError(
      "La variante necesita datos logísticos, GTIN válido y una imagen JPEG, PNG o WebP lista.",
      values,
    );
  }
  return actionError("No pudimos completar la operación del canal. Inténtalo de nuevo.", values);
}

function syncMessage(result: {
  claimed: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  retryScheduled: number;
  failures: readonly { code: string }[];
}): ActionState {
  if (result.failures.length > 0) {
    return actionError(
      "La sincronización se detuvo. Revisa el trabajo persistido y concilia antes de reintentar.",
    );
  }
  if (result.claimed === 0) {
    return actionSuccess("No hay trabajos pendientes para esta publicación.");
  }
  return actionSuccess(
    `${result.succeeded} trabajo(s) completado(s). El estado remoto quedó confirmado y auditado.`,
  );
}

export async function createChannelListingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize();
    const parsed = listingSchema.safeParse({
      accountId: formString(formData, "accountId"),
      variantId: formString(formData, "variantId"),
      externalCategoryId: formString(formData, "externalCategoryId"),
      familyName: formString(formData, "familyName"),
      sellerStoreId: formString(formData, "sellerStoreId"),
      sellerNetworkNodeId: formString(formData, "sellerNetworkNodeId"),
    });
    if (!parsed.success) throw new ChannelCatalogError("INVALID_INPUT", "Invalid listing fields.");
    if ((parsed.data.sellerStoreId === "") !== (parsed.data.sellerNetworkNodeId === "")) {
      throw new ChannelCatalogError(
        "INVALID_INPUT",
        "Warehouse identifiers must be provided together.",
      );
    }
    const listing = await channelCatalogService().createListing({
      ...parsed.data,
      sellerStoreId: parsed.data.sellerStoreId || null,
      sellerNetworkNodeId: parsed.data.sellerNetworkNodeId || null,
      offer: parseOffer(formData),
      audit,
    });
    revalidatePath("/admin/canales");
    return actionSuccess(
      `Publicación ${listing.sku} preparada. El job quedó persistido; procésalo para crear el User Product.`,
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function addChannelOfferAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize();
    const listingId = z.string().uuid().parse(formString(formData, "listingId"));
    await channelCatalogService().addOffer({ listingId, offer: parseOffer(formData), audit });
    revalidatePath("/admin/canales");
    return actionSuccess("Nueva condición de venta persistida. Procesa el job para publicarla.");
  } catch (error) {
    return failure(error, values);
  }
}

export async function updateChannelOfferAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = publicValues(formData);
  try {
    const audit = await authorize();
    const offerId = z.string().uuid().parse(formString(formData, "offerId"));
    const expectedVersion = versionSchema.parse(formString(formData, "version"));
    await channelCatalogService().updateOffer({
      offerId,
      expectedVersion,
      offer: parseOffer(formData),
      audit,
    });
    revalidatePath("/admin/canales");
    return actionSuccess(
      "Precio y condiciones actualizados. Procesa el job para confirmarlos en Mercado Libre.",
    );
  } catch (error) {
    return failure(error, values);
  }
}

export async function synchronizeChannelListingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const audit = await authorize();
    const listingId = z.string().uuid().parse(formString(formData, "listingId"));
    const offerId = z
      .union([z.literal(""), z.string().uuid()])
      .parse(formString(formData, "offerId"));
    const kind = z
      .enum(["SYNC_PRICE", "SYNC_CONTENT", "SYNC_LOCAL_STOCK", "RECONCILE_REMOTE"])
      .parse(formString(formData, "kind"));
    const desiredStatus = z
      .union([z.literal(""), z.enum(["ACTIVE", "PAUSED", "CLOSED"])])
      .parse(formString(formData, "desiredStatus"));
    const force = z.enum(["true", "false"]).parse(formString(formData, "force"));
    if (desiredStatus === "CLOSED" && formString(formData, "confirmation") !== "CERRAR") {
      return actionError("Escribe CERRAR para confirmar el cierre definitivo de la publicación.");
    }
    const service = channelCatalogService();
    await service.enqueueSync({
      listingId,
      ...(offerId ? { offerId } : {}),
      kind,
      ...(desiredStatus ? { desiredStatus } : {}),
      force: force === "true",
      audit,
    });
    const result = await service.processSyncJobs(
      { ...audit, requestId: randomUUID() },
      { listingId, limit: 10 },
    );
    revalidatePath("/admin/canales");
    return syncMessage(result);
  } catch (error) {
    return failure(error);
  }
}

export async function processChannelSyncJobsAction(): Promise<ActionState> {
  try {
    const audit = await authorize();
    const result = await channelCatalogService().processSyncJobs(audit, { limit: 10 });
    revalidatePath("/admin/canales");
    return syncMessage(result);
  } catch (error) {
    return failure(error);
  }
}
