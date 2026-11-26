import { randomUUID } from "node:crypto";

import {
  copilotActionLabels,
  copilotPriorityLabels,
  copilotReasonLabels,
  formatCopCents,
  hasAdminPermission,
  opportunityProposalStatusLabels,
  opportunityStatusLabels,
} from "@mundonettech/core";
import { B2bError } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  B2bCloseOpportunityForm,
  B2bCopilotForm,
  B2bProposalBuilder,
  B2bProposalLifecycleForms,
} from "@/components/admin/b2b-proposal-forms";
import { crmSourceLabels } from "@/lib/admin-presenters";
import { bogotaInputValue } from "@/lib/admin-pricing-presenters";
import { b2bService } from "@/lib/b2b";
import { getDatabase } from "@/lib/db";
import { getIntegrationCredentialVault } from "@/lib/integrations";
import {
  AdminAuthorizationError,
  getAdminSession,
  requireAdminPage,
} from "@/lib/security/admin-auth";

export const metadata = {
  title: "Detalle de oportunidad B2B",
  robots: { index: false, follow: false },
};

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const copilotFailureLabels: Record<string, string> = {
  CREDENTIAL_NOT_FOUND: "La credencial seleccionada no existe o no pertenece a este ambiente",
  CREDENTIAL_REVOKED: "La credencial seleccionada fue revocada",
  CREDENTIAL_INVALID: "La credencial de Google Gemini no tiene un formato válido",
  PROVIDER_TIMEOUT: "Google Gemini superó el tiempo máximo de respuesta",
  PROVIDER_RATE_LIMITED: "Límite de solicitudes alcanzado en Google Gemini",
  PROVIDER_REJECTED: "Google Gemini rechazó la solicitud",
  PROVIDER_ERROR: "Error temporal en Google Gemini",
  INVALID_OUTPUT: "La respuesta del modelo no cumplió el contrato estructurado",
  NETWORK_ERROR: "Error de red al consultar Google Gemini",
  UNAUTHORIZED: "Google Gemini rechazó la autenticación de la llave API",
};

function formatCopilotFailure(code: string): string {
  const description = copilotFailureLabels[code];
  return description ? `${description} (${code})` : `Fallo de ejecución (${code})`;
}

function defaultExpiry(): string {
  return bogotaInputValue(new Date(Date.now() + 7 * 86_400_000));
}

function copilotOutput(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const priority =
    typeof root.priority === "string" && root.priority in copilotPriorityLabels
      ? copilotPriorityLabels[root.priority as keyof typeof copilotPriorityLabels]
      : null;
  const action =
    typeof root.nextAction === "string" && root.nextAction in copilotActionLabels
      ? copilotActionLabels[root.nextAction as keyof typeof copilotActionLabels]
      : null;
  const confidence =
    typeof root.confidenceBps === "number" && Number.isSafeInteger(root.confidenceBps)
      ? root.confidenceBps
      : null;
  const reasons = Array.isArray(root.reasonCodes)
    ? root.reasonCodes
        .filter(
          (reason): reason is keyof typeof copilotReasonLabels =>
            typeof reason === "string" && reason in copilotReasonLabels,
        )
        .map((reason) => copilotReasonLabels[reason])
    : [];
  return priority && action && confidence !== null
    ? { priority, action, confidence, reasons }
    : null;
}

export default async function B2bOpportunityPage({ params }: PageProps<"/admin/b2b/[id]">) {
  const session = await requireAdminPage("b2b:read");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  let opportunity;
  try {
    opportunity = await b2bService(getDatabase()).getOpportunity(id);
  } catch (error) {
    if (error instanceof B2bError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const canWrite = hasAdminPermission(session.profile.role, "b2b:write");
  const canReadCrm = hasAdminPermission(session.profile.role, "crm:read");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const canReadIntegrations = hasAdminPermission(session.profile.role, "integrations:read");
  const active = !["WON", "LOST", "CANCELLED"].includes(opportunity.status);
  let copilotAuthorized = false;
  if (canWrite) {
    try {
      await getAdminSession({ permission: "b2b:write", requireRecentMfa: true });
      copilotAuthorized = true;
    } catch (error) {
      if (!(error instanceof AdminAuthorizationError && error.code === "MFA_STALE")) throw error;
    }
  }
  const credentials = copilotAuthorized
    ? (await getIntegrationCredentialVault().forSystemProvider("gemini").list({ limit: 100 })).items
        .filter((credential) => credential.provider === "gemini" && !credential.revokedAt)
        .map((credential, index) => ({
          id: credential.id,
          accountName: `Integración Gemini ${index + 1}`,
        }))
    : [];
  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/b2b" className="text-sm text-primary underline">
          ← Volver al canal B2B
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold">
            {opportunity.organization?.legalName ?? "Organización no disponible"}
          </h1>
          <span className="rounded-md border border-border px-2 py-1 text-xs">
            {opportunityStatusLabels[opportunity.status]}
          </span>
        </div>
        <p className="mt-2 text-sm break-all text-muted-foreground">
          {canReadCrm ? (
            <Link href={`/admin/crm/${opportunity.contact.id}`} className="underline">
              {opportunity.contact.givenName} {opportunity.contact.familyName}
            </Link>
          ) : (
            <>
              {opportunity.contact.givenName} {opportunity.contact.familyName}
            </>
          )}{" "}
          · {opportunity.contact.email} · {opportunity.contact.phoneE164} · NIT{" "}
          {opportunity.organization?.taxId ?? "No informado"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Registrada {dateFormatter.format(opportunity.createdAt)} · control de versión{" "}
          {opportunity.version} · propuesta actual {opportunity.currentVersion}
        </p>
      </div>
      {canWrite ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-xl font-semibold">Necesidad comercial</h2>
        <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
          {opportunity.requirements}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Fuente: {crmSourceLabels[opportunity.source] ?? opportunity.source} · autorización
          registrada {dateFormatter.format(opportunity.acceptedAt)}
        </p>
      </section>
      {canWrite && active ? (
        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div>
            <h2 className="text-xl font-semibold">Nueva versión de propuesta</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              La lista asignada es{" "}
              {opportunity.organization?.priceList?.code ??
                "ninguna; se usará el precio de catálogo por defecto"}
              .
            </p>
          </div>
          <B2bProposalBuilder
            opportunityId={opportunity.id}
            expectedVersion={opportunity.version}
            defaultExpiry={defaultExpiry()}
          />
        </section>
      ) : null}
      <section aria-labelledby="proposal-history" className="space-y-4">
        <h2 id="proposal-history" className="text-2xl font-semibold">
          Versiones ({opportunity.proposals.length})
        </h2>
        {opportunity.proposals.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            Aún no hay propuestas para esta oportunidad.
          </p>
        ) : null}
        {opportunity.proposals.map((proposal) => (
          <article
            key={proposal.id}
            className="space-y-5 rounded-xl border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">
                  Versión {proposal.version} · {opportunityProposalStatusLabels[proposal.status]}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Creada {dateFormatter.format(proposal.createdAt)} · vence{" "}
                  {dateFormatter.format(proposal.expiresAt)}
                </p>
                {proposal.priceListCodeSnapshot ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Lista {proposal.priceListCodeSnapshot} · snapshot v
                    {proposal.priceListVersionSnapshot}
                  </p>
                ) : null}
              </div>
              <p className="text-xl font-bold">{formatCopCents(proposal.totalCents)}</p>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {proposal.items.map((item) => (
                <li key={item.id} className="grid gap-2 p-3 text-sm sm:grid-cols-[1fr_auto]">
                  <div>
                    <p className="font-medium">{item.titleSnapshot}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {item.skuSnapshot} · {item.quantity} unidades
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p>{formatCopCents(item.lineTotalCents)}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCopCents(item.unitPriceCents)} c/u · IVA{" "}
                      {formatCopCents(item.taxCents)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <dl className="grid gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt>Subtotal</dt>
                <dd className="font-medium">{formatCopCents(proposal.subtotalCents)}</dd>
              </div>
              <div>
                <dt>Descuento</dt>
                <dd className="font-medium">−{formatCopCents(proposal.discountCents)}</dd>
              </div>
              <div>
                <dt>Impuestos</dt>
                <dd className="font-medium">{formatCopCents(proposal.taxCents)}</dd>
              </div>
              <div>
                <dt>Envío</dt>
                <dd className="font-medium">{formatCopCents(proposal.shippingCents)}</dd>
              </div>
            </dl>
            {proposal.commercialNotes ? (
              <p className="rounded-lg bg-secondary/30 p-3 text-sm whitespace-pre-wrap text-muted-foreground">
                {proposal.commercialNotes}
              </p>
            ) : null}
            {proposal.status === "CONVERTED" ? (
              <div className="rounded-lg border border-success p-4 text-sm">
                <p>
                  Aceptada {proposal.acceptedAt ? dateFormatter.format(proposal.acceptedAt) : ""}{" "}
                  por {proposal.signerName ?? "identidad anonimizada"}.
                </p>
                {proposal.orderId && canReadOrders ? (
                  <Link
                    href={`/admin/pedidos/${proposal.orderId}`}
                    className="mt-2 inline-flex font-medium text-primary underline"
                  >
                    Abrir pedido convertido
                  </Link>
                ) : null}
              </div>
            ) : null}
            {canWrite && active ? (
              <B2bProposalLifecycleForms
                proposalId={proposal.id}
                opportunityId={opportunity.id}
                status={proposal.status}
                expectedOpportunityVersion={opportunity.version}
              />
            ) : null}
          </article>
        ))}
      </section>
      {canWrite && active ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <B2bCloseOpportunityForm
            opportunityId={opportunity.id}
            expectedVersion={opportunity.version}
          />
        </section>
      ) : null}
      <section
        aria-labelledby="b2b-copilot"
        className="space-y-4 rounded-xl border border-border bg-card p-5"
      >
        <div>
          <h2 id="b2b-copilot" className="text-2xl font-semibold">
            Copiloto 0-PII
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Clasifica prioridad y siguiente acción usando solo agregados numéricos y estados. No
            modifica precios ni oportunidades.
          </p>
        </div>
        {canWrite ? (
          !copilotAuthorized ? (
            <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              Confirma tu autenticador para habilitar el Copiloto 0-PII y leer las credenciales
              disponibles.
            </p>
          ) : credentials.length > 0 ? (
            <B2bCopilotForm
              opportunityId={opportunity.id}
              requestId={randomUUID()}
              credentials={credentials}
            />
          ) : canReadIntegrations ? (
            <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              Configura una credencial Google Gemini en{" "}
              <Link href="/admin/integraciones" className="text-primary underline">
                Integraciones
              </Link>{" "}
              para habilitar el análisis real.
            </p>
          ) : (
            <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              Solicita a un rol con permisos de integraciones configurar una credencial Google
              Gemini activa para habilitar el análisis real.
            </p>
          )
        ) : null}
        {opportunity.copilotRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay ejecuciones del Copiloto.</p>
        ) : (
          <ul className="space-y-3">
            {opportunity.copilotRuns.map((run) => {
              const output = copilotOutput(run.output);
              return (
                <li key={run.id} className="rounded-lg border border-border p-4 text-sm">
                  <p className="font-medium">
                    {run.status === "SUCCEEDED"
                      ? "Clasificación completada"
                      : run.status === "FAILED"
                        ? "Ejecución fallida"
                        : "Ejecución solicitada"}{" "}
                    · {run.model}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateFormatter.format(run.createdAt)}
                  </p>
                  {output ? (
                    <p className="mt-2">
                      Prioridad <strong>{output.priority}</strong> · Siguiente acción:{" "}
                      <strong>{output.action}</strong> · confianza {output.confidence / 100}%
                    </p>
                  ) : null}
                  {output && output.reasons.length > 0 ? (
                    <p className="mt-1 text-muted-foreground">
                      Motivos: {output.reasons.join(", ")}
                    </p>
                  ) : null}
                  {run.failureCode ? (
                    <p className="mt-2 text-destructive">{formatCopilotFailure(run.failureCode)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
