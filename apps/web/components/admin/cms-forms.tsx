"use client";

import { cmsBlockTypes, type StoreSettingsInput } from "@mundonettech/cms";
import type { ReactNode } from "react";
import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState, type ActionState } from "@/lib/action-state";
import {
  addCmsBlockAction,
  archiveCmsMediaAction,
  archiveCmsPageAction,
  createCmsPageAction,
  createCmsVersionAction,
  publishCmsPageAction,
  publishCmsVersionAction,
  reorderCmsBlocksAction,
  saveStoreSettingsAction,
  scheduleCmsPageAction,
  scheduleCmsVersionAction,
  setCmsBlockVisibilityAction,
  updateCmsMediaAltAction,
  updateCmsPageAction,
  uploadCmsMediaAction,
} from "@/lib/actions/admin-cms";

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;
const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ActionForm({
  action,
  children,
  submitLabel,
  className = "space-y-4",
}: {
  action: ServerAction;
  children: ReactNode;
  submitLabel: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, initialActionState);
  return (
    <form action={run} className={className}>
      {children}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Procesando…" : submitLabel}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function PageFields({
  page,
}: {
  page?:
    | { slug: string; title: string; seoTitle: string | null; seoDescription: string | null }
    | undefined;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="cms-slug">Slug</Label>
        <Input id="cms-slug" name="slug" defaultValue={page?.slug ?? ""} required maxLength={160} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cms-title">Título</Label>
        <Input
          id="cms-title"
          name="title"
          defaultValue={page?.title ?? ""}
          required
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cms-seo-title">Título SEO</Label>
        <Input
          id="cms-seo-title"
          name="seoTitle"
          defaultValue={page?.seoTitle ?? ""}
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cms-seo-description">Descripción SEO</Label>
        <Input
          id="cms-seo-description"
          name="seoDescription"
          defaultValue={page?.seoDescription ?? ""}
          maxLength={300}
        />
      </div>
    </div>
  );
}

function BlockFields({ content = "", idPrefix }: { content?: string; idPrefix: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-type`}>Tipo de bloque</Label>
        <select id={`${idPrefix}-type`} name="blockType" className={inputClass} defaultValue="HERO">
          {cmsBlockTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-content`}>Contenido JSON validado</Label>
        <textarea
          id={`${idPrefix}-content`}
          name="content"
          defaultValue={content}
          required
          rows={8}
          className={`${inputClass} font-mono`}
          placeholder='{"heading":"Título"}'
        />
        <p className="text-xs text-muted-foreground">
          Se valida según el tipo. Puedes usar tokens como {"{{store.name}}"}; no se admite HTML.
        </p>
      </div>
    </div>
  );
}

export function CmsPageForm({
  page,
}: {
  page?: {
    id: string;
    slug: string;
    title: string;
    seoTitle: string | null;
    seoDescription: string | null;
  };
}) {
  const action = page ? updateCmsPageAction : createCmsPageAction;
  return (
    <ActionForm
      action={action}
      submitLabel={page ? "Guardar página" : "Crear página"}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      {page ? <input type="hidden" name="pageId" value={page.id} /> : null}
      <PageFields page={page} />
      {!page ? <BlockFields idPrefix="initial-block" /> : null}
    </ActionForm>
  );
}

export function CmsAddBlockForm({ pageId }: { pageId: string }) {
  return (
    <ActionForm
      action={addCmsBlockAction}
      submitLabel="Añadir bloque en borrador"
      className="space-y-4"
    >
      <input type="hidden" name="pageId" value={pageId} />
      <BlockFields idPrefix="new-block" />
    </ActionForm>
  );
}

export function CmsNewVersionForm({ blockId, content }: { blockId: string; content: string }) {
  return (
    <ActionForm
      action={createCmsVersionAction}
      submitLabel="Crear nueva versión"
      className="space-y-3"
    >
      <input type="hidden" name="blockId" value={blockId} />
      <div className="space-y-2">
        <Label htmlFor={`version-${blockId}`}>Contenido de la nueva versión</Label>
        <textarea
          id={`version-${blockId}`}
          name="content"
          defaultValue={content}
          required
          rows={7}
          className={`${inputClass} font-mono`}
        />
      </div>
    </ActionForm>
  );
}

export function CmsPublishVersionForm({ versionId }: { versionId: string }) {
  return (
    <ActionForm action={publishCmsVersionAction} submitLabel="Publicar ahora">
      <input type="hidden" name="versionId" value={versionId} />
    </ActionForm>
  );
}

export function CmsScheduleVersionForm({ versionId }: { versionId: string }) {
  return (
    <ActionForm action={scheduleCmsVersionAction} submitLabel="Programar versión">
      <input type="hidden" name="versionId" value={versionId} />
      <Label htmlFor={`schedule-${versionId}`}>Fecha y hora (Colombia)</Label>
      <Input id={`schedule-${versionId}`} name="effectiveAt" type="datetime-local" required />
    </ActionForm>
  );
}

export function CmsPublishPageForm({ pageId }: { pageId: string }) {
  return (
    <ActionForm action={publishCmsPageAction} submitLabel="Publicar página">
      <input type="hidden" name="pageId" value={pageId} />
    </ActionForm>
  );
}

export function CmsSchedulePageForm({ pageId }: { pageId: string }) {
  return (
    <ActionForm action={scheduleCmsPageAction} submitLabel="Programar página">
      <input type="hidden" name="pageId" value={pageId} />
      <Label htmlFor="schedule-page">Fecha y hora (Colombia)</Label>
      <Input id="schedule-page" name="scheduledFor" type="datetime-local" required />
    </ActionForm>
  );
}

export function CmsArchivePageForm({ pageId }: { pageId: string }) {
  return (
    <ActionForm action={archiveCmsPageAction} submitLabel="Archivar página">
      <input type="hidden" name="pageId" value={pageId} />
    </ActionForm>
  );
}

export function CmsReorderForm({
  pageId,
  blockIds,
  label,
}: {
  pageId: string;
  blockIds: readonly string[];
  label: string;
}) {
  return (
    <ActionForm action={reorderCmsBlocksAction} submitLabel={label}>
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="blockIds" value={JSON.stringify(blockIds)} />
    </ActionForm>
  );
}

export function CmsVisibilityForm({ blockId, isVisible }: { blockId: string; isVisible: boolean }) {
  return (
    <ActionForm
      action={setCmsBlockVisibilityAction}
      submitLabel={isVisible ? "Ocultar bloque" : "Mostrar bloque"}
    >
      <input type="hidden" name="blockId" value={blockId} />
      <input type="hidden" name="isVisible" value={String(!isVisible)} />
    </ActionForm>
  );
}

export function StoreSettingsForm({ settings }: { settings: StoreSettingsInput }) {
  return (
    <ActionForm
      action={saveStoreSettingsAction}
      submitLabel="Guardar configuración"
      className="grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
    >
      <div className="space-y-2">
        <Label htmlFor="settings-regime">Régimen tributario</Label>
        <select
          id="settings-regime"
          name="taxRegime"
          defaultValue={settings.taxRegime}
          className={inputClass}
        >
          <option value="NO_RESPONSABLE_IVA">No responsable de IVA</option>
          <option value="RESPONSABLE_IVA">Responsable de IVA</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-threshold">Alerta de ingresos anuales (UVT)</Label>
        <Input
          id="settings-threshold"
          name="annualRevenueAlertUvt"
          type="number"
          min="1"
          defaultValue={String(settings.annualRevenueAlertUvt)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-currency">Moneda ISO</Label>
        <Input
          id="settings-currency"
          name="currency"
          defaultValue={settings.currency}
          maxLength={3}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-timezone">Zona horaria IANA</Label>
        <Input
          id="settings-timezone"
          name="timeZone"
          defaultValue={settings.timeZone}
          maxLength={64}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-prefix">Prefijo de orden</Label>
        <Input
          id="settings-prefix"
          name="orderNumberPrefix"
          defaultValue={settings.orderNumberPrefix}
          maxLength={12}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-padding">Dígitos del consecutivo</Label>
        <Input
          id="settings-padding"
          name="orderNumberPadding"
          type="number"
          min="1"
          max="12"
          defaultValue={String(settings.orderNumberPadding)}
          required
        />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          type="checkbox"
          name="clickAndCollectEnabled"
          defaultChecked={settings.clickAndCollectEnabled}
          className="size-4 accent-primary"
        />
        Habilitar Click & Collect
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          type="checkbox"
          name="localDeliveryEnabled"
          defaultChecked={settings.localDeliveryEnabled}
          className="size-4 accent-primary"
        />
        Habilitar entrega local Flex
      </label>
    </ActionForm>
  );
}

export function CmsMediaUploadForm() {
  return (
    <ActionForm
      action={uploadCmsMediaAction}
      submitLabel="Procesar y subir imagen"
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <div className="space-y-2">
        <Label htmlFor="media-file">Imagen JPEG, PNG, WebP, HEIC o AVIF</Label>
        <Input
          id="media-file"
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="media-alt">Texto alternativo</Label>
        <Input id="media-alt" name="altText" required maxLength={250} />
      </div>
    </ActionForm>
  );
}

export function CmsMediaEditForm({ mediaId, altText }: { mediaId: string; altText: string }) {
  return (
    <div className="space-y-3">
      <ActionForm action={updateCmsMediaAltAction} submitLabel="Guardar texto alternativo">
        <input type="hidden" name="mediaId" value={mediaId} />
        <Label htmlFor={`alt-${mediaId}`}>Texto alternativo</Label>
        <Input
          id={`alt-${mediaId}`}
          name="altText"
          defaultValue={altText}
          required
          maxLength={250}
        />
      </ActionForm>
      <ActionForm action={archiveCmsMediaAction} submitLabel="Archivar activo">
        <input type="hidden" name="mediaId" value={mediaId} />
      </ActionForm>
    </div>
  );
}
