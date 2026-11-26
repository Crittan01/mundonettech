import { formatCopCents, hasAdminPermission, maskEmail, maskName } from "@mundonettech/core";
import { CartService } from "@mundonettech/db";
import Link from "next/link";

import { AssistedSaleCreateForm } from "@/components/admin/assisted-sale-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Venta asistida" };
const statuses = ["ACTIVE", "CONVERTED", "CANCELLED", "EXPIRED"] as const;
const statusLabels = {
  ACTIVE: "Activa",
  CONVERTED: "Convertida",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
} as const;
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function AssistedSalesPage({
  searchParams,
}: PageProps<"/admin/venta-asistida">) {
  const session = await requireAdminPage("sales:read");
  const query = await searchParams;
  const status = statuses.includes(query.estado as (typeof statuses)[number])
    ? (query.estado as (typeof statuses)[number])
    : undefined;
  const requestedPage = Number.parseInt(String(query.pagina ?? "1"), 10) || 1;
  const db = getDatabase();
  const [now, result] = await Promise.all([
    getDatabaseClock(db),
    new CartService(db).listAssisted({
      page: Math.max(1, Math.min(10_000, requestedPage)),
      pageSize: 20,
      ...(status ? { status } : {}),
    }),
  ]);
  const canWrite = hasAdminPermission(session.profile.role, "sales:write");
  const href = (page: number) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("pagina", String(page));
    if (status) params.set("estado", status);
    const qs = params.toString();
    return qs ? `/admin/venta-asistida?${qs}` : "/admin/venta-asistida";
  };
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Venta asistida</h1>
        <p className="mt-2 text-muted-foreground">
          Carritos preparados por asesores con tokens opacos, vigencia, precios vigentes y
          aceptación de un solo uso.
        </p>
      </div>
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          <section aria-labelledby="new-assisted">
            <h2 id="new-assisted" className="mb-4 text-xl font-semibold">
              Nueva venta
            </h2>
            <AssistedSaleCreateForm />
          </section>
        </>
      ) : null}
      <form
        key={status ?? ""}
        action="/admin/venta-asistida"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4"
      >
        <div className="space-y-2">
          <label htmlFor="assisted-status" className="text-sm font-medium">
            Estado
          </label>
          <Select id="assisted-status" name="estado" defaultValue={status ?? ""} fullWidth={false}>
            <option value="">Todos</option>
            {statuses.map((item) => (
              <option key={item} value={item}>
                {statusLabels[item]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {status ? (
          <Link
            href="/admin/venta-asistida"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <p role="status" className="text-sm text-muted-foreground">
        {result.total} {result.total === 1 ? "venta" : "ventas"}
        {result.total > 0 ? ` · página ${result.page} de ${result.totalPages}` : ""}
      </p>
      {result.items.length ? (
        <section aria-label="Ventas asistidas" className="space-y-3">
          {result.items.map((cart) => {
            const effectiveExpiresAt = cart.assistedExpiresAt ?? cart.expiresAt;
            const expired =
              cart.status === "EXPIRED" || (cart.status === "ACTIVE" && effectiveExpiresAt <= now);
            return (
              <article key={cart.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">
                      <Link href={`/admin/venta-asistida/${cart.id}`} className="hover:underline">
                        Venta <span className="font-mono text-xs">{cart.id}</span>
                      </Link>
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Cliente: {cart.customer ? maskEmail(cart.customer.email) : "Invitado"} ·
                      Asesor:{" "}
                      {cart.assistedBy ? maskName(cart.assistedBy.displayName) : "No disponible"}
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-lg font-bold">{formatCopCents(cart.totalCents)}</p>
                    <p className="text-sm text-muted-foreground">
                      {expired ? "Expirada" : statusLabels[cart.status]} · {cart.itemCount} líneas
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Vence: {dateFormatter.format(effectiveExpiresAt)} ·{" "}
                  {cart.assistedClaimedAt
                    ? `Aceptada ${dateFormatter.format(cart.assistedClaimedAt)}`
                    : cart.assistedTokenHash
                      ? "Enlace emitido"
                      : "Sin enlace"}
                </p>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <h2 className="text-xl font-semibold">No hay ventas con estos criterios</h2>
          <p className="mt-2 text-muted-foreground">Crea una venta o cambia el filtro de estado.</p>
        </section>
      )}
      {result.total > 0 ? (
        <nav aria-label="Paginación de ventas" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Página {result.page} de {result.totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(result.page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {result.page < result.totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href(result.page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
