"use server";

import {
  CmsConflictError,
  CmsMediaService,
  CmsNotFoundError,
  CmsService,
  CmsValidationError,
  StoreSettingsService,
  type CmsBlockType,
} from "@mundonettech/cms";
import { storeConfig } from "@mundonettech/config/store";
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
import { createCmsMediaStorage } from "@/lib/media-storage";
import {
  getAdminSession,
  AdminAuthorizationError,
  type AdminSession,
} from "@/lib/security/admin-auth";
import {
  getRequestSecurityContext,
  type RequestSecurityContext,
} from "@/lib/security/request-context";

function cmsService(): CmsService {
  return new CmsService(getDatabase(), {
    "store.name": storeConfig.name,
    "store.domain": storeConfig.domain,
  });
}

async function authorize(
  permission: "content:write" | "settings:write",
): Promise<{ session: AdminSession; request: RequestSecurityContext }> {
  const session = await getAdminSession({ permission, requireRecentMfa: true });
  return { session, request: await getRequestSecurityContext() };
}

function audit(session: AdminSession, request: RequestSecurityContext) {
  return {
    actorAdminUserId: session.profile.id,
    ipHash: request.ipHash,
    userAgentHash: request.userAgentHash,
  };
}

function errorMessage(error: unknown, values: Record<string, string>): ActionState {
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE")
    return actionError("Confirma tu autenticador antes de guardar este cambio.", values);
  if (error instanceof AdminAuthorizationError)
    return actionError("Tu sesión no está autorizada para esta operación.", values);
  if (error instanceof CmsNotFoundError)
    return actionError("El contenido solicitado ya no existe. Recarga la página.", values);
  if (error instanceof CmsConflictError)
    return actionError("El cambio entra en conflicto con el estado o contenido existente.", values);
  if (error instanceof CmsValidationError || error instanceof z.ZodError)
    return actionError(
      "Revisa los campos y la estructura JSON del bloque. Los tokens y enlaces deben ser válidos.",
      values,
    );
  return actionError(
    "No pudimos completar la operación. Inténtalo de nuevo sin perder los datos.",
    values,
  );
}

function contentJson(formData: FormData): unknown {
  const raw = formString(formData, "content");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CmsValidationError("Content must be valid JSON.");
  }
}

function localDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new CmsValidationError("Invalid local date.");
  const date = new Date(`${value}:00-05:00`);
  if (Number.isNaN(date.getTime())) throw new CmsValidationError("Invalid local date.");
  return date;
}

function pageInput(formData: FormData) {
  return {
    slug: formString(formData, "slug"),
    title: formString(formData, "title"),
    seoTitle: formString(formData, "seoTitle"),
    seoDescription: formString(formData, "seoDescription"),
  };
}

function invalidateCms(slug?: string): void {
  updateTag("cms");
  if (slug) updateTag(`cms:page:${slug}`);
  revalidatePath("/admin/contenido");
}

export async function createCmsPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  let createdId: string;
  try {
    const { session, request } = await authorize("content:write");
    const type = formString(formData, "blockType") as CmsBlockType;
    const page = await cmsService().createPage(
      pageInput(formData),
      [{ type, content: contentJson(formData), isVisible: true }],
      audit(session, request),
    );
    invalidateCms(page.slug);
    createdId = page.id;
  } catch (error) {
    return errorMessage(error, values);
  }
  redirect(`/admin/contenido/${createdId}?created=1`);
}

export async function updateCmsPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const id = z.uuid().parse(formString(formData, "pageId"));
    const page = await cmsService().updatePage(id, pageInput(formData), audit(session, request));
    invalidateCms(page.slug);
    return actionSuccess("Página actualizada y cambio registrado en auditoría.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function addCmsBlockAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const pageId = z.uuid().parse(formString(formData, "pageId"));
    await cmsService().addBlock(
      pageId,
      {
        type: formString(formData, "blockType") as CmsBlockType,
        content: contentJson(formData),
        isVisible: true,
      },
      audit(session, request),
    );
    invalidateCms();
    revalidatePath(`/admin/contenido/${pageId}`);
    return actionSuccess("Bloque añadido con su primera versión en borrador.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function createCmsVersionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const blockId = z.uuid().parse(formString(formData, "blockId"));
    const version = await cmsService().createDraftVersion(
      blockId,
      contentJson(formData),
      audit(session, request),
    );
    invalidateCms();
    return actionSuccess(`Versión ${version.version} creada en borrador.`);
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function publishCmsVersionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    await cmsService().publishVersion(
      z.uuid().parse(formString(formData, "versionId")),
      audit(session, request),
    );
    invalidateCms();
    return actionSuccess("Versión publicada. La página usará la versión vigente más reciente.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function scheduleCmsVersionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const versionId = z.uuid().parse(formString(formData, "versionId"));
    await cmsService().scheduleVersion(
      versionId,
      localDate(formString(formData, "effectiveAt")),
      audit(session, request),
    );
    invalidateCms();
    return actionSuccess("Publicación de la versión programada.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function publishCmsPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const page = await cmsService().publishPage(
      z.uuid().parse(formString(formData, "pageId")),
      audit(session, request),
    );
    invalidateCms(page.slug);
    return actionSuccess("Página publicada con sus bloques vigentes.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function scheduleCmsPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const page = await cmsService().schedulePage(
      z.uuid().parse(formString(formData, "pageId")),
      localDate(formString(formData, "scheduledFor")),
      audit(session, request),
    );
    invalidateCms(page.slug);
    return actionSuccess("Publicación de la página programada.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function archiveCmsPageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const page = await cmsService().archivePage(
      z.uuid().parse(formString(formData, "pageId")),
      audit(session, request),
    );
    invalidateCms(page.slug);
    return actionSuccess("Página archivada; su historial permanece disponible.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function reorderCmsBlocksAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    const pageId = z.uuid().parse(formString(formData, "pageId"));
    const blockIds = z.array(z.uuid()).parse(JSON.parse(formString(formData, "blockIds")));
    await cmsService().reorderBlocks(pageId, blockIds, audit(session, request));
    invalidateCms();
    return actionSuccess("Orden de bloques actualizado.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function setCmsBlockVisibilityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    await cmsService().setBlockVisibility(
      z.uuid().parse(formString(formData, "blockId")),
      formString(formData, "isVisible") === "true",
      audit(session, request),
    );
    invalidateCms();
    return actionSuccess("Visibilidad del bloque actualizada.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function saveStoreSettingsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("settings:write");
    const settings = await new StoreSettingsService(getDatabase()).save(
      {
        taxRegime: z
          .enum(["NO_RESPONSABLE_IVA", "RESPONSABLE_IVA"])
          .parse(formString(formData, "taxRegime")),
        annualRevenueAlertUvt: z.coerce
          .number()
          .int()
          .positive()
          .parse(formString(formData, "annualRevenueAlertUvt")),
        currency: formString(formData, "currency"),
        timeZone: formString(formData, "timeZone"),
        orderNumberPrefix: formString(formData, "orderNumberPrefix"),
        orderNumberPadding: z.coerce
          .number()
          .int()
          .min(1)
          .max(12)
          .parse(formString(formData, "orderNumberPadding")),
        clickAndCollectEnabled: formData.get("clickAndCollectEnabled") === "on",
        localDeliveryEnabled: formData.get("localDeliveryEnabled") === "on",
      },
      audit(session, request),
    );
    updateTag("store-settings");
    revalidatePath("/admin/configuracion");
    return actionSuccess(
      `Configuración guardada para ${settings.currency} y ${settings.timeZone}.`,
    );
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function uploadCmsMediaAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  let storage: ReturnType<typeof createCmsMediaStorage> | null = null;
  try {
    const { session, request } = await authorize("content:write");
    storage = createCmsMediaStorage();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new CmsValidationError("An image file is required.");
    const result = await new CmsMediaService(getDatabase(), storage).upload(
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        altText: formString(formData, "altText"),
      },
      audit(session, request),
    );
    updateTag("cms:media");
    revalidatePath("/admin/contenido/medios");
    return actionSuccess(
      result.reused
        ? "La imagen ya existía; se reutilizó el activo persistido."
        : "Imagen procesada, almacenada en R2 y registrada en la mediateca.",
    );
  } catch (error) {
    return errorMessage(error, values);
  } finally {
    await storage?.destroy();
  }
}

export async function updateCmsMediaAltAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    await new CmsMediaService(getDatabase(), null).updateAltText(
      z.uuid().parse(formString(formData, "mediaId")),
      formString(formData, "altText"),
      audit(session, request),
    );
    revalidatePath("/admin/contenido/medios");
    return actionSuccess("Texto alternativo actualizado.");
  } catch (error) {
    return errorMessage(error, values);
  }
}

export async function archiveCmsMediaAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = formSnapshot(formData);
  try {
    const { session, request } = await authorize("content:write");
    await new CmsMediaService(getDatabase(), null).archive(
      z.uuid().parse(formString(formData, "mediaId")),
      audit(session, request),
    );
    revalidatePath("/admin/contenido/medios");
    return actionSuccess("Activo archivado sin borrar su objeto ni el historial editorial.");
  } catch (error) {
    return errorMessage(error, values);
  }
}
