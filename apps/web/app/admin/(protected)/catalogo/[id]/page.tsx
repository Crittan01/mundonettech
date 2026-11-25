import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { CatalogService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CatalogAttributeForm,
  CatalogAttributeRemoveForm,
  CatalogCompatibilityForm,
  CatalogCompatibilityRemoveForm,
  CatalogProductForm,
  CatalogVariantForm,
} from "@/components/admin/catalog-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { ProductMediaAdmin } from "@/components/admin/product-media-admin";
import { getPublicMediaOrigin } from "@/lib/env";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Editar producto" };

const fitLabels = {
  EXACT: "Compatibilidad directa",
  ADAPTER: "Requiere adaptador",
  NOT_COMPATIBLE: "No compatible",
} as const;

export default async function AdminCatalogProductPage({
  params,
  searchParams,
}: PageProps<"/admin/catalogo/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const session = await requireAdminPage("catalog:read");
  const canWrite = hasAdminPermission(session.profile.role, "catalog:write");
  const service = new CatalogService(getDatabase());
  const product = await service.getAdminProduct(id, { includeCosts: canWrite });
  if (!product) notFound();
  const references = canWrite ? await service.getReferences() : null;
  const justCreated = query.created === "1";

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/admin/catalogo" className="text-primary hover:underline">
            Volver al catálogo
          </Link>
          {product.status === "ACTIVE" ? (
            <Link href={`/producto/${product.slug}`} className="text-primary hover:underline">
              Ver ficha pública
            </Link>
          ) : null}
        </div>
        <h1 className="mt-3 text-3xl font-bold">{product.name}</h1>
        <p className="mt-2 text-muted-foreground">
          {product.brand.name} · {product.category.name} · {product.taxGroup.code}
        </p>
      </div>
      {justCreated ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-4 text-sm font-medium text-foreground"
        >
          Producto creado con su variante inicial y cambio registrado en auditoría. Ahora puedes
          completar variantes adicionales, ficha técnica y compatibilidad.
        </p>
      ) : null}
      {query.mediaArchived === "1" ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-4 text-sm font-medium text-foreground"
        >
          Medio archivado. Se retiró de la ficha pública sin borrar su objeto ni su historial.
        </p>
      ) : null}
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite && references ? (
        <CatalogProductForm
          references={references}
          product={{
            id: product.id,
            slug: product.slug,
            name: product.name,
            shortDescription: product.shortDescription ?? "",
            description: product.description ?? "",
            brandId: product.brandId,
            categoryId: product.categoryId,
            taxGroupId: product.taxGroupId,
            status: product.status,
            authenticity: product.authenticity,
            retractPolicy: product.retractPolicy,
            warrantyMonths: product.warrantyMonths,
            trackSerial: product.trackSerial,
            hasInventoryHistory: product.hasInventoryHistory,
            seoTitle: product.seoTitle ?? "",
            seoDescription: product.seoDescription ?? "",
          }}
        />
      ) : (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">Vista de solo lectura</h2>
          <p className="mt-2 text-muted-foreground">
            Tu rol permite consultar el catálogo, pero no modificarlo.
          </p>
          <p className="mt-4 text-sm">
            Slug: <span className="font-mono">{product.slug}</span> · Estado: {product.status}
          </p>
        </section>
      )}

      <section aria-labelledby="admin-variants" className="space-y-4">
        <div>
          <h2 id="admin-variants" className="text-2xl font-bold">
            Variantes
          </h2>
          <p className="mt-2 text-muted-foreground">
            SKU, precios, identificadores GS1 y configuración logística.
          </p>
        </div>
        {product.variants.map((variant) =>
          canWrite ? (
            <CatalogVariantForm
              key={variant.id}
              productId={product.id}
              variant={{
                id: variant.id,
                sku: variant.sku,
                priceCents: variant.priceCents.toString(),
                costCents: variant.costCents?.toString() ?? "",
                compareAtPriceCents: variant.compareAtPriceCents?.toString() ?? "",
                gtin: variant.gtin ?? "",
                ean: variant.ean ?? "",
                mpn: variant.mpn ?? "",
                weightGrams: variant.weightGrams,
                lengthMillimeters: variant.lengthMillimeters,
                widthMillimeters: variant.widthMillimeters,
                heightMillimeters: variant.heightMillimeters,
                isDefault: variant.isDefault,
                status: variant.status,
              }}
            />
          ) : (
            <article
              key={variant.id}
              className="rounded-xl border border-border bg-card p-4 text-sm"
            >
              <span className="font-mono">{variant.sku}</span> ·{" "}
              {formatCopCents(variant.priceCents.toString())} · {variant.status}
            </article>
          ),
        )}
        {canWrite ? (
          <details className="rounded-xl border border-border bg-card">
            <summary className="cursor-pointer p-4 font-semibold">Añadir otra variante</summary>
            <div className="p-4 pt-0">
              <CatalogVariantForm productId={product.id} />
            </div>
          </details>
        ) : null}
      </section>

      <ProductMediaAdmin
        productId={product.id}
        productName={product.name}
        media={product.media}
        variants={product.variants.map((variant) => ({ id: variant.id, sku: variant.sku }))}
        origin={getPublicMediaOrigin()}
        canWrite={canWrite}
      />

      <section aria-labelledby="admin-attributes" className="space-y-4">
        <div>
          <h2 id="admin-attributes" className="text-2xl font-bold">
            Ficha técnica
          </h2>
          <p className="mt-2 text-muted-foreground">
            Especificaciones tipadas para facetas de búsqueda, ficha pública y comparador.
          </p>
        </div>
        {product.formattedAttributes.length > 0 ? (
          <div className="space-y-3">
            {product.formattedAttributes.map((attr) =>
              canWrite && references ? (
                <div key={attr.id} className="space-y-2">
                  <CatalogAttributeForm
                    productId={product.id}
                    attributes={references.attributes}
                    entry={{
                      id: attr.id,
                      attributeId: attr.attributeId,
                      rawValue: attr.rawValue,
                    }}
                  />
                  <div className="flex justify-end">
                    <CatalogAttributeRemoveForm
                      productId={product.id}
                      attributeValueId={attr.id}
                      label={attr.name}
                    />
                  </div>
                </div>
              ) : (
                <article
                  key={attr.id}
                  className="rounded-xl border border-border bg-card p-4 text-sm"
                >
                  <span className="font-semibold">
                    {attr.name}
                    {attr.unit ? ` (${attr.unit})` : ""}:
                  </span>{" "}
                  {attr.displayValue}
                </article>
              ),
            )}
          </div>
        ) : (
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            Este producto aún no tiene especificaciones técnicas registradas.
          </p>
        )}
        {canWrite && references ? (
          <CatalogAttributeForm productId={product.id} attributes={references.attributes} />
        ) : null}
      </section>

      <section aria-labelledby="admin-compatibility" className="space-y-4">
        <div>
          <h2 id="admin-compatibility" className="text-2xl font-bold">
            Compatibilidad de dispositivos
          </h2>
          <p className="mt-2 text-muted-foreground">
            Equipos compatibles verificados para orientar la compra y prevenir devoluciones.
          </p>
        </div>
        {product.compatibility.length > 0 ? (
          <ul className="space-y-3">
            {product.compatibility.map((link) => {
              const deviceLabel = `${link.device.brand.name} ${link.device.model}${
                link.device.generation ? ` (${link.device.generation})` : ""
              }`;
              return (
                <li
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 text-sm"
                >
                  <div>
                    <p className="font-semibold">{deviceLabel}</p>
                    <p className="text-muted-foreground">
                      {fitLabels[link.fit]}
                      {link.notes ? ` · ${link.notes}` : ""}
                    </p>
                  </div>
                  {canWrite ? (
                    <CatalogCompatibilityRemoveForm
                      productId={product.id}
                      compatibilityId={link.id}
                      label={deviceLabel}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            No se han asociado dispositivos de compatibilidad todavía.
          </p>
        )}
        {canWrite && references ? (
          <CatalogCompatibilityForm
            productId={product.id}
            devices={references.compatibilityDevices}
          />
        ) : null}
      </section>
    </div>
  );
}
