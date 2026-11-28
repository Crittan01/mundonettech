import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import { CredentialKeyRingError } from "@mundonettech/integrations";
import Link from "next/link";
import { z } from "zod";

import { ChannelAccountActions } from "@/components/admin/channel-account-actions";
import {
  ChannelListingCreateForm,
  ChannelListingSyncActions,
  ChannelOfferAddForm,
  ChannelOfferEditForm,
  ProcessChannelJobsButton,
} from "@/components/admin/channel-catalog-forms";
import { ChannelConnectionForm } from "@/components/admin/channel-connection-form";
import { ChannelOrderDashboardView } from "@/components/admin/channel-order-dashboard";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { single } from "@/lib/admin-search-params";
import {
  channelAccountService,
  channelCatalogService,
  channelOrderService,
  getIntegrationEnvironment,
  mercadoLibreOAuthRedirectUri,
} from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Canales y publicaciones" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const statusLabels: Record<string, string> = {
  ACTIVE: "Activa",
  REAUTH_REQUIRED: "Requiere autorización",
  DISCONNECTED: "Desvinculada",
  DRAFT: "Borrador",
  PAUSED: "Pausada",
  RECONCILE_REQUIRED: "Requiere conciliación",
  CLOSED: "Cerrada",
};
const jobStatusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  PROCESSING: "En proceso",
  RETRY_SCHEDULED: "Reintento programado",
  SUCCEEDED: "Completado",
  FAILED: "Fallido",
  UNCERTAIN: "Incierto",
  SUPERSEDED: "Reemplazado",
};
const jobKindLabels: Record<string, string> = {
  PUBLISH: "Publicación",
  SYNC_CONTENT: "Contenido/estado",
  SYNC_PRICE: "Precio",
  SYNC_LOCAL_STOCK: "Inventario",
  RECONCILE_REMOTE: "Conciliación",
};
const providerErrorLabels: Record<string, string> = {
  FULL_STOCK_DIVERGENCE:
    "Mercado Libre Full reporta una cantidad distinta a la instantánea local. Full solo se concilia por lectura; no se escribe desde la tienda.",
  REMOTE_DIVERGENCE:
    "El precio, inventario o identidad remota difiere de la instantánea esperada. Revisa el vendedor antes de reintentar.",
  REMOTE_STATUS_DIVERGENCE:
    "El estado remoto en Mercado Libre difiere del esperado o está en revisión del proveedor. Revisa tu cuenta de vendedor antes de reintentar.",
  VERSION_DIVERGENCE:
    "El precio o las condiciones locales cambiaron y requieren sincronización o conciliación con Mercado Libre.",
  PROVIDER_UNCERTAIN:
    "Mercado Libre no confirmó un resultado duradero. Concilia por SKU antes de cualquier reintento.",
  VERSION_CONFLICT:
    "El inventario cambió durante la escritura. El proceso en segundo plano releerá x-version antes de reintentar.",
  ACCOUNT_DISCONNECTED:
    "La cuenta fue desvinculada; reconectarla no reactiva publicaciones automáticamente.",
  UNAUTHORIZED: "Mercado Libre rechazó el token. Reconecta la cuenta antes de continuar.",
  REMOTE_REVOCATION_UNCERTAIN:
    "Acceso local revocado; Mercado Libre no confirmó la revocación remota. Revisa los permisos en la cuenta de vendedor.",
  REFRESH_GRANT_INVALID:
    "Mercado Libre invalidó la autorización. Reconecta la cuenta con el vendedor correcto.",
};
const oauthMessages: Record<string, { message: string; error: boolean }> = {
  connected: {
    message: "Cuenta de Mercado Libre conectada y tokens cifrados correctamente.",
    error: false,
  },
  denied: {
    message: "Mercado Libre no autorizó la conexión. Puedes iniciar una nueva autorización.",
    error: true,
  },
  forbidden: {
    message:
      "La cuenta administradora que inició la autorización ya no tiene permisos activos en este ambiente.",
    error: true,
  },
  expired: {
    message: "La autorización expiró. Inicia una nueva conexión con MFA reciente.",
    error: true,
  },
  replay: {
    message: "El estado OAuth es inválido o ya fue utilizado. Inicia una nueva conexión.",
    error: true,
  },
  conflict: {
    message:
      "La cuenta cambió durante la conexión. Revisa la cuenta existente antes de reintentar.",
    error: true,
  },
  uncertain: {
    message:
      "No pudimos confirmar el resultado. No se reutilizó el código; inicia una nueva autorización.",
    error: true,
  },
};

function maskedSeller(value: string): string {
  if (value.length < 5) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

const jobFailureShortLabels: Record<string, string> = {
  FULL_STOCK_DIVERGENCE: "Divergencia de inventario en Mercado Libre Full",
  REMOTE_DIVERGENCE: "Divergencia frente al estado remoto",
  REMOTE_STATUS_DIVERGENCE: "Divergencia de estado remoto",
  VERSION_DIVERGENCE: "Cambios locales pendientes de sincronización",
  PROVIDER_UNCERTAIN: "Resultado incierto del proveedor",
  VERSION_CONFLICT: "Conflicto de versión de inventario remoto",
  ACCOUNT_DISCONNECTED: "Cuenta desvinculada",
  UNAUTHORIZED: "Token rechazado por Mercado Libre",
  REMOTE_REVOCATION_UNCERTAIN: "Revocación remota sin confirmar",
  REFRESH_GRANT_INVALID: "Autorización invalidada",
  PROVIDER_REJECTED: "Datos rechazados por Mercado Libre",
  RATE_LIMITED: "Límite de solicitudes del proveedor",
  CLAIM_EXPIRED: "Reclamo de trabajo expirado",
};

const allowedListingStatuses = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "RECONCILE_REQUIRED",
  "CLOSED",
] as const;

function providerErrorMessage(code: string): string {
  return (
    providerErrorLabels[code] ??
    "La última operación no terminó correctamente. Revisa el trabajo y concilia antes de reintentar."
  );
}

function formatJobFailureCode(code: string): string {
  const label = jobFailureShortLabels[code];
  return label ? `${label} (${code})` : `Fallo registrado (${code})`;
}

export default async function ChannelsPage({ searchParams }: PageProps<"/admin/canales">) {
  const session = await requireAdminPage("integrations:read");
  const canWrite = hasAdminPermission(session.profile.role, "integrations:write");
  const canReadFinance = hasAdminPermission(session.profile.role, "finance:read");
  const canReconcile = canWrite && canReadFinance;
  const params = await searchParams;
  const q = (single(params.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  const rawEstado = single(params.estado) ?? "";
  const estado = (allowedListingStatuses as readonly string[]).includes(rawEstado) ? rawEstado : "";
  const rawCuenta = single(params.cuenta)?.trim() ?? "";
  const cuenta = z.string().uuid().safeParse(rawCuenta).success ? rawCuenta : "";
  const environment = getIntegrationEnvironment();
  let catalog: ReturnType<typeof channelCatalogService>;
  let channelOrders: ReturnType<typeof channelOrderService>;
  let accountService: ReturnType<typeof channelAccountService>;
  try {
    accountService = channelAccountService();
    catalog = channelCatalogService();
    channelOrders = channelOrderService();
  } catch (error) {
    const isMissingMedia =
      error instanceof Error && error.message.includes("MEDIA_BASE_URL is required");
    if (isMissingMedia || error instanceof CredentialKeyRingError) {
      return (
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold">Canales de venta</h1>
            <p className="mt-2 max-w-3xl text-muted-foreground">
              Ambiente activo: <span className="font-mono">{environment}</span>.
            </p>
          </div>
          <section
            role="alert"
            className="rounded-xl border border-warning bg-card p-6 text-card-foreground"
          >
            <h2 className="text-lg font-semibold">
              Configuración previa requerida para canales externos
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {isMissingMedia
                ? "Define NEXT_PUBLIC_MEDIA_BASE_URL (origen público de medios) para habilitar la gestión de publicaciones e imágenes de Mercado Libre."
                : `Configura INTEGRATION_CREDENTIAL_KEYS_${environment} e INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_${environment} para habilitar la bóveda de canales.`}
            </p>
          </section>
        </div>
      );
    }
    throw error;
  }
  const [accounts, listings, variants, jobs, orderDashboard] = await Promise.all([
    accountService.listAccounts(session.profile.id),
    catalog.listListings(session.profile.id, cuenta || undefined),
    canWrite ? catalog.listPublishableVariants(session.profile.id) : Promise.resolve([]),
    catalog.listSyncJobs(session.profile.id),
    channelOrders.dashboard(session.profile.id),
  ]);
  const normalizedQ = q.toLowerCase();
  const filteredListings = listings.filter((listing) => {
    if (estado && listing.status !== estado) return false;
    if (!normalizedQ) return true;
    return (
      listing.familyName.toLowerCase().includes(normalizedQ) ||
      listing.productName.toLowerCase().includes(normalizedQ) ||
      listing.sku.toLowerCase().includes(normalizedQ) ||
      (listing.externalUserProductId?.toLowerCase().includes(normalizedQ) ?? false) ||
      listing.offers.some(
        (offer) => offer.externalItemId?.toLowerCase().includes(normalizedQ) ?? false,
      )
    );
  });
  const hasListingFilters = Boolean(q || estado || cuenta);
  const locationEntries = canWrite
    ? await Promise.all(
        orderDashboard.orders
          .filter((order) => order.stockStatus === "REVIEW_REQUIRED")
          .map(
            async (order) =>
              [
                order.id,
                await channelOrders.listStockLocationChoices(session.profile.id, order.id),
              ] as const,
          ),
      )
    : [];
  const locations = Object.fromEntries(locationEntries);
  const activeAccounts = accounts.filter((account) => account.status === "ACTIVE");
  const redirectUri = mercadoLibreOAuthRedirectUri();
  const oauthKey = single(params.oauth);
  const outcome =
    oauthKey && Object.hasOwn(oauthMessages, oauthKey) ? oauthMessages[oauthKey] : undefined;
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Canales de venta</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Conecta vendedores de Mercado Libre Colombia y administra User Products, ofertas,
          inventario y precios con trabajos persistentes. Ningún secreto aparece en descriptores,
          trabajos ni auditoría.
        </p>
        {hasAdminPermission(session.profile.role, "integrations:read") ? (
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <Link className="text-primary underline" href="/admin/integraciones">
              Ir a integraciones y bóveda
            </Link>
          </div>
        ) : null}
      </div>
      {outcome ? (
        <p
          role={outcome.error ? "alert" : "status"}
          className={`rounded-xl border bg-card p-4 text-sm ${outcome.error ? "border-destructive text-destructive" : "border-success"}`}
        >
          {outcome.message}
        </p>
      ) : null}
      <section
        aria-labelledby="channel-environment"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="channel-environment" className="text-xl font-semibold">
          Ambiente activo: {environment}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Cada conexión queda ligada a MCO, este ambiente y su llavero. OAuth, publicaciones,
          precios y cambios de estado exigen MFA reciente.
        </p>
      </section>
      {canWrite ? <CmsStepUp session={session} /> : null}
      {canWrite ? (
        <section
          aria-labelledby="connect-channel"
          className="rounded-xl border border-border bg-card p-5"
        >
          <h2 id="connect-channel" className="text-xl font-semibold">
            Conectar una cuenta de Mercado Libre
          </h2>
          <p className="mt-2 mb-5 text-sm text-muted-foreground">
            Registra una aplicación para MCO con la URI de retorno fija y habilita PKCE. El
            intercambio ocurre exclusivamente entre servidores.
          </p>
          <ChannelConnectionForm environment={environment} redirectUri={redirectUri} />
        </section>
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol puede consultar cuentas, publicaciones, tarifas y trabajos,
          pero no modificarlos.
        </p>
      )}
      <section aria-labelledby="channel-list" className="space-y-4">
        <div>
          <h2 id="channel-list" className="text-xl font-semibold">
            Cuentas conectadas
          </h2>
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {accounts.length} {accounts.length === 1 ? "cuenta registrada" : "cuentas registradas"}{" "}
            en {environment}
          </p>
        </div>
        {accounts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h3 className="text-lg font-semibold">No hay cuentas de canales en {environment}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Una cuenta aparecerá aquí únicamente después de un intercambio OAuth válido y de la
              persistencia cifrada de sus tokens.
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {accounts.map((account) => (
              <li key={account.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold">{account.label}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Mercado Libre MCO · Vendedor {maskedSeller(account.externalAccountId)}
                    </p>
                  </div>
                  <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
                    {statusLabels[account.status] ?? account.status}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt>Ambiente</dt>
                    <dd className="mt-1">{account.environment}</dd>
                  </div>
                  <div>
                    <dt>Permisos</dt>
                    <dd className="mt-1">{account.scopes.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Token vigente hasta</dt>
                    <dd className="mt-1">
                      {account.tokenExpiresAt
                        ? dateFormatter.format(account.tokenExpiresAt)
                        : "No disponible"}
                    </dd>
                  </div>
                  <div>
                    <dt>Última renovación</dt>
                    <dd className="mt-1">
                      {account.lastRefreshedAt
                        ? dateFormatter.format(account.lastRefreshedAt)
                        : "Sin renovaciones"}
                    </dd>
                  </div>
                </dl>
                {account.lastRefreshError ? (
                  <p className="mt-4 rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
                    {providerErrorMessage(account.lastRefreshError)}
                  </p>
                ) : null}
                {canWrite ? (
                  <>
                    <ChannelAccountActions
                      account={{ id: account.id, label: account.label }}
                      canRefresh={account.status === "ACTIVE"}
                      canDisconnect={account.status !== "DISCONNECTED"}
                    />
                    <details className="mt-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        {account.status === "ACTIVE" ? "Reautorizar cuenta" : "Reconectar cuenta"}
                      </summary>
                      <div className="mt-4">
                        <ChannelConnectionForm
                          environment={environment}
                          redirectUri={redirectUri}
                          account={{ id: account.id, label: account.label }}
                        />
                      </div>
                    </details>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="catalog-listings" className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="catalog-listings" className="text-xl font-semibold">
              User Products y ofertas
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              El inventario local y el de Full son independientes. Los trabajos usan huella de
              solicitud, reclamos, x-version y conciliación; un tiempo agotado nunca autoriza una
              creación ciega.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Mostrando {filteredListings.length} de las últimas {listings.length} publicaciones
              (ventana de hasta 100 más recientes · últimos {jobs.length} trabajos evaluados, hasta
              100).
            </p>
          </div>
          {canWrite ? <ProcessChannelJobsButton /> : null}
        </div>
        <form
          key={`${q}|${estado}|${cuenta}`}
          action="/admin/canales"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          <label htmlFor="channel-listings-q" className="sr-only">
            Buscar publicaciones por SKU, producto o identificador
          </label>
          <Input
            id="channel-listings-q"
            name="q"
            defaultValue={q}
            maxLength={100}
            placeholder="SKU, producto, User Product o ítem remoto"
            className="min-w-56 flex-1"
          />
          <Select
            name="estado"
            defaultValue={estado}
            aria-label="Filtrar publicaciones por estado"
            fullWidth={false}
          >
            <option value="">Todos los estados</option>
            {allowedListingStatuses.map((item) => (
              <option key={item} value={item}>
                {item === "ACTIVE"
                  ? "Publicación activa"
                  : item === "PAUSED"
                    ? "Publicación pausada"
                    : item === "DRAFT"
                      ? "En borrador"
                      : (statusLabels[item] ?? item)}
              </option>
            ))}
          </Select>
          {accounts.length > 0 ? (
            <Select
              name="cuenta"
              defaultValue={cuenta}
              aria-label="Filtrar publicaciones por cuenta"
              fullWidth={false}
            >
              <option value="">Todas las cuentas</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </Select>
          ) : null}
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasListingFilters ? (
            <Link
              href="/admin/canales"
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </form>
        {canWrite && activeAccounts.length > 0 ? (
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer text-lg font-semibold">
              Preparar una publicación
            </summary>
            <div className="mt-5">
              <ChannelListingCreateForm
                accounts={activeAccounts.map(({ id, label }) => ({ id, label }))}
                variants={variants}
              />
            </div>
          </details>
        ) : null}
        {canWrite && activeAccounts.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Conecta una cuenta activa antes de preparar publicaciones.
          </p>
        ) : null}
        {filteredListings.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h3 className="text-lg font-semibold">
              {hasListingFilters
                ? "No hay publicaciones que coincidan con estos filtros"
                : "No hay publicaciones administradas"}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {hasListingFilters
                ? "Ajusta la búsqueda o limpia los filtros para consultar las últimas publicaciones."
                : "Selecciona una variante real del catálogo para persistir su primer trabajo de publicación."}
            </p>
          </div>
        ) : (
          <ul className="space-y-6">
            {filteredListings.map((listing) => {
              const listingJobs = jobs.filter((job) => job.listingId === listing.id).slice(0, 6);
              return (
                <li
                  key={listing.id}
                  className="space-y-5 rounded-xl border border-border bg-card p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold">{listing.familyName}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {listing.productName} · <span className="font-mono">{listing.sku}</span>
                      </p>
                    </div>
                    <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
                      {statusLabels[listing.status] ?? listing.status}
                    </span>
                  </div>
                  <dl className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt>User Product</dt>
                      <dd className="mt-1 font-mono">
                        {listing.externalUserProductId ?? "Aún no creado"}
                      </dd>
                    </div>
                    <div>
                      <dt>Categoría MCO</dt>
                      <dd className="mt-1 font-mono">{listing.externalCategoryId}</dd>
                    </div>
                    <div>
                      <dt>Inventario local / remoto</dt>
                      <dd className="mt-1">
                        {listing.localQuantity} / {listing.remoteLocalQuantity ?? "Sin lectura"}
                      </dd>
                    </div>
                    <div>
                      <dt>Inventario Full / x-version</dt>
                      <dd className="mt-1">
                        {listing.remoteFullQuantity ?? "Sin ubicación"} /{" "}
                        {listing.remoteStockVersion ?? "Sin lectura"}
                      </dd>
                    </div>
                  </dl>
                  {listing.lastProviderError ? (
                    <p
                      role="alert"
                      className="rounded-lg border border-destructive p-3 text-sm text-destructive"
                    >
                      {providerErrorMessage(listing.lastProviderError)}
                    </p>
                  ) : null}
                  <div className="space-y-4">
                    <h4 className="font-semibold">Condiciones de venta</h4>
                    {listing.offers.map((offer) => (
                      <article
                        key={offer.id}
                        className="space-y-4 rounded-lg border border-border p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h5 className="font-medium">
                              {offer.listingTypeId === "gold_pro" ? "Premium" : "Clásica"} ·{" "}
                              {offer.logisticType === "FULFILLMENT" ? "Full" : "Local / Flex"}
                            </h5>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {offer.externalItemId ?? "Sin item remoto"} ·{" "}
                              {statusLabels[offer.status] ?? offer.status}
                            </p>
                          </div>
                          <p className="text-xl font-semibold">
                            {formatCopCents(offer.priceCents)}
                          </p>
                        </div>
                        <dl className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                          <div>
                            <dt>Comisión</dt>
                            <dd className="mt-1">
                              {offer.commissionBps / 100} % ·{" "}
                              {formatCopCents(offer.commissionAmountCents)}
                            </dd>
                          </div>
                          <div>
                            <dt>Cargo fijo / flete</dt>
                            <dd className="mt-1">
                              {formatCopCents(offer.fixedFeeAppliedCents)} /{" "}
                              {formatCopCents(offer.shippingAppliedCents)}
                            </dd>
                          </div>
                          <div>
                            <dt>Neto estimado</dt>
                            <dd className="mt-1">{formatCopCents(offer.netProceedsCents)}</dd>
                          </div>
                          <div>
                            <dt>Ajuste de zona muerta</dt>
                            <dd className="mt-1">
                              {formatCopCents(offer.deadZoneAdjustmentCents)}
                            </dd>
                          </div>
                        </dl>
                        {canWrite && listing.status !== "CLOSED" ? (
                          <ChannelOfferEditForm offer={offer} />
                        ) : null}
                      </article>
                    ))}
                  </div>
                  {canWrite && listing.externalUserProductId && listing.status !== "CLOSED" ? (
                    <ChannelOfferAddForm listing={listing} />
                  ) : null}
                  {canWrite &&
                  listing.status !== "CLOSED" &&
                  (Boolean(listing.externalUserProductId) ||
                    listing.status === "RECONCILE_REQUIRED" ||
                    listing.lastProviderError !== null) ? (
                    <ChannelListingSyncActions listing={listing} />
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Últimos {listingJobs.length} trabajos recientes (máx. 6)
                    </summary>
                    {listingJobs.length === 0 ? (
                      <p className="mt-3 text-sm text-muted-foreground">
                        No hay trabajos persistidos.
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {listingJobs.map((job) => (
                          <li key={job.id} className="rounded-lg border border-border p-3 text-xs">
                            <span className="font-medium">
                              {jobKindLabels[job.kind] ?? job.kind}
                            </span>{" "}
                            · {jobStatusLabels[job.status] ?? job.status} · intento {job.attempts}
                            {job.failureCode ? (
                              <span className="mt-1 block text-destructive">
                                {formatJobFailureCode(job.failureCode)}
                              </span>
                            ) : null}
                            <span className="mt-1 block text-muted-foreground">
                              {dateFormatter.format(job.createdAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <ChannelOrderDashboardView
        dashboard={orderDashboard}
        canWrite={canWrite}
        canReconcile={canReconcile}
        canReadFinance={canReadFinance}
        locations={locations}
      />
    </div>
  );
}
