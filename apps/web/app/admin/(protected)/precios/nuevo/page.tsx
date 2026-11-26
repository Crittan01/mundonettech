import { hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { BundleForm, CouponForm, WholesaleTierForm } from "@/components/admin/pricing-forms";
import { single } from "@/lib/admin-search-params";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Crear registro comercial" };
const types = ["mayoristas", "cupones", "bundles"] as const;
type PricingCreateType = (typeof types)[number];
const typeLabels: Record<PricingCreateType, string> = {
  mayoristas: "Escala mayorista",
  cupones: "Cupón",
  bundles: "Paquete",
};

export default async function NewPricingPage({ searchParams }: PageProps<"/admin/precios/nuevo">) {
  const session = await requireAdminPage("pricing:write");
  if (!hasAdminPermission(session.profile.role, "pricing:write")) notFound();
  const query = await searchParams;
  const rawType = single(query.tipo)?.trim();
  const type: PricingCreateType = !rawType
    ? "mayoristas"
    : (types as readonly string[]).includes(rawType)
      ? (rawType as PricingCreateType)
      : rawType === "paquetes"
        ? "bundles"
        : "mayoristas";
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/admin/precios?vista=${type}`}
          className="text-sm text-primary hover:underline"
        >
          Volver a precios
        </Link>
        <h1 className="mt-3 text-3xl font-bold">Crear {typeLabels[type].toLowerCase()}</h1>
        <p className="mt-2 text-muted-foreground">
          La operación exige MFA reciente y registra el actor, antes/después y contexto de
          solicitud.
        </p>
        <nav aria-label="Tipo de registro comercial" className="mt-4 flex flex-wrap gap-2">
          {types.map((item) => (
            <Link
              key={item}
              href={`/admin/precios/nuevo?tipo=${item}`}
              aria-current={type === item ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden ${type === item ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent"}`}
            >
              {typeLabels[item]}
            </Link>
          ))}
        </nav>
      </div>
      <CmsStepUp session={session} />
      {type === "mayoristas" ? (
        <WholesaleTierForm
          defaults={{
            scope: "VARIANT",
            target: "",
            minimumQuantity: "10",
            unitPriceCents: "",
            active: true,
          }}
        />
      ) : null}
      {type === "cupones" ? (
        <CouponForm
          defaults={{
            code: "",
            name: "",
            discountType: "PERCENTAGE",
            status: "DRAFT",
            percentageBps: "1000",
            amountCents: "",
            maximumDiscountCents: "",
            minimumSubtotalCents: "0",
            startsAt: "",
            endsAt: "",
            maximumUsages: "",
            perCustomerUsages: "",
            productSlugs: "",
            categorySlugs: "",
          }}
        />
      ) : null}
      {type === "bundles" ? (
        <BundleForm
          defaults={{
            slug: "",
            name: "",
            description: "",
            status: "DRAFT",
            priceCents: "",
            discountCents: "0",
            items: "",
          }}
        />
      ) : null}
    </div>
  );
}
