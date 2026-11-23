import { hasAdminPermission } from "@mundonettech/core";

import { ChannelAccountActions } from "@/components/admin/channel-account-actions";
import { ChannelConnectionForm } from "@/components/admin/channel-connection-form";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  channelAccountService,
  getIntegrationEnvironment,
  mercadoLibreOAuthRedirectUri,
} from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Cuentas de canales" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const statusLabels: Record<string, string> = {
  ACTIVE: "Activa",
  REAUTH_REQUIRED: "Requiere autorización",
  DISCONNECTED: "Desvinculada",
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

export default async function ChannelsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly oauth?: string }>;
}) {
  const session = await requireAdminPage("integrations:read");
  const [accounts, environment, params] = await Promise.all([
    channelAccountService().listAccounts(session.profile.id),
    Promise.resolve(getIntegrationEnvironment()),
    searchParams,
  ]);
  const canWrite = hasAdminPermission(session.profile.role, "integrations:write");
  const redirectUri = mercadoLibreOAuthRedirectUri();
  const outcome = params.oauth ? oauthMessages[params.oauth] : undefined;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Canales de venta</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Conecta vendedores de Mercado Libre Colombia con OAuth PKCE, tokens cifrados por ambiente
          y renovación serializada. Ningún secreto aparece en los descriptores ni en la auditoría.
        </p>
      </div>
      {outcome ? (
        <p
          role={outcome.error ? "alert" : "status"}
          className={`rounded-xl border p-4 text-sm ${outcome.error ? "border-destructive text-destructive" : "border-success"}`}
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
          Cada conexión queda ligada a MCO, este ambiente y su llavero. Iniciar, reconectar, renovar
          o desvincular exige MFA reciente.
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
            Registra una aplicación para MCO con el redirect URI fijo y habilita PKCE. El
            intercambio ocurre exclusivamente entre servidores.
          </p>
          <ChannelConnectionForm environment={environment} redirectUri={redirectUri} />
        </section>
      ) : (
        <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
          Vista de solo lectura: tu rol puede consultar cuentas, pero no iniciar OAuth, renovar
          tokens ni desvincularlas.
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
                    {account.lastRefreshError === "REMOTE_REVOCATION_UNCERTAIN"
                      ? "Acceso local revocado; Mercado Libre no confirmó la revocación remota. Revisa los permisos en la cuenta de vendedor."
                      : account.lastRefreshError === "REFRESH_GRANT_INVALID"
                        ? "Mercado Libre invalidó la autorización. Reconecta la cuenta con el vendedor correcto."
                        : "La última renovación no tuvo un resultado duradero seguro. Reconecta la cuenta antes de usar el canal."}
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
    </div>
  );
}
