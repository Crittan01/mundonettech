import { hasAdminPermission, type MetaCatalogIssueCode } from "@mundonettech/core";
import type { MetaCapiEventStatus } from "@mundonettech/db";
import { CredentialCursorError } from "@mundonettech/integrations";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  CredentialRotationForm,
  ReencryptCredentialForm,
  RevokeCredentialForm,
  WompiCredentialWizard,
  type IntegrationCredentialView,
} from "@/components/admin/integration-credential-forms";
import { MetaCapiDashboard } from "@/components/admin/meta-capi-dashboard";
import { MetaCatalogRefreshButton } from "@/components/admin/meta-catalog-refresh-button";
import { OperationalCredentialForm } from "@/components/admin/operational-credential-form";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { integrationProviderLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import {
  getIntegrationCredentialVault,
  getIntegrationEnvironment,
  metaCapiService,
} from "@/lib/integrations";
import { getMetaCatalogFeed } from "@/lib/seo-data";
import {
  AdminAuthorizationError,
  getAdminSession,
  requireAdminPage,
} from "@/lib/security/admin-auth";

export const metadata = { title: "Integraciones y bóveda" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");

const feedIssueLabels: Record<MetaCatalogIssueCode, string> = {
  INVALID_ID: "Identificador de variante inválido",
  INVALID_GROUP: "Identificador de grupo inválido",
  INVALID_TITLE: "Título ausente o inválido",
  INVALID_DESCRIPTION: "Descripción ausente o inválida",
  INVALID_LINK: "Enlace de producto inválido",
  MISSING_IMAGE: "Falta una imagen pública real",
  INVALID_IMAGE: "La imagen no tiene una URL segura",
  INVALID_BRAND: "Marca ausente o inválida",
  INVALID_PRICE: "Precio inválido",
  INVALID_INVENTORY: "Inventario inválido",
  INVALID_GTIN: "GTIN inválido; se omite el identificador",
  INVALID_WEIGHT: "Peso logístico inválido",
};

const capiStatusOptions: readonly (readonly [MetaCapiEventStatus, string])[] = [
  ["PENDING", "Estado: Pendiente"],
  ["DISPATCHING", "Estado: Despachando"],
  ["SENT", "Estado: Recibido por Meta"],
  ["SKIPPED", "Estado: Descartado sin envío"],
  ["FAILED", "Estado: Fallo determinista"],
  ["UNCERTAIN", "Estado: Resultado incierto"],
];
const allowedCapiStatuses = new Set<string>(capiStatusOptions.map(([status]) => status));

const uuidCursorPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function integrationsHref(options: {
  cursor?: string;
  capiEstado: MetaCapiEventStatus | "ALL";
  capiPagina: number;
}): string {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.capiEstado !== "ALL") params.set("capiEstado", options.capiEstado);
  if (options.capiPagina > 1) params.set("capiPagina", String(options.capiPagina));
  const qs = params.toString();
  return qs ? `/admin/integraciones?${qs}` : "/admin/integraciones";
}

export default async function IntegrationsPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    cursor?: string | string[];
    capiEstado?: string | string[];
    capiPagina?: string | string[];
  }>;
} = {}) {
  const session = await requireAdminPage("integrations:read");
  let recentSession;
  try {
    recentSession = await getAdminSession({
      permission: "integrations:read",
      requireRecentMfa: true,
    });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) {
      if (error.code === "MFA_STALE") {
        return (
          <div className="space-y-6 rounded-xl border border-border bg-card p-5">
            <div>
              <h1 className="text-3xl font-bold">Integraciones y bóveda</h1>
              <p className="mt-2 text-sm text-muted-foreground" role="alert">
                Confirma tu autenticador para leer los descriptores y eventos de integraciones.
              </p>
            </div>
            <CmsStepUp session={session} />
          </div>
        );
      }
      if (error.code === "AAL1") redirect("/admin/login/mfa");
      redirect(`/admin/login?reason=${error.code === "TIMEOUT" ? "timeout" : "security"}`);
    }
    throw error;
  }
  const environment = getIntegrationEnvironment();
  const params = (await searchParams) ?? {};
  const rawCursor = single(params.cursor);
  const validatedCursor = rawCursor && uuidCursorPattern.test(rawCursor) ? rawCursor : undefined;
  const rawCapiEstado = single(params.capiEstado)?.trim() ?? "ALL";
  const capiEstado: MetaCapiEventStatus | "ALL" = allowedCapiStatuses.has(rawCapiEstado)
    ? (rawCapiEstado as MetaCapiEventStatus)
    : "ALL";
  const requestedCapiPage = parsePositivePage(single(params.capiPagina));

  const vault = getIntegrationCredentialVault();
  const loadCredentials = async () => {
    try {
      const result = await vault.list(recentSession.profile.id, {
        includeRevoked: true,
        limit: 100,
        ...(validatedCursor ? { cursor: validatedCursor } : {}),
      });
      return {
        credentials: result,
        cursor: validatedCursor,
        invalidCursor: rawCursor !== undefined && validatedCursor === undefined,
      };
    } catch (error) {
      if (error instanceof CredentialCursorError) {
        const fallback = await vault.list(recentSession.profile.id, {
          includeRevoked: true,
          limit: 100,
        });
        return { credentials: fallback, cursor: undefined, invalidCursor: true };
      }
      throw error;
    }
  };
  const [{ credentials, cursor, invalidCursor }, feed, metaEventsPage] = await Promise.all([
    loadCredentials(),
    getMetaCatalogFeed(),
    metaCapiService().listEventsPage(recentSession.profile.id, {
      ...(capiEstado !== "ALL" ? { status: capiEstado } : {}),
      page: requestedCapiPage,
      pageSize: 20,
    }),
  ]);
  const canWrite = hasAdminPermission(recentSession.profile.role, "integrations:write");
  const items: IntegrationCredentialView[] = credentials.items.map((credential) => ({
    id: credential.id,
    provider: credential.provider,
    environment: credential.environment,
    keyVersion: credential.keyVersion,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
    revokedAt: credential.revokedAt?.toISOString() ?? null,
  }));
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Integraciones y bóveda</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Credenciales aisladas por ambiente con cifrado autenticado, rotación optimista y
          auditoría. Los descriptores nunca contienen nonce, texto cifrado, etiquetas de
          autenticación ni secretos.
        </p>
        {hasAdminPermission(recentSession.profile.role, "integrations:read") ? (
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <Link className="text-primary underline" href="/admin/canales">
              Administrar canales de venta
            </Link>
          </div>
        ) : null}
      </div>
      <section
        aria-labelledby="vault-environment"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="vault-environment" className="text-xl font-semibold">
          Ambiente activo: {environment}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          El llavero se carga exclusivamente de las variables de este ambiente. Toda mutación exige
          MFA reciente.
        </p>
      </section>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <>
          <section
            aria-labelledby="wompi-setup"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h2 id="wompi-setup" className="text-xl font-semibold">
              Conectar una cuenta Wompi
            </h2>
            <p className="mt-2 mb-5 text-sm text-muted-foreground">
              Usa Web Checkout firmado en servidor; los datos de tarjeta se ingresan únicamente en
              la página segura de Wompi.
            </p>
            <WompiCredentialWizard environment={environment} />
          </section>
          <section
            aria-labelledby="operational-setup"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h2 id="operational-setup" className="text-xl font-semibold">
              Conectar logística, correo, facturación, Gemini o Meta
            </h2>
            <p className="mt-2 mb-5 text-sm text-muted-foreground">
              Cada contrato se valida antes de cifrar. El proveedor DIAN debe firmar y transmitir el
              XML; las credenciales nunca se muestran en descriptores ni registros.
            </p>
            <OperationalCredentialForm environment={environment} />
          </section>
        </>
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol puede consultar descriptores, pero no modificar
          credenciales.
        </p>
      )}
      <section
        aria-labelledby="meta-feed"
        className="space-y-4 rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="meta-feed" className="text-xl font-semibold">
              Catálogo de Meta
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              CSV por variante con precio COP, inventario, enlaces e identificadores reales. Las
              variantes sin imagen pública no se anuncian; nunca se fabrican datos para
              completarlas.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/feeds/meta-catalog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary underline"
            >
              Abrir feed CSV
              <span className="sr-only"> (se abre en una nueva pestaña)</span>
            </a>
            {canWrite ? <MetaCatalogRefreshButton /> : null}
          </div>
        </div>
        <p role="status" className="text-sm">
          {feed.accepted} variantes elegibles · {feed.issues.length} observaciones de validación
        </p>
        {feed.issues.length > 0 ? (
          <details className="rounded-lg bg-secondary/40 p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Revisar observaciones del catálogo
            </summary>
            <ul className="mt-3 space-y-2">
              {feed.issues.map((issue, index) => (
                <li key={`${issue.id}-${issue.code}-${index}`} className="break-all">
                  <span className="font-mono text-xs">{issue.id}</span> ·{" "}
                  {feedIssueLabels[issue.code] ?? issue.code}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">
            Todas las variantes activas superan la validación.
          </p>
        )}
      </section>
      <section id="meta-capi" aria-labelledby="meta-capi-title" className="space-y-4">
        <div>
          <h2 id="meta-capi-title" className="text-xl font-semibold">
            Eventos Meta Conversions API ({numberFormatter.format(metaEventsPage.total)})
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            El evento de compra se deriva del pago real y usa un identificador único por orden. La
            revocación cancela envíos pendientes; los resultados inciertos solo continúan tras
            conciliación con MFA.
          </p>
        </div>
        <form
          key={`${capiEstado}|${cursor ?? ""}`}
          action="/admin/integraciones"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          {cursor ? <input type="hidden" name="cursor" value={cursor} /> : null}
          <Select
            name="capiEstado"
            defaultValue={capiEstado}
            aria-label="Filtrar eventos Meta CAPI por estado"
            fullWidth={false}
          >
            <option value="ALL">Todos los estados</option>
            {capiStatusOptions.map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {capiEstado !== "ALL" ? (
            <Link
              href={integrationsHref({
                ...(cursor ? { cursor } : {}),
                capiEstado: "ALL",
                capiPagina: 1,
              })}
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </form>
        <MetaCapiDashboard events={metaEventsPage.items} canWrite={canWrite} />
        {metaEventsPage.total > 0 ? (
          <nav
            aria-label="Paginación de eventos Meta CAPI"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-sm text-muted-foreground">
              Página {metaEventsPage.page} de {metaEventsPage.totalPages} ·{" "}
              {numberFormatter.format(metaEventsPage.total)}{" "}
              {metaEventsPage.total === 1 ? "evento" : "eventos"}
            </span>
            <div className="flex gap-2">
              {metaEventsPage.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={integrationsHref({
                      ...(cursor ? { cursor } : {}),
                      capiEstado,
                      capiPagina: metaEventsPage.page - 1,
                    })}
                  >
                    Anterior
                  </Link>
                </Button>
              ) : null}
              {metaEventsPage.page < metaEventsPage.totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={integrationsHref({
                      ...(cursor ? { cursor } : {}),
                      capiEstado,
                      capiPagina: metaEventsPage.page + 1,
                    })}
                  >
                    Siguiente
                  </Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
      <section aria-labelledby="credential-list" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="credential-list" className="text-xl font-semibold">
              Credenciales registradas
            </h2>
            <p role="status" className="mt-1 text-sm text-muted-foreground">
              Mostrando {numberFormatter.format(items.length)}{" "}
              {items.length === 1 ? "registro" : "registros"} en esta página
            </p>
          </div>
        </div>
        {invalidCursor ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive bg-card p-3 text-sm text-destructive"
          >
            El cursor de paginación ya no es válido; mostramos la primera página.
          </p>
        ) : null}
        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h3 className="text-lg font-semibold">No hay credenciales en {environment}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Wompi no estará disponible en checkout hasta que un administrador autorizado complete
              el asistente de configuración.
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {items.map((credential) => {
              const providerLabel =
                integrationProviderLabels[credential.provider] ?? credential.provider;
              return (
                <li key={credential.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold break-all">
                        Credencial {credential.id}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {providerLabel} · {credential.provider} · {credential.environment} · versión
                        de clave {credential.keyVersion}
                      </p>
                    </div>
                    <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
                      {credential.revokedAt ? "Revocada" : "Activa"}
                    </span>
                  </div>
                  <dl className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt>Creada</dt>
                      <dd className="mt-1">
                        {dateFormatter.format(new Date(credential.createdAt))}
                      </dd>
                    </div>
                    <div>
                      <dt>{credential.revokedAt ? "Revocada" : "Actualizada"}</dt>
                      <dd className="mt-1">
                        {dateFormatter.format(
                          new Date(credential.revokedAt ?? credential.updatedAt),
                        )}
                      </dd>
                    </div>
                  </dl>
                  {canWrite && !credential.revokedAt ? (
                    <div className="mt-5 space-y-4 border-t border-border pt-4">
                      <div className="flex flex-wrap gap-3">
                        <ReencryptCredentialForm credentialId={credential.id} />
                      </div>
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Rotar secretos de {providerLabel}
                        </summary>
                        <div className="mt-4">
                          {credential.provider === "wompi" ? (
                            <CredentialRotationForm credential={credential} />
                          ) : credential.provider === "aveonline" ||
                            credential.provider === "resend" ||
                            credential.provider === "dian" ||
                            credential.provider === "gemini" ||
                            credential.provider === "meta" ? (
                            <OperationalCredentialForm
                              environment={environment}
                              credential={{ id: credential.id, provider: credential.provider }}
                            />
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              Este proveedor usa un contrato de rotación administrado por su
                              integración.
                            </p>
                          )}
                        </div>
                      </details>
                      {credential.provider === "mercado-libre" ? (
                        <p className="text-sm text-muted-foreground">
                          Para desvincular o reconectar Mercado Libre de forma segura, administra la
                          cuenta en{" "}
                          <Link className="underline" href="/admin/canales">
                            Canales de venta
                          </Link>
                          .
                        </p>
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium text-destructive">
                            Revocar acceso
                          </summary>
                          <div className="mt-4 max-w-sm">
                            <RevokeCredentialForm credentialId={credential.id} />
                          </div>
                        </details>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {cursor || credentials.nextCursor ? (
          <nav aria-label="Paginación de credenciales" className="flex flex-wrap gap-3">
            {cursor ? (
              <Link
                className="text-sm text-primary underline"
                href={integrationsHref({
                  capiEstado,
                  capiPagina: metaEventsPage.page,
                })}
              >
                Primera página
              </Link>
            ) : null}
            {credentials.nextCursor ? (
              <Link
                className="text-sm text-primary underline"
                href={integrationsHref({
                  cursor: credentials.nextCursor,
                  capiEstado,
                  capiPagina: metaEventsPage.page,
                })}
              >
                Siguiente página
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
