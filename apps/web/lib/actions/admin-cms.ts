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
  AdminAuthorizationError,
  getAdminSession,
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
  if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
    return actionError("Confirma tu autenticador antes de guardar este cambio.", values);
  }
  if (error instanceof AdminAuthorizationError) {
    return actionError("Tu sesión no está autorizada para esta operación.", values);
  }
  if (error instanceof CmsNotFoundError) {
    return actionError("El contenido solicitado ya no existe. Recarga la página.", values);
  }
  if (error instanceof CmsConflictError) {
    if (error.message.includes("slug")) {
      return actionError("Ese slug ya está en uso por otra página activa.", values);
    }
    if (error.message.includes("visible published block")) {
      return actionError(
        "Para publicar la página necesitas al menos un bloque visible con versión publicada vigente.",
        values,
      );
    }
    if (error.message.includes("referenced by CMS version history")) {
      return actionError(
        "No puedes archivar este activo porque forma parte del historial de versiones del CMS.",
        values,
      );
    }
    return actionError(
      "Esta transición no es válida para el estado actual del registro editorial.",
      values,
    );
  }
  if (error instanceof CmsValidationError || error instanceof z.ZodError) {
    return actionError(
      "Revisa los campos, fechas futuras y estructura JSON del bloque: se permiten tokens conocidos y enlaces locales o HTTPS, sin HTML arbitrario.",
      values,
    );
  }
  return actionError(
    "No pudimos completar la operación. Inténtalo de nuevo; tus cambios siguen en pantalla.",
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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new CmsValidationError("Invalid local date.");
  }
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

function invalidateCms(options: { pageId?: string; slugs?: readonly (string | undefined)[] } = {}) {
  updateTag("cms");
  for (const slug of new Set(options.slugs ?? [])) {
    if (slug) updateTag(`cms:page:${slug}`);
  }
  revalidatePath("/admin/contenido");
  if (options.pageId) {
    revalidatePath(`/admin/contenido/${options.pageId}`);
  }
}

async function resolvePageByBlock(blockId: string): Promise<{ id: string; slug: string } | null> {
  const block = await getDatabase().cmsSectionBlock.findUnique({
    where: { id: blockId },
    select: { page: { select: { id: true, slug: true } } },
  });
  return block?.page ?? null;
}

async function resolvePageByVersion(
  versionId: string,
): Promise<{ id: string; slug: string } | null> {
  const version = await getDatabase().cmsBlockVersion.findUnique({
    where: { id: versionId },
    select: { block: { select: { page: { select: { id: true, slug: true } } } } },
  });
  return version?.block.page ?? null;
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
    invalidateCms({ pageId: page.id, slugs: [page.slug] });
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
  let liveEditSlug: string | null = null;
  try {
    const { session, request } = await authorize("content:write");
    const id = z.uuid().parse(formString(formData, "pageId"));
    const previous = await getDatabase().cmsPage.findFirst({
      where: { id, deletedAt: null },
      select: { slug: true },
    });
    const page = await cmsService().updatePage(id, pageInput(formData), audit(session, request));
    invalidateCms({ pageId: id, slugs: [previous?.slug, page.slug] });
    if (formString(formData, "liveEdit") === "1" && previous?.slug !== page.slug) {
      liveEditSlug = page.slug;
    }
  } catch (error) {
    return errorMessage(error, values);
  }
  if (liveEditSlug) redirect(`/pagina/${liveEditSlug}?liveEdit=1`);
  return actionSuccess("Página actualizada y cambio registrado en auditoría.");
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
    const page = await getDatabase().cmsPage.findUnique({
      where: { id: pageId },
      select: { slug: true },
    });
    invalidateCms({ pageId, slugs: [page?.slug] });
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
    const page = await resolvePageByBlock(blockId);
    invalidateCms({ ...(page ? { pageId: page.id, slugs: [page.slug] } : {}) });
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
    const versionId = z.uuid().parse(formString(formData, "versionId"));
    await cmsService().publishVersion(versionId, audit(session, request));
    const page = await resolvePageByVersion(versionId);
    invalidateCms({ ...(page ? { pageId: page.id, slugs: [page.slug] } : {}) });
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
    const page = await resolvePageByVersion(versionId);
    invalidateCms({ ...(page ? { pageId: page.id, slugs: [page.slug] } : {}) });
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
    const pageId = z.uuid().parse(formString(formData, "pageId"));
    const page = await cmsService().publishPage(pageId, audit(session, request));
    invalidateCms({ pageId, slugs: [page.slug] });
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
    const pageId = z.uuid().parse(formString(formData, "pageId"));
    const page = await cmsService().schedulePage(
      pageId,
      localDate(formString(formData, "scheduledFor")),
      audit(session, request),
    );
    invalidateCms({ pageId, slugs: [page.slug] });
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
    const pageId = z.uuid().parse(formString(formData, "pageId"));
    const page = await cmsService().archivePage(pageId, audit(session, request));
    invalidateCms({ pageId, slugs: [page.slug] });
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
    const page = await getDatabase().cmsPage.findUnique({
      where: { id: pageId },
      select: { slug: true },
    });
    invalidateCms({ pageId, slugs: [page?.slug] });
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
    const blockId = z.uuid().parse(formString(formData, "blockId"));
    await cmsService().setBlockVisibility(
      blockId,
      formString(formData, "isVisible") === "true",
      audit(session, request),
    );
    const page = await resolvePageByBlock(blockId);
    invalidateCms({ ...(page ? { pageId: page.id, slugs: [page.slug] } : {}) });
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
        uvtValueCents: z
          .string()
          .regex(/^[0-9]+$/)
          .parse(formString(formData, "uvtValueCents")),
        uvtYear: z.coerce.number().int().min(2000).max(9999).parse(formString(formData, "uvtYear")),
        standardShippingCents: z
          .string()
          .regex(/^[0-9]+$/)
          .parse(formString(formData, "standardShippingCents")),
        deliveryPromiseDays: z.coerce
          .number()
          .int()
          .min(1)
          .max(365)
          .parse(formString(formData, "deliveryPromiseDays")),
        reservationMinutes: z.coerce
          .number()
          .int()
          .min(5)
          .max(10_080)
          .parse(formString(formData, "reservationMinutes")),
        clickAndCollectEnabled: ["on", "true"].includes(
          formString(formData, "clickAndCollectEnabled"),
        ),
        localDeliveryEnabled: ["on", "true"].includes(formString(formData, "localDeliveryEnabled")),
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
    if (!(file instanceof File) || file.size === 0) {
      throw new CmsValidationError("An image file is required.");
    }
    const result = await new CmsMediaService(getDatabase(), storage).upload(
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        altText: formString(formData, "altText").trim(),
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
      formString(formData, "altText").trim(),
      audit(session, request),
    );
    updateTag("cms:media");
    updateTag("cms");
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
    updateTag("cms:media");
    revalidatePath("/admin/contenido/medios");
    return actionSuccess("Activo archivado sin borrar su objeto ni el historial editorial.");
  } catch (error) {
    return errorMessage(error, values);
  }
}
