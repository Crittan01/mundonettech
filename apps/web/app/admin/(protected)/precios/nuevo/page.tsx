import { hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { BundleForm, CouponForm, WholesaleTierForm } from "@/components/admin/pricing-forms";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Crear registro comercial" };
const types = ["mayoristas", "cupones", "bundles"] as const;

export default async function NewPricingPage({ searchParams }: PageProps<"/admin/precios/nuevo">) {
  const session = await requireAdminPage("pricing:write");
  const query = await searchParams;
  const type = types.includes(query.tipo as (typeof types)[number])
    ? (query.tipo as (typeof types)[number])
    : null;
  if (!type || !hasAdminPermission(session.profile.role, "pricing:write")) notFound();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/admin/precios?vista=${type}`}
          className="text-sm text-primary hover:underline"
        >
          Volver a precios
        </Link>
        <h1 className="mt-3 text-3xl font-bold">
          Crear{" "}
          {type === "mayoristas" ? "escala mayorista" : type === "cupones" ? "cupón" : "bundle"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          La operación exige MFA reciente y registra el actor, antes/después y contexto de
          solicitud.
        </p>
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
