import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { CatalogService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CatalogProductForm, CatalogVariantForm } from "@/components/admin/catalog-forms";
import { StepUpPrompt } from "@/components/admin/security-manager";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Editar producto" };

export default async function AdminCatalogProductPage({
  params,
}: PageProps<"/admin/catalogo/[id]">) {
  const { id } = await params;
  const session = await requireAdminPage("catalog:read");
  const service = new CatalogService(getDatabase());
  const product = await service.getAdminProduct(id);
  if (!product) notFound();
  const canWrite = hasAdminPermission(session.profile.role, "catalog:write");
  const references = canWrite ? await service.getReferences() : null;
  let stepUp: React.ReactNode = null;
  if (canWrite) {
    const [now, factors] = await Promise.all([
      getDatabaseClock(getDatabase()),
      session.supabase.auth.mfa.listFactors(),
    ]);
    const verifiedFactor = factors.data?.totp.find((factor) => factor.status === "verified");
    const recentMfa = session.lastMfaAt && now.getTime() - session.lastMfaAt.getTime() <= 600_000;
    if (!recentMfa && verifiedFactor) stepUp = <StepUpPrompt factorId={verifiedFactor.id} />;
  }
  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/catalogo" className="text-sm text-primary hover:underline">
          Volver al catálogo
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{product.name}</h1>
        <p className="mt-2 text-muted-foreground">
          {product.brand.name} · {product.category.name} · {product.taxGroup.code}
        </p>
      </div>
      {stepUp}
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
            SKU, precios, identificadores y configuración logística.
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
                costCents: variant.costCents.toString(),
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
    </div>
  );
}
