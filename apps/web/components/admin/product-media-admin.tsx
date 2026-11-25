import type { CatalogMedia } from "@mundonettech/db";

import {
  CatalogMediaEditForm,
  CatalogMediaUploadForm,
} from "@/components/admin/catalog-media-forms";
import { ProductMediaGallery } from "@/components/catalog/product-media-gallery";

type AdminProductMedia = CatalogMedia & {
  readonly status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  readonly mimeType: string;
  readonly frameCount: number | null;
  readonly position: number;
  readonly deletedAt: Date | null;
};

const mediaTypeLabels = {
  IMAGE: "Imagen",
  VIDEO: "Video",
  SPIN_360: "Secuencia 360°",
  MODEL_3D: "Modelo 3D",
  GAUSSIAN_SPLAT: "Vista volumétrica",
} as const;

const statusLabels = {
  PENDING: "Pendiente",
  PROCESSING: "En procesamiento",
  READY: "Publicado",
  FAILED: "Con error",
} as const;

export function ProductMediaAdmin({
  productId,
  productName,
  media,
  variants,
  origin,
  canWrite,
}: {
  productId: string;
  productName: string;
  media: readonly AdminProductMedia[];
  variants: Array<{ id: string; sku: string }>;
  origin: string | null;
  canWrite: boolean;
}) {
  const activePositions = media
    .filter((item) => item.deletedAt === null)
    .map((item) => item.position);
  const maxPosition = activePositions.length > 0 ? Math.max(...activePositions) : 0;

  return (
    <section aria-labelledby="admin-product-media" className="space-y-5">
      <div>
        <h2 id="admin-product-media" className="text-2xl font-bold">
          Medios del producto
        </h2>
        <p className="mt-2 text-muted-foreground">
          Imágenes responsivas, recorridos 360° y modelos 3D/AR almacenados en R2. El archivo
          conserva el objeto y la auditoría, pero lo retira de la ficha pública.
        </p>
      </div>
      {canWrite ? (
        <CatalogMediaUploadForm productId={productId} variants={variants} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Puedes consultar y previsualizar los medios. Tu rol no permite subirlos, editarlos ni
          archivarlos.
        </p>
      )}
      {media.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <h3 className="text-lg font-semibold">Este producto aún no tiene medios</h3>
          <p className="mt-2 text-muted-foreground">
            {canWrite
              ? "Sube una imagen, una secuencia 360° o un modelo 3D para publicarlo en la ficha."
              : "No hay recursos multimedia para consultar."}
          </p>
        </div>
      ) : (
        <ul className="space-y-5" aria-label={`Medios de ${productName}`}>
          {media.map((item) => {
            const variant = variants.find((candidate) => candidate.id === item.variantId);
            const archived = item.deletedAt !== null;
            return (
              <li
                key={item.id}
                className="space-y-4 rounded-xl border border-border bg-card p-4"
                aria-label={`${mediaTypeLabels[item.mediaType]}: ${item.altText}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {mediaTypeLabels[item.mediaType]} ·{" "}
                      {archived ? "Archivado" : statusLabels[item.status]}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {variant
                        ? `Variante ${variant.sku}`
                        : item.variantId
                          ? "Variante archivada"
                          : "Todo el producto"}{" "}
                      · Posición {item.position}
                      {item.frameCount ? ` · ${item.frameCount} fotogramas` : ""}
                      {item.usdzKey ? " · Incluye USDZ para AR" : ""}
                    </p>
                  </div>
                  <span className="rounded-md bg-secondary px-2 py-1 font-mono text-xs text-secondary-foreground">
                    {item.mimeType}
                  </span>
                </div>
                <ProductMediaGallery
                  media={[item]}
                  origin={origin}
                  productName={`${productName}: ${item.altText}`}
                  priorityFirstImage={false}
                />
                {canWrite && !archived ? (
                  <CatalogMediaEditForm
                    productId={productId}
                    mediaId={item.id}
                    altText={item.altText}
                    position={item.position}
                    maxPosition={maxPosition}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
