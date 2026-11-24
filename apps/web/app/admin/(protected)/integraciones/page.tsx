import { hasAdminPermission, type MetaCatalogIssueCode } from "@mundonettech/core";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { MetaCapiDashboard } from "@/components/admin/meta-capi-dashboard";
import { MetaCatalogRefreshButton } from "@/components/admin/meta-catalog-refresh-button";
import { OperationalCredentialForm } from "@/components/admin/operational-credential-form";
import {
  CredentialRotationForm,
  ReencryptCredentialForm,
  RevokeCredentialForm,
  WompiCredentialWizard,
  type IntegrationCredentialView,
} from "@/components/admin/integration-credential-forms";
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

export default async function IntegrationsPage() {
  const session = await requireAdminPage("integrations:read");
  let recentSession;
  try {
    recentSession = await getAdminSession({
      permission: "integrations:read",
      requireRecentMfa: true,
    });
  } catch (error) {
    if (error instanceof AdminAuthorizationError && error.code === "MFA_STALE") {
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
    throw error;
  }
  const environment = getIntegrationEnvironment();
  const [credentials, feed, metaEvents] = await Promise.all([
    getIntegrationCredentialVault().list(recentSession.profile.id, {
      includeRevoked: true,
      limit: 100,
    }),
    getMetaCatalogFeed(),
    metaCapiService().listEvents(recentSession.profile.id, 50),
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
            aria-labelledby="wompi-wizard"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h2 id="wompi-wizard" className="text-xl font-semibold">
              Conectar una cuenta Wompi
            </h2>
            <p className="mt-2 mb-5 text-sm text-muted-foreground">
              Usa Web Checkout firmado en servidor; los datos de tarjeta se ingresan únicamente en
              la página segura de Wompi.
            </p>
            <WompiCredentialWizard environment={environment} />
          </section>
          <section
            aria-labelledby="operational-wizard"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h2 id="operational-wizard" className="text-xl font-semibold">
              Conectar logística, correo, facturación, Gemini o Meta
            </h2>
            <p className="mt-2 mb-5 text-sm text-muted-foreground">
              Cada contrato se valida antes de cifrar. El proveedor DIAN debe firmar y transmitir el
              XML; las credenciales nunca se muestran en descriptores o logs.
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
              Meta Catalog Feed
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              CSV por variante con precio COP, inventario, enlaces e identificadores reales. Las
              variantes sin imagen pública no se anuncian; nunca se fabrican datos para
              completarlas.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/api/feeds/meta-catalog"
              target="_blank"
              className="text-sm text-primary underline"
            >
              Abrir feed CSV
            </Link>
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
            Eventos Meta Conversions API
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Purchase se deriva del pago real y usa un event_id único por orden. La revocación
            cancela pendientes; los resultados inciertos solo continúan tras conciliación con MFA.
          </p>
        </div>
        <MetaCapiDashboard events={metaEvents} canWrite={canWrite} />
      </section>
      <section aria-labelledby="credential-list" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="credential-list" className="text-xl font-semibold">
              Credenciales registradas
            </h2>
            <p role="status" className="mt-1 text-sm text-muted-foreground">
              {items.length} registros en este ambiente
            </p>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h3 className="text-lg font-semibold">No hay credenciales en {environment}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Wompi no estará disponible en checkout hasta que un administrador autorizado complete
              el wizard.
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {items.map((credential) => (
              <li key={credential.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold">Credencial {credential.id}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {credential.provider} · {credential.environment} · versión de clave{" "}
                      {credential.keyVersion}
                    </p>
                  </div>
                  <span className="rounded-md border border-border px-2 py-1 text-xs font-medium">
                    {credential.revokedAt ? "Revocada" : "Activa"}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>
                    <dt>Creada</dt>
                    <dd className="mt-1">{dateFormatter.format(new Date(credential.createdAt))}</dd>
                  </div>
                  <div>
                    <dt>{credential.revokedAt ? "Revocada" : "Actualizada"}</dt>
                    <dd className="mt-1">
                      {dateFormatter.format(new Date(credential.revokedAt ?? credential.updatedAt))}
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
                        Rotar secretos de {credential.provider}
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
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
