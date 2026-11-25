import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PricingService } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Precios y promociones" };
const views = ["mayoristas", "cupones", "bundles"] as const;
type View = (typeof views)[number];
const viewLabels: Record<View, string> = {
  mayoristas: "Escalas mayoristas",
  cupones: "Cupones",
  bundles: "Bundles",
};
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

function viewHref(view: View, page: number): string {
  return `/admin/precios?vista=${view}&pagina=${page}`;
}

export default async function AdminPricingPage({ searchParams }: PageProps<"/admin/precios">) {
  const session = await requireAdminPage("pricing:read");
  const query = await searchParams;
  const view = views.includes(query.vista as View) ? (query.vista as View) : "mayoristas";
  const requestedPage = Number.parseInt(String(query.pagina ?? "1"), 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const service = new PricingService(getDatabase());
  const [wholesale, coupons, bundles] = await Promise.all([
    view === "mayoristas" ? service.listWholesaleTiers({ page, pageSize: 20 }) : null,
    view === "cupones" ? service.listCoupons({ page, pageSize: 20 }) : null,
    view === "bundles" ? service.listBundles({ page, pageSize: 20 }) : null,
  ]);
  const result = wholesale ?? coupons ?? bundles!;
  const canWrite = hasAdminPermission(session.profile.role, "pricing:write");
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Precios y promociones</h1>
          <p className="mt-2 text-muted-foreground">
            Escalas por volumen, cupones con FKs reales y bundles protegidos para carritos activos.
          </p>
        </div>
        {canWrite ? (
          <Button asChild>
            <Link href={`/admin/precios/nuevo?tipo=${view}`}>
              Crear en {viewLabels[view].toLowerCase()}
            </Link>
          </Button>
        ) : null}
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {query.creado === "1" || query.archivado === "1" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          La operación se completó y quedó registrada en auditoría.
        </p>
      ) : null}
      <nav aria-label="Tipos de precios" className="flex flex-wrap gap-2">
        {views.map((item) => (
          <Link
            key={item}
            href={viewHref(item, 1)}
            aria-current={view === item ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm font-medium ${view === item ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent"}`}
          >
            {viewLabels[item]}
          </Link>
        ))}
      </nav>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} registros · página {result.page} de {result.totalPages}
      </p>
      {result.total === 0 ? (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay registros en esta sección</h2>
          <p className="mt-2 text-muted-foreground">
            Crea el primero con MFA reciente; las mutaciones quedan auditadas.
          </p>
        </section>
      ) : null}
      {wholesale ? (
        <section aria-label="Escalas mayoristas" className="space-y-3">
          {wholesale.items.map((tier) => {
            const target =
              tier.scope === "GLOBAL"
                ? "Todo el catálogo"
                : (tier.variant?.sku ??
                  tier.product?.slug ??
                  tier.category?.slug ??
                  "Referencia archivada");
            return (
              <article
                key={tier.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h2 className="font-semibold">{target}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {tier.scope} · desde {tier.minimumQuantity} unidades ·{" "}
                    {tier.active ? "Activa" : "Inactiva"}
                  </p>
                </div>
                <div className="sm:text-right">
                  <p className="text-lg font-bold">{formatCopCents(tier.unitPriceCents)}</p>
                  <Link
                    href={`/admin/precios/mayoristas/${tier.id}`}
                    className="text-sm text-primary hover:underline"
                  >
                    Ver y editar
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}
      {coupons ? (
        <section aria-label="Cupones" className="space-y-3">
          {coupons.items.map((coupon) => (
            <article key={coupon.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-mono font-semibold">{coupon.code}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {coupon.name} · {coupon.status} · {coupon._count.usages} usos históricos
                  </p>
                </div>
                <div className="sm:text-right">
                  <p className="text-lg font-bold">
                    {coupon.discountType === "PERCENTAGE"
                      ? `${(coupon.percentageBps ?? 0) / 100} %`
                      : formatCopCents(coupon.amountCents ?? 0n)}
                  </p>
                  <Link
                    href={`/admin/precios/cupones/${coupon.id}`}
                    className="text-sm text-primary hover:underline"
                  >
                    Ver y editar
                  </Link>
                </div>
              </div>
              <dl className="mt-4 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
                <div>
                  <dt className="inline">Mínimo: </dt>
                  <dd className="inline">{formatCopCents(coupon.minimumSubtotalCents)}</dd>
                </div>
                <div>
                  <dt className="inline">Inicio: </dt>
                  <dd className="inline">
                    {coupon.startsAt ? dateFormatter.format(coupon.startsAt) : "Inmediato"}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Fin: </dt>
                  <dd className="inline">
                    {coupon.endsAt ? dateFormatter.format(coupon.endsAt) : "Sin fecha"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                {coupon.products.length} productos y {coupon.categories.length} categorías
                restringidas · límites {coupon.maximumUsages ?? "∞"} total /{" "}
                {coupon.perCustomerUsages ?? "∞"} por cliente
              </p>
            </article>
          ))}
        </section>
      ) : null}
      {bundles ? (
        <section aria-label="Bundles" className="space-y-3">
          {bundles.items.map((bundle) => {
            const components = bundle.items.reduce(
              (sum, item) => sum + item.variant.priceCents * BigInt(item.quantity),
              0n,
            );
            const base = bundle.priceCents ?? components;
            const invalidPrice =
              bundle.discountCents > base || base - bundle.discountCents > components;
            const effective = invalidPrice ? 0n : base - bundle.discountCents;
            return (
              <article key={bundle.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">{bundle.name}</h2>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {bundle.slug} · {bundle.status}
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-lg font-bold">
                      {invalidPrice ? "Precio no vendible" : formatCopCents(effective)}
                    </p>
                    {invalidPrice ? (
                      <p role="alert" className="mt-1 text-sm text-destructive">
                        Ajusta el precio base o el descuento: supera el total actual de componentes.
                      </p>
                    ) : null}
                    <Link
                      href={`/admin/precios/bundles/${bundle.id}`}
                      className="text-sm text-primary hover:underline"
                    >
                      Ver y editar
                    </Link>
                  </div>
                </div>
                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {bundle.items.map((item) => (
                    <li key={item.id}>
                      {item.quantity} × {item.variant.sku} · {item.variant.product.name}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>
      ) : null}
      <nav aria-label="Paginación de precios" className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Página {result.page} de {result.totalPages}
        </span>
        <div className="flex gap-2">
          {result.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={viewHref(view, result.page - 1)}>Anterior</Link>
            </Button>
          ) : null}
          {result.page < result.totalPages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={viewHref(view, result.page + 1)}>Siguiente</Link>
            </Button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
