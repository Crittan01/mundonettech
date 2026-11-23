import {
  formatCopCents,
  hasAdminPermission,
  opportunityStatusLabels,
  priceListStatusLabels,
} from "@mundonettech/core";
import { B2bError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  B2bOrganizationAssignmentForm,
  B2bPriceListCreateForm,
  B2bPriceListEditForm,
  B2bPriceListItemForm,
  B2bPriceListStatusForms,
  B2bRemovePriceListItemForm,
  type B2bPriceListFormView,
} from "@/components/admin/b2b-price-list-forms";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { b2bService } from "@/lib/b2b";
import { crmService } from "@/lib/crm";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Canal B2B" };

const querySchema = z.object({
  status: z.enum(["NEW", "QUALIFYING", "PROPOSAL_SENT", "WON", "LOST", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  lista: z.string().uuid().optional(),
});
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const inputFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function dateTimeInput(value: Date | null): string {
  if (!value) return "";
  const parts = Object.fromEntries(
    inputFormatter.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formView(record: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  version: number;
  validFrom: Date | null;
  validTo: Date | null;
}): B2bPriceListFormView {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    version: record.version,
    validFromInput: dateTimeInput(record.validFrom),
    validToInput: dateTimeInput(record.validTo),
  };
}

export default async function B2bPage({ searchParams }: PageProps<"/admin/b2b">) {
  const session = await requireAdminPage("b2b:read");
  const raw = await searchParams;
  const parsed = querySchema.safeParse({
    status: single(raw.status) || undefined,
    page: single(raw.page) || 1,
    lista: single(raw.lista) || undefined,
  });
  const query = parsed.success ? parsed.data : { page: 1 as const };
  const db = getDatabase();
  const service = b2bService(db);
  const canWrite = hasAdminPermission(session.profile.role, "b2b:write");
  const [opportunities, lists, organizations] = await Promise.all([
    service.listOpportunities({
      page: query.page,
      pageSize: 25,
      ...(query.status ? { status: query.status } : {}),
    }),
    service.listPriceLists(),
    crmService(db).listOrganizations(),
  ]);
  const selectedResult =
    parsed.success && query.lista
      ? await service.getPriceList(query.lista).then(
          (record) => ({ record, notFound: false }),
          (error: unknown) => {
            if (error instanceof B2bError && error.code === "NOT_FOUND") {
              return { record: null, notFound: true };
            }
            throw error;
          },
        )
      : null;
  const selected = selectedResult?.record ?? null;
  const selectedNotFound = selectedResult?.notFound ?? false;
  const activeLists = lists.filter((list) => list.status === "ACTIVE").map(formView);
  const totalPages = Math.max(1, Math.ceil(opportunities.total / opportunities.pageSize));
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    params.set("page", String(page));
    return `/admin/b2b?${params.toString()}`;
  };
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Canal B2B</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Oportunidades, listas de precios y propuestas versionadas con importes enteros, MFA
          reciente y trazabilidad hasta el pedido.
        </p>
      </div>
      {canWrite ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
      <section aria-labelledby="b2b-opportunities" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="b2b-opportunities" className="text-2xl font-semibold">
              Oportunidades ({opportunities.total})
            </h2>
            <p className="text-sm text-muted-foreground">
              Página {opportunities.page} de {totalPages}.
            </p>
          </div>
          <form className="flex items-end gap-2" action="/admin/b2b">
            <div className="space-y-2">
              <Label htmlFor="b2b-status">Estado</Label>
              <select
                id="b2b-status"
                name="status"
                defaultValue={query.status ?? ""}
                className="h-11 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Todos</option>
                {Object.entries(opportunityStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline">
              Filtrar
            </Button>
          </form>
        </div>
        {!parsed.success ? (
          <p role="alert" className="text-sm text-destructive">
            Los filtros o la página no son válidos.
          </p>
        ) : null}
        {opportunities.items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
            No hay oportunidades para estos filtros. La captura pública está disponible en{" "}
            <Link href="/empresas" className="text-primary underline">
              /empresas
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {opportunities.items.map((opportunity) => (
              <article key={opportunity.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-lg font-semibold">
                    <Link href={`/admin/b2b/${opportunity.id}`} className="underline">
                      {opportunity.organization.legalName}
                    </Link>
                  </h3>
                  <span className="rounded-md border border-border px-2 py-1 text-xs">
                    {opportunityStatusLabels[opportunity.status]}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {opportunity.contact.givenName} {opportunity.contact.familyName} ·{" "}
                  {opportunity.contact.email}
                </p>
                <p className="mt-2 text-sm">
                  NIT: {opportunity.organization.taxId ?? "No informado"} · Versión comercial{" "}
                  {opportunity.currentVersion}
                </p>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                  {opportunity.requirements}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Registrada {dateFormatter.format(opportunity.createdAt)}
                </p>
              </article>
            ))}
          </div>
        )}
        <div className="flex gap-4">
          {opportunities.page > 1 ? (
            <Link
              className="text-sm text-primary underline"
              href={pageHref(opportunities.page - 1)}
            >
              Página anterior
            </Link>
          ) : null}
          {opportunities.page < totalPages ? (
            <Link
              className="text-sm text-primary underline"
              href={pageHref(opportunities.page + 1)}
            >
              Página siguiente
            </Link>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="b2b-price-lists" className="space-y-4">
        <div>
          <h2 id="b2b-price-lists" className="text-2xl font-semibold">
            Listas de precios
          </h2>
          <p className="text-sm text-muted-foreground">
            Los ítems se editan en borrador; activar una lista congela sus precios para nuevas
            asignaciones.
          </p>
        </div>
        {lists.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            Aún no hay listas B2B.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {lists.map((list) => (
              <Link
                key={list.id}
                href={`/admin/b2b?lista=${list.id}`}
                className="rounded-xl border border-border bg-card p-4 hover:border-primary"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{list.code}</h3>
                  <span className="text-xs">{priceListStatusLabels[list.status]}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{list.name}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {list.itemCount} variantes · {list.organizationCount} organizaciones · v
                  {list.version}
                </p>
              </Link>
            ))}
          </div>
        )}
        {canWrite ? (
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer font-semibold">Crear lista de precios</summary>
            <div className="mt-5">
              <B2bPriceListCreateForm />
            </div>
          </details>
        ) : null}
        {selectedNotFound ? (
          <p role="alert" className="text-sm text-destructive">
            La lista seleccionada ya no existe.
          </p>
        ) : null}
        {selected ? (
          <article className="space-y-5 rounded-xl border border-border bg-card p-5">
            <div>
              <h3 className="text-xl font-semibold">
                {selected.code} · {selected.name}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {priceListStatusLabels[selected.status]} · control de versión {selected.version}
              </p>
              {selected.validFrom || selected.validTo ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Vigencia:{" "}
                  {selected.validFrom ? dateFormatter.format(selected.validFrom) : "sin inicio"} —{" "}
                  {selected.validTo ? dateFormatter.format(selected.validTo) : "sin fin"}
                </p>
              ) : null}
            </div>
            {canWrite && selected.status === "DRAFT" ? (
              <B2bPriceListEditForm record={formView(selected)} />
            ) : null}
            {canWrite ? <B2bPriceListStatusForms record={formView(selected)} /> : null}
            <div className="space-y-3">
              <h4 className="font-semibold">Variantes ({selected.items.length})</h4>
              {selected.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">La lista no tiene precios todavía.</p>
              ) : null}
              {selected.items.map((item) => (
                <div key={item.id}>
                  <p className="mb-1 text-sm">{item.variant.product.name}</p>
                  {canWrite && selected.status === "DRAFT" ? (
                    <B2bRemovePriceListItemForm
                      priceListId={selected.id}
                      itemId={item.id}
                      expectedVersion={selected.version}
                      sku={item.variant.sku}
                      priceCents={item.unitPriceCents.toString()}
                    />
                  ) : (
                    <p className="rounded-lg border border-border p-3 text-sm">
                      <span className="font-mono">{item.variant.sku}</span> ·{" "}
                      {formatCopCents(item.unitPriceCents)}
                    </p>
                  )}
                </div>
              ))}
              {canWrite && selected.status === "DRAFT" ? (
                <B2bPriceListItemForm
                  priceListId={selected.id}
                  expectedVersion={selected.version}
                />
              ) : null}
            </div>
          </article>
        ) : null}
      </section>
      {canWrite ? (
        <section aria-labelledby="b2b-assignments" className="space-y-4">
          <h2 id="b2b-assignments" className="text-2xl font-semibold">
            Asignación a organizaciones
          </h2>
          {activeLists.length === 0 ? (
            <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
              Activa una lista con al menos una variante antes de asignarla.
            </p>
          ) : null}
          {organizations.length === 0 ? (
            <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
              No hay organizaciones activas.
            </p>
          ) : null}
          {activeLists.length > 0
            ? organizations.map((organization) => (
                <B2bOrganizationAssignmentForm
                  key={organization.id}
                  organization={{
                    id: organization.id,
                    legalName: organization.legalName,
                    priceListId: organization.priceListId,
                    version: organization.version,
                  }}
                  activeLists={activeLists}
                />
              ))
            : null}
        </section>
      ) : null}
    </div>
  );
}
