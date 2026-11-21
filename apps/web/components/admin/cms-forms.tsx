"use client";

import { cmsBlockTypes, type CmsBlockType, type StoreSettingsInput } from "@mundonettech/cms";
import type { ReactNode } from "react";
import { useActionState, useState } from "react";

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
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

const blockTypeLabels: Record<CmsBlockType, string> = {
  HERO: "HERO · Portada principal",
  RICH_TEXT: "RICH_TEXT · Texto editorial",
  IMAGE: "IMAGE · Imagen de mediateca",
  CTA: "CTA · Llamado a la acción",
  PRODUCT_GRID: "PRODUCT_GRID · Grilla de productos",
  FAQ: "FAQ · Preguntas frecuentes",
};

const blockTemplates: Record<CmsBlockType, string> = {
  HERO: JSON.stringify(
    {
      heading: "Bienvenido a {{store.name}}",
      subheading: "Soluciones tecnológicas con garantía oficial en Colombia.",
      primaryCta: { label: "Explorar catálogo", href: "/productos" },
    },
    null,
    2,
  ),
  RICH_TEXT: JSON.stringify(
    {
      heading: "Respaldo técnico",
      body: "Todos los equipos distribuidos en {{store.domain}} cuentan con soporte posventa.",
    },
    null,
    2,
  ),
  IMAGE: JSON.stringify(
    {
      mediaId: "00000000-0000-4000-8000-000000000000",
      caption: "Detalle de producto",
    },
    null,
    2,
  ),
  CTA: JSON.stringify(
    {
      title: "Equipa tu operación con {{store.name}}",
      body: "Consulta disponibilidad inmediata en nuestras bodegas.",
      primaryCta: { label: "Ver productos", href: "/productos" },
    },
    null,
    2,
  ),
  PRODUCT_GRID: JSON.stringify(
    {
      heading: "Destacados de la categoría",
      categorySlug: "audio",
      maxItems: 8,
    },
    null,
    2,
  ),
  FAQ: JSON.stringify(
    {
      heading: "Preguntas frecuentes",
      items: [
        {
          question: "¿Cómo funciona la garantía?",
          answer: "Tramitamos la garantía directamente con número de orden y serial.",
        },
      ],
    },
    null,
    2,
  ),
};

const templateSet = new Set(Object.values(blockTemplates));

function StatefulForm({
  action,
  submitLabel,
  className = "space-y-4",
  children,
}: {
  action: ServerAction;
  submitLabel: string;
  className?: string;
  children: (values: Record<string, string> | undefined) => ReactNode;
}) {
  const [state, run, pending] = useActionState(action, initialActionState);
  return (
    <form action={run} className={className}>
      {children(state.values)}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Procesando…" : submitLabel}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

function PageFields({
  page,
  values,
  idPrefix,
}: {
  page?:
    | { slug: string; title: string; seoTitle: string | null; seoDescription: string | null }
    | undefined;
  values?: Record<string, string> | undefined;
  idPrefix: string;
}) {
  const slugDefault = values?.slug ?? page?.slug ?? "";
  const titleDefault = values?.title ?? page?.title ?? "";
  const seoTitleDefault = values?.seoTitle ?? page?.seoTitle ?? "";
  const seoDescriptionDefault = values?.seoDescription ?? page?.seoDescription ?? "";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-slug`}>Slug</Label>
        <Input
          key={`${idPrefix}-slug-${slugDefault}`}
          id={`${idPrefix}-slug`}
          name="slug"
          defaultValue={slugDefault}
          required
          maxLength={160}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-title`}>Título</Label>
        <Input
          key={`${idPrefix}-title-${titleDefault}`}
          id={`${idPrefix}-title`}
          name="title"
          defaultValue={titleDefault}
          required
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-seo-title`}>Título SEO</Label>
        <Input
          key={`${idPrefix}-seo-title-${seoTitleDefault}`}
          id={`${idPrefix}-seo-title`}
          name="seoTitle"
          defaultValue={seoTitleDefault}
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-seo-description`}>Descripción SEO</Label>
        <Input
          key={`${idPrefix}-seo-description-${seoDescriptionDefault}`}
          id={`${idPrefix}-seo-description`}
          name="seoDescription"
          defaultValue={seoDescriptionDefault}
          maxLength={300}
        />
      </div>
    </div>
  );
}

function BlockFields({
  values,
  idPrefix,
}: {
  values?: Record<string, string> | undefined;
  idPrefix: string;
}) {
  const initialType = cmsBlockTypes.includes(values?.blockType as CmsBlockType)
    ? (values?.blockType as CmsBlockType)
    : "HERO";
  const [selectedType, setSelectedType] = useState<CmsBlockType>(initialType);
  const [draftJson, setDraftJson] = useState<string>(
    values?.content ?? blockTemplates[initialType],
  );
  const [lastSyncedValues, setLastSyncedValues] = useState(values);

  if (values !== lastSyncedValues) {
    setLastSyncedValues(values);
    if (values?.blockType && cmsBlockTypes.includes(values.blockType as CmsBlockType)) {
      setSelectedType(values.blockType as CmsBlockType);
    }
    if (values?.content !== undefined) {
      setDraftJson(values.content);
    }
  }

  function handleTypeChange(nextType: CmsBlockType) {
    setSelectedType(nextType);
    if (!draftJson.trim() || templateSet.has(draftJson)) {
      setDraftJson(blockTemplates[nextType]);
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[260px_1fr]">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-type`}>Tipo de bloque</Label>
        <select
          id={`${idPrefix}-type`}
          name="blockType"
          className={selectClass}
          value={selectedType}
          onChange={(event) => handleTypeChange(event.target.value as CmsBlockType)}
        >
          {cmsBlockTypes.map((type) => (
            <option key={type} value={type}>
              {blockTypeLabels[type]}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDraftJson(blockTemplates[selectedType])}
        >
          Cargar plantilla del tipo
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-content`}>Contenido JSON validado</Label>
        <textarea
          id={`${idPrefix}-content`}
          name="content"
          value={draftJson}
          onChange={(event) => setDraftJson(event.target.value)}
          required
          rows={8}
          className={`${inputClass} font-mono`}
        />
        <p className="text-xs text-muted-foreground">
          Se valida con esquema estricto según el tipo. Puedes usar tokens como {"{{store.name}}"} o{" "}
          {"{{store.domain}}"}; se bloquea cualquier etiqueta HTML o enlace inseguro.
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
  const idPrefix = page ? `cms-page-${page.id}` : "cms-page-new";
  return (
    <StatefulForm
      action={action}
      submitLabel={page ? "Guardar página" : "Crear página"}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      {(values) => (
        <>
          {page ? <input type="hidden" name="pageId" value={page.id} /> : null}
          <PageFields page={page} values={values} idPrefix={idPrefix} />
          {!page ? <BlockFields values={values} idPrefix="initial-block" /> : null}
        </>
      )}
    </StatefulForm>
  );
}

export function CmsAddBlockForm({ pageId }: { pageId: string }) {
  return (
    <StatefulForm
      action={addCmsBlockAction}
      submitLabel="Añadir bloque en borrador"
      className="space-y-4"
    >
      {(values) => (
        <>
          <input type="hidden" name="pageId" value={pageId} />
          <BlockFields values={values} idPrefix="new-block" />
        </>
      )}
    </StatefulForm>
  );
}

export function CmsNewVersionForm({ blockId, content }: { blockId: string; content: string }) {
  return (
    <StatefulForm
      action={createCmsVersionAction}
      submitLabel="Crear nueva versión"
      className="space-y-3"
    >
      {(values) => {
        const currentContent = values?.content ?? content;
        return (
          <>
            <input type="hidden" name="blockId" value={blockId} />
            <div className="space-y-2">
              <Label htmlFor={`version-${blockId}`}>Contenido de la nueva versión</Label>
              <textarea
                key={`version-${blockId}-${currentContent}`}
                id={`version-${blockId}`}
                name="content"
                defaultValue={currentContent}
                required
                rows={7}
                className={`${inputClass} font-mono`}
              />
            </div>
          </>
        );
      }}
    </StatefulForm>
  );
}

export function CmsPublishVersionForm({ versionId }: { versionId: string }) {
  return (
    <StatefulForm action={publishCmsVersionAction} submitLabel="Publicar ahora">
      {() => <input type="hidden" name="versionId" value={versionId} />}
    </StatefulForm>
  );
}

export function CmsScheduleVersionForm({ versionId }: { versionId: string }) {
  return (
    <StatefulForm action={scheduleCmsVersionAction} submitLabel="Programar versión">
      {(values) => {
        const effectiveAtDefault = values?.effectiveAt ?? "";
        return (
          <>
            <input type="hidden" name="versionId" value={versionId} />
            <div className="space-y-2">
              <Label htmlFor={`schedule-${versionId}`}>Fecha y hora (Colombia)</Label>
              <Input
                key={`schedule-${versionId}-${effectiveAtDefault}`}
                id={`schedule-${versionId}`}
                name="effectiveAt"
                type="datetime-local"
                defaultValue={effectiveAtDefault}
                required
              />
            </div>
          </>
        );
      }}
    </StatefulForm>
  );
}

export function CmsPublishPageForm({ pageId }: { pageId: string }) {
  return (
    <StatefulForm action={publishCmsPageAction} submitLabel="Publicar página">
      {() => <input type="hidden" name="pageId" value={pageId} />}
    </StatefulForm>
  );
}

export function CmsSchedulePageForm({ pageId }: { pageId: string }) {
  return (
    <StatefulForm action={scheduleCmsPageAction} submitLabel="Programar página">
      {(values) => {
        const scheduledForDefault = values?.scheduledFor ?? "";
        return (
          <>
            <input type="hidden" name="pageId" value={pageId} />
            <div className="space-y-2">
              <Label htmlFor={`schedule-page-${pageId}`}>Fecha y hora (Colombia)</Label>
              <Input
                key={`schedule-page-${pageId}-${scheduledForDefault}`}
                id={`schedule-page-${pageId}`}
                name="scheduledFor"
                type="datetime-local"
                defaultValue={scheduledForDefault}
                required
              />
            </div>
          </>
        );
      }}
    </StatefulForm>
  );
}

export function CmsArchivePageForm({ pageId }: { pageId: string }) {
  return (
    <StatefulForm action={archiveCmsPageAction} submitLabel="Archivar página">
      {() => <input type="hidden" name="pageId" value={pageId} />}
    </StatefulForm>
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
    <StatefulForm action={reorderCmsBlocksAction} submitLabel={label}>
      {() => (
        <>
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="blockIds" value={JSON.stringify(blockIds)} />
        </>
      )}
    </StatefulForm>
  );
}

export function CmsVisibilityForm({ blockId, isVisible }: { blockId: string; isVisible: boolean }) {
  return (
    <StatefulForm
      action={setCmsBlockVisibilityAction}
      submitLabel={isVisible ? "Ocultar bloque" : "Mostrar bloque"}
    >
      {() => (
        <>
          <input type="hidden" name="blockId" value={blockId} />
          <input type="hidden" name="isVisible" value={String(!isVisible)} />
        </>
      )}
    </StatefulForm>
  );
}

export function StoreSettingsForm({ settings }: { settings: StoreSettingsInput }) {
  return (
    <StatefulForm
      action={saveStoreSettingsAction}
      submitLabel="Guardar configuración"
      className="grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
    >
      {(values) => {
        const regimeDefault = values?.taxRegime ?? settings.taxRegime;
        const thresholdDefault =
          values?.annualRevenueAlertUvt ?? String(settings.annualRevenueAlertUvt);
        const currencyDefault = values?.currency ?? settings.currency;
        const timeZoneDefault = values?.timeZone ?? settings.timeZone;
        const prefixDefault = values?.orderNumberPrefix ?? settings.orderNumberPrefix;
        const paddingDefault = values?.orderNumberPadding ?? String(settings.orderNumberPadding);
        const clickAndCollectDefault = values
          ? ["on", "true"].includes(values.clickAndCollectEnabled ?? "")
          : settings.clickAndCollectEnabled;
        const localDeliveryDefault = values
          ? ["on", "true"].includes(values.localDeliveryEnabled ?? "")
          : settings.localDeliveryEnabled;

        return (
          <>
            <div className="space-y-2">
              <Label htmlFor="settings-regime">Régimen tributario</Label>
              <select
                key={`settings-regime-${regimeDefault}`}
                id="settings-regime"
                name="taxRegime"
                defaultValue={regimeDefault}
                className={selectClass}
              >
                <option value="NO_RESPONSABLE_IVA">No responsable de IVA</option>
                <option value="RESPONSABLE_IVA">Responsable de IVA</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-threshold">Alerta de ingresos anuales (UVT)</Label>
              <Input
                key={`settings-threshold-${thresholdDefault}`}
                id="settings-threshold"
                name="annualRevenueAlertUvt"
                type="number"
                min="1"
                defaultValue={thresholdDefault}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-currency">Moneda ISO</Label>
              <Input
                key={`settings-currency-${currencyDefault}`}
                id="settings-currency"
                name="currency"
                defaultValue={currencyDefault}
                maxLength={3}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-timezone">Zona horaria IANA</Label>
              <Input
                key={`settings-timezone-${timeZoneDefault}`}
                id="settings-timezone"
                name="timeZone"
                defaultValue={timeZoneDefault}
                maxLength={64}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-prefix">Prefijo de orden</Label>
              <Input
                key={`settings-prefix-${prefixDefault}`}
                id="settings-prefix"
                name="orderNumberPrefix"
                defaultValue={prefixDefault}
                maxLength={12}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-padding">Dígitos del consecutivo</Label>
              <Input
                key={`settings-padding-${paddingDefault}`}
                id="settings-padding"
                name="orderNumberPadding"
                type="number"
                min="1"
                max="12"
                defaultValue={paddingDefault}
                required
              />
            </div>
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                key={`settings-cac-${String(clickAndCollectDefault)}`}
                type="checkbox"
                name="clickAndCollectEnabled"
                defaultChecked={clickAndCollectDefault}
                className="size-4 accent-primary"
              />
              Habilitar Click & Collect
            </label>
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input
                key={`settings-flex-${String(localDeliveryDefault)}`}
                type="checkbox"
                name="localDeliveryEnabled"
                defaultChecked={localDeliveryDefault}
                className="size-4 accent-primary"
              />
              Habilitar entrega local Flex
            </label>
          </>
        );
      }}
    </StatefulForm>
  );
}

export function CmsMediaUploadForm() {
  return (
    <StatefulForm
      action={uploadCmsMediaAction}
      submitLabel="Procesar y subir imagen"
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      {(values) => {
        const altDefault = values?.altText ?? "";
        return (
          <>
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
              <Input
                key={`media-alt-${altDefault}`}
                id="media-alt"
                name="altText"
                defaultValue={altDefault}
                required
                maxLength={250}
              />
            </div>
          </>
        );
      }}
    </StatefulForm>
  );
}

export function CmsMediaEditForm({ mediaId, altText }: { mediaId: string; altText: string }) {
  return (
    <div className="space-y-3">
      <StatefulForm action={updateCmsMediaAltAction} submitLabel="Guardar texto alternativo">
        {(values) => {
          const currentAlt = values?.altText ?? altText;
          return (
            <>
              <input type="hidden" name="mediaId" value={mediaId} />
              <div className="space-y-2">
                <Label htmlFor={`alt-${mediaId}`}>Texto alternativo</Label>
                <Input
                  key={`alt-${mediaId}-${currentAlt}`}
                  id={`alt-${mediaId}`}
                  name="altText"
                  defaultValue={currentAlt}
                  required
                  maxLength={250}
                />
              </div>
            </>
          );
        }}
      </StatefulForm>
      <StatefulForm action={archiveCmsMediaAction} submitLabel="Archivar activo">
        {() => <input type="hidden" name="mediaId" value={mediaId} />}
      </StatefulForm>
    </div>
  );
}
