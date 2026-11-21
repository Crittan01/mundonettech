import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PricingService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  ArchivePricingForm,
  BundleForm,
  CouponForm,
  WholesaleTierForm,
} from "@/components/admin/pricing-forms";
import { bogotaInputValue } from "@/lib/admin-pricing-presenters";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = {
  title: "Editar registro comercial",
  robots: { index: false, follow: false },
};
const types = ["mayoristas", "cupones", "bundles"] as const;
type PricingType = (typeof types)[number];

export default async function EditPricingPage({
  params,
  searchParams,
}: PageProps<"/admin/precios/[tipo]/[id]">) {
  const [{ tipo }, query] = await Promise.all([params, searchParams]);
  const session = await requireAdminPage("pricing:read");
  const type = types.includes(tipo as PricingType) ? (tipo as PricingType) : null;
  const { id } = await params;
  if (!type || !z.string().uuid().safeParse(id).success) notFound();
  const service = new PricingService(getDatabase());
  const [wholesale, coupon, bundle] = await Promise.all([
    type === "mayoristas" ? service.getWholesaleTier(id) : null,
    type === "cupones" ? service.getCoupon(id) : null,
    type === "bundles" ? service.getBundle(id) : null,
  ]);
  const record = wholesale ?? coupon ?? bundle;
  if (!record) notFound();
  const canWrite = hasAdminPermission(session.profile.role, "pricing:write");
  const title = wholesale
    ? (wholesale.variant?.sku ??
      wholesale.product?.name ??
      wholesale.category?.name ??
      "Escala global")
    : coupon
      ? coupon.code
      : bundle!.name;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/admin/precios?vista=${type}`}
          className="text-sm text-primary hover:underline"
        >
          Volver a precios
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{title}</h1>
        <p className="mt-2 text-muted-foreground">
          Registro{" "}
          {type === "mayoristas"
            ? "de escala mayorista"
            : type === "cupones"
              ? "de cupón"
              : "de bundle"}{" "}
          · ID <span className="font-mono text-xs">{id}</span>
        </p>
      </div>
      {query.creado === "1" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          Registro creado con persistencia y auditoría completas.
        </p>
      ) : null}
      {!canWrite ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">Vista de solo lectura</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Tu rol permite consultar esta configuración, pero no modificarla ni archivarla.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div>
              <dt className="inline font-medium">Estado: </dt>
              <dd className="inline">
                {wholesale
                  ? wholesale.active
                    ? "Activa"
                    : "Inactiva"
                  : (coupon ?? bundle)!.status}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Actualizado: </dt>
              <dd className="inline">{record.updatedAt.toISOString()}</dd>
            </div>
            {coupon ? (
              <div>
                <dt className="inline font-medium">Subtotal mínimo: </dt>
                <dd className="inline">{formatCopCents(coupon.minimumSubtotalCents)}</dd>
              </div>
            ) : null}
            {bundle ? (
              <div>
                <dt className="inline font-medium">Descuento: </dt>
                <dd className="inline">{formatCopCents(bundle.discountCents)}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          {wholesale ? (
            <WholesaleTierForm
              defaults={{
                id,
                scope: wholesale.scope,
                target:
                  wholesale.variant?.sku ??
                  wholesale.product?.slug ??
                  wholesale.category?.slug ??
                  "",
                minimumQuantity: String(wholesale.minimumQuantity),
                unitPriceCents: wholesale.unitPriceCents.toString(),
                active: wholesale.active,
              }}
            />
          ) : null}
          {coupon ? (
            <CouponForm
              defaults={{
                id,
                code: coupon.code,
                name: coupon.name,
                discountType: coupon.discountType,
                status: coupon.status === "ACTIVE" ? "ACTIVE" : "DRAFT",
                percentageBps: coupon.percentageBps?.toString() ?? "",
                amountCents: coupon.amountCents?.toString() ?? "",
                maximumDiscountCents: coupon.maximumDiscountCents?.toString() ?? "",
                minimumSubtotalCents: coupon.minimumSubtotalCents.toString(),
                startsAt: bogotaInputValue(coupon.startsAt),
                endsAt: bogotaInputValue(coupon.endsAt),
                maximumUsages: coupon.maximumUsages?.toString() ?? "",
                perCustomerUsages: coupon.perCustomerUsages?.toString() ?? "",
                productSlugs: coupon.products.map((entry) => entry.product.slug).join("\n"),
                categorySlugs: coupon.categories.map((entry) => entry.category.slug).join("\n"),
              }}
            />
          ) : null}
          {bundle ? (
            <BundleForm
              defaults={{
                id,
                slug: bundle.slug,
                name: bundle.name,
                description: bundle.description ?? "",
                status: bundle.status === "ACTIVE" ? "ACTIVE" : "DRAFT",
                priceCents: bundle.priceCents?.toString() ?? "",
                discountCents: bundle.discountCents.toString(),
                items: bundle.items
                  .map((item) => `${item.variant.sku} | ${item.quantity}`)
                  .join("\n"),
              }}
            />
          ) : null}
          <ArchivePricingForm id={id} kind={type} />
        </>
      ) : null}
    </div>
  );
}
