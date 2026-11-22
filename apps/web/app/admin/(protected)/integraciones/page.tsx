import { hasAdminPermission } from "@mundonettech/core";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { OperationalCredentialForm } from "@/components/admin/operational-credential-form";
import {
  CredentialRotationForm,
  ReencryptCredentialForm,
  RevokeCredentialForm,
  WompiCredentialWizard,
  type IntegrationCredentialView,
} from "@/components/admin/integration-credential-forms";
import { getIntegrationCredentialVault, getIntegrationEnvironment } from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Integraciones y bóveda" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

export default async function IntegrationsPage() {
  const session = await requireAdminPage("integrations:read");
  const environment = getIntegrationEnvironment();
  const credentials = await getIntegrationCredentialVault().list({
    includeRevoked: true,
    limit: 100,
  });
  const canWrite = hasAdminPermission(session.profile.role, "integrations:write");
  const items: IntegrationCredentialView[] = credentials.items.map((credential) => ({
    id: credential.id,
    provider: credential.provider,
    accountName: credential.accountName,
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
              Conectar logística, correo o facturación
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
                    <h3 className="text-lg font-semibold">{credential.accountName}</h3>
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
                          credential.provider === "dian" ? (
                          <OperationalCredentialForm
                            environment={environment}
                            credential={{
                              id: credential.id,
                              provider: credential.provider,
                              accountName: credential.accountName,
                            }}
                          />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Este proveedor usa un contrato de rotación administrado por su
                            integración.
                          </p>
                        )}
                      </div>
                    </details>
                    <details>
                      <summary className="cursor-pointer text-sm font-medium text-destructive">
                        Revocar acceso
                      </summary>
                      <div className="mt-4 max-w-sm">
                        <RevokeCredentialForm credentialId={credential.id} />
                      </div>
                    </details>
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
