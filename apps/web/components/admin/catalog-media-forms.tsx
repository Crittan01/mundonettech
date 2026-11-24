"use client";

import { useActionState, useState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { initialActionState } from "@/lib/action-state";
import {
  archiveCatalogMediaAction,
  updateCatalogMediaAction,
  uploadCatalogMediaAction,
} from "@/lib/actions/admin-catalog";

type MediaKind = "IMAGE" | "SPIN_360" | "MODEL_3D";

export function CatalogMediaUploadForm({
  productId,
  variants,
}: {
  productId: string;
  variants: Array<{ id: string; sku: string }>;
}) {
  const [state, action, pending] = useActionState(uploadCatalogMediaAction, initialActionState);
  const [mediaType, setMediaType] = useState<MediaKind>("IMAGE");
  const values = state.status === "error" ? state.values : undefined;
  const id = `catalog-media-${productId}`;
  const altText = values?.altText ?? "";
  const variantId = values?.variantId ?? "";

  return (
    <form
      action={action}
      aria-label="Añadir medio del producto"
      aria-busy={pending}
      className="space-y-5 rounded-xl border border-border bg-card p-5"
    >
      <input type="hidden" name="productId" value={productId} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${id}-type`}>Tipo de medio</Label>
          <Select
            id={`${id}-type`}
            name="mediaType"
            value={mediaType}
            onChange={(event) => setMediaType(event.target.value as MediaKind)}
            disabled={pending}
          >
            <option value="IMAGE">Imagen con derivados AVIF/WebP</option>
            <option value="SPIN_360">Secuencia 360°</option>
            <option value="MODEL_3D">Modelo 3D / AR</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-variant`}>Asociación</Label>
          <Select
            key={`${id}-variant-${variantId}`}
            id={`${id}-variant`}
            name="variantId"
            defaultValue={variantId}
            disabled={pending}
          >
            <option value="">Producto y todas sus variantes</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                Variante {variant.sku}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-alt`}>Texto alternativo</Label>
        <Input
          key={`${id}-alt-${altText}`}
          id={`${id}-alt`}
          name="altText"
          defaultValue={altText}
          required
          maxLength={250}
          disabled={pending}
          aria-describedby={`${id}-alt-help`}
        />
        <p id={`${id}-alt-help`} className="text-sm text-muted-foreground">
          Describe el contenido visual para quienes usan lectores de pantalla.
        </p>
      </div>
      {mediaType === "IMAGE" ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-image`}>Imagen JPEG, PNG, WebP, HEIC o AVIF</Label>
          <Input
            id={`${id}-image`}
            name="file"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
            required
            disabled={pending}
            aria-describedby={`${id}-image-help`}
          />
          <p id={`${id}-image-help`} className="text-sm text-muted-foreground">
            Máximo 20 MiB. Se eliminan los metadatos y se generan derivados AVIF/WebP.
          </p>
        </div>
      ) : null}
      {mediaType === "SPIN_360" ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-frames`}>Fotogramas ordenados de la secuencia</Label>
          <Input
            id={`${id}-frames`}
            name="frames"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
            multiple
            required
            disabled={pending}
            aria-describedby={`${id}-frames-help`}
          />
          <p id={`${id}-frames-help`} className="text-sm text-muted-foreground">
            Selecciona entre 2 y 120 imágenes en orden de giro. Máximo 20 MiB por imagen y 100 MiB
            en total.
          </p>
        </div>
      ) : null}
      {mediaType === "MODEL_3D" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${id}-glb`}>Modelo GLB 2.0 autocontenido</Label>
            <Input
              id={`${id}-glb`}
              name="glb"
              type="file"
              accept=".glb,model/gltf-binary"
              required
              disabled={pending}
              aria-describedby={`${id}-glb-help`}
            />
            <p id={`${id}-glb-help`} className="text-sm text-muted-foreground">
              Máximo 50 MiB, sin recursos externos ni compresión Draco/Meshopt.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-usdz`}>Modelo USDZ para AR en iOS (opcional)</Label>
            <Input
              id={`${id}-usdz`}
              name="usdz"
              type="file"
              accept=".usdz,model/vnd.usdz+zip"
              disabled={pending}
              aria-describedby={`${id}-usdz-help`}
            />
            <p id={`${id}-usdz-help`} className="text-sm text-muted-foreground">
              Máximo 25 MiB. Se validan la etapa raíz y todas las texturas embebidas.
            </p>
          </div>
        </div>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Validando, procesando y subiendo…" : "Procesar y publicar medio"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function CatalogMediaEditForm({
  productId,
  mediaId,
  altText,
  position,
  maxPosition,
}: {
  productId: string;
  mediaId: string;
  altText: string;
  position: number;
  maxPosition: number;
}) {
  const [state, action, pending] = useActionState(updateCatalogMediaAction, initialActionState);
  const values = state.status === "error" ? state.values : undefined;
  const currentAlt = values?.altText ?? altText;
  const currentPosition = values?.position ?? String(position);
  return (
    <div className="space-y-3">
      <form action={action} aria-busy={pending} className="space-y-3">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="mediaId" value={mediaId} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <div className="space-y-2">
            <Label htmlFor={`media-alt-${mediaId}`}>Texto alternativo</Label>
            <Input
              key={`media-alt-${mediaId}-${currentAlt}`}
              id={`media-alt-${mediaId}`}
              name="altText"
              defaultValue={currentAlt}
              required
              maxLength={250}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`media-position-${mediaId}`}>Posición</Label>
            <Input
              key={`media-position-${mediaId}-${currentPosition}`}
              id={`media-position-${mediaId}`}
              name="position"
              type="number"
              min={0}
              max={maxPosition}
              step={1}
              inputMode="numeric"
              defaultValue={currentPosition}
              required
              disabled={pending}
            />
          </div>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Guardando…" : "Guardar texto y orden"}
        </Button>
        <FormMessage state={state} />
      </form>
      <ArchiveCatalogMediaForm productId={productId} mediaId={mediaId} />
    </div>
  );
}

function ArchiveCatalogMediaForm({ productId, mediaId }: { productId: string; mediaId: string }) {
  const [state, action, pending] = useActionState(archiveCatalogMediaAction, initialActionState);
  return (
    <form action={action} aria-busy={pending} className="space-y-2">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="mediaId" value={mediaId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Archivando…" : "Archivar medio"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
