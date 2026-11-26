import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { PricingService, type Prisma } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { productStatusLabels, wholesaleScopeLabels } from "@/lib/admin-presenters";
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

function viewHref(view: View, page: number, q = "", estado = ""): string {
  const params = new URLSearchParams();
  params.set("vista", view);
  if (q) params.set("q", q);
  if (estado) params.set("estado", estado);
  if (page > 1) params.set("pagina", String(page));
  return `/admin/precios?${params.toString()}`;
}

export default async function AdminPricingPage({ searchParams }: PageProps<"/admin/precios">) {
  const session = await requireAdminPage("pricing:read");
  const query = await searchParams;
  const view = views.includes(query.vista as View) ? (query.vista as View) : "mayoristas";
  const q =
    typeof query.q === "string"
      ? query.q
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 100)
      : "";
  const allowedStates = view === "mayoristas" ? ["ACTIVE", "INACTIVE"] : ["ACTIVE", "DRAFT"];
  const estado = allowedStates.includes(String(query.estado)) ? String(query.estado) : "";
  const requestedPage = Number.parseInt(String(query.pagina ?? "1"), 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 20;
  const db = getDatabase();
  const service = new PricingService(db);

  const hasFilters = Boolean(q || estado);
  let wholesale: Awaited<ReturnType<PricingService["listWholesaleTiers"]>> | null = null;
  let coupons: Awaited<ReturnType<PricingService["listCoupons"]>> | null = null;
  let bundles: Awaited<ReturnType<PricingService["listBundles"]>> | null = null;

  if (view === "mayoristas") {
    if (!hasFilters) {
      wholesale = await service.listWholesaleTiers({ page, pageSize });
    } else {
      const matchesGlobal = /^(global|todo)/i.test(q);
      const where: Prisma.WholesaleTierWhereInput = {
        deletedAt: null,
        ...(estado === "ACTIVE"
          ? { active: true }
          : estado === "INACTIVE"
            ? { active: false }
            : {}),
        ...(q
          ? {
              OR: [
                ...(matchesGlobal ? [{ scope: "GLOBAL" as const }] : []),
                { variant: { sku: { contains: q, mode: "insensitive" } } },
                { product: { slug: { contains: q, mode: "insensitive" } } },
                { product: { name: { contains: q, mode: "insensitive" } } },
                { category: { slug: { contains: q, mode: "insensitive" } } },
                { category: { name: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      };
      const total = await db.wholesaleTier.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const items = await db.wholesaleTier.findMany({
        where,
        include: {
          variant: { select: { sku: true } },
          product: { select: { slug: true, name: true } },
          category: { select: { slug: true, name: true } },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      });
      wholesale = { items, total, page: safePage, pageSize, totalPages };
    }
  } else if (view === "cupones") {
    if (!hasFilters) {
      coupons = await service.listCoupons({ page, pageSize });
    } else {
      const where: Prisma.CouponWhereInput = {
        deletedAt: null,
        ...(estado === "ACTIVE" || estado === "DRAFT" ? { status: estado } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const total = await db.coupon.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const items = await db.coupon.findMany({
        where,
        include: {
          products: { include: { product: { select: { slug: true, name: true } } } },
          categories: { include: { category: { select: { slug: true, name: true } } } },
          _count: { select: { usages: true } },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      });
      coupons = { items, total, page: safePage, pageSize, totalPages };
    }
  } else {
    if (!hasFilters) {
      bundles = await service.listBundles({ page, pageSize });
    } else {
      const where: Prisma.BundleWhereInput = {
        deletedAt: null,
        ...(estado === "ACTIVE" || estado === "DRAFT" ? { status: estado } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { slug: { contains: q, mode: "insensitive" } },
                { items: { some: { variant: { sku: { contains: q, mode: "insensitive" } } } } },
              ],
            }
          : {}),
      };
      const total = await db.bundle.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const items = await db.bundle.findMany({
        where,
        include: {
          items: {
            include: {
              variant: {
                select: { sku: true, priceCents: true, product: { select: { name: true } } },
              },
            },
            orderBy: { variant: { sku: "asc" } },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      });
      bundles = { items, total, page: safePage, pageSize, totalPages };
    }
  }

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
            className={`inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden ${view === item ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent"}`}
          >
            {viewLabels[item]}
          </Link>
        ))}
      </nav>
      <form
        key={`${view}|${q}|${estado}`}
        action="/admin/precios"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <input type="hidden" name="vista" value={view} />
        <label htmlFor="pricing-search" className="sr-only">
          Buscar en {viewLabels[view].toLowerCase()}
        </label>
        <Input
          id="pricing-search"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder={
            view === "mayoristas"
              ? "SKU, slug o nombre"
              : view === "cupones"
                ? "Código o nombre interno"
                : "Nombre, slug o SKU componente"
          }
          className="min-w-60 flex-1"
        />
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar por estado"
          fullWidth={false}
        >
          <option value="">Todos los estados</option>
          {view === "mayoristas" ? (
            <>
              <option value="ACTIVE">Activas</option>
              <option value="INACTIVE">Inactivas</option>
            </>
          ) : (
            <>
              <option value="ACTIVE">Activos</option>
              <option value="DRAFT">Borradores</option>
            </>
          )}
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href={viewHref(view, 1)}
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} {result.total === 1 ? "registro" : "registros"}
        {result.total > 0 ? ` · página ${result.page} de ${result.totalPages}` : ""}
      </p>
      {result.total === 0 ? (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">
            {hasFilters
              ? "No hay registros con estos criterios"
              : "No hay registros en esta sección"}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {hasFilters
              ? "Ajusta la búsqueda o limpia los filtros para consultar todos los registros."
              : "Crea el primero con MFA reciente; las mutaciones quedan auditadas."}
          </p>
        </section>
      ) : null}
      {wholesale && wholesale.items.length > 0 ? (
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
                <div className="min-w-0">
                  <h2 className="font-semibold break-all">{target}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {(wholesaleScopeLabels as Record<string, string | undefined>)[tier.scope] ??
                      tier.scope}{" "}
                    · desde {tier.minimumQuantity} unidades · {tier.active ? "Activa" : "Inactiva"}
                  </p>
                </div>
                <div className="sm:text-right">
                  <p className="text-lg font-bold">{formatCopCents(tier.unitPriceCents)}</p>
                  <Link
                    href={`/admin/precios/mayoristas/${tier.id}`}
                    className="text-sm text-primary hover:underline"
                  >
                    Ver y editar <span className="sr-only">escala mayorista {target}</span>
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}
      {coupons && coupons.items.length > 0 ? (
        <section aria-label="Cupones" className="space-y-3">
          {coupons.items.map((coupon) => (
            <article key={coupon.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-mono font-semibold break-all">{coupon.code}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {coupon.name} ·{" "}
                    {(productStatusLabels as Record<string, string | undefined>)[coupon.status] ??
                      coupon.status}{" "}
                    · {coupon._count.usages} usos históricos
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
                    Ver y editar <span className="sr-only">cupón {coupon.code}</span>
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
      {bundles && bundles.items.length > 0 ? (
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
                  <div className="min-w-0">
                    <h2 className="font-semibold">{bundle.name}</h2>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {bundle.slug} ·{" "}
                      {(productStatusLabels as Record<string, string | undefined>)[bundle.status] ??
                        bundle.status}
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
                      Ver y editar <span className="sr-only">paquete {bundle.name}</span>
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
      {result.total > 0 ? (
        <nav aria-label="Paginación de precios" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Página {result.page} de {result.totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={viewHref(view, result.page - 1, q, estado)}>Anterior</Link>
              </Button>
            ) : null}
            {result.page < result.totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={viewHref(view, result.page + 1, q, estado)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
