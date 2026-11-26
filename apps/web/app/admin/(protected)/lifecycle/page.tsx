import {
  customerSegmentStatusLabels,
  hasAdminPermission,
  lifecycleEnrollmentExitReasonLabels,
  lifecycleEnrollmentStatusLabels,
  lifecycleJourneyStatusLabels,
  lifecycleMessageStatusLabels,
} from "@mundonettech/core";
import { LifecycleError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { JourneyEditorForm, JourneyStateButtons } from "@/components/admin/lifecycle-forms";
import { Button } from "@/components/ui/button";
import { single } from "@/lib/admin-search-params";
import { requireAdminPage } from "@/lib/security/admin-auth";
import { lifecycleService, segmentationService } from "@/lib/lifecycle";

export const metadata = { title: "Journeys lifecycle" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const uuidParamSchema = z.string().uuid().optional();
const emailStatusLabels: Record<string, string> = {
  QUEUED: "Correo en cola",
  SENDING: "Enviando",
  SENT: "Enviado",
  DELIVERY_DELAYED: "Entrega demorada",
  DELIVERED: "Entregado",
  BOUNCED: "Rebotado",
  COMPLAINED: "Reportado como spam",
  SUPPRESSED: "Suprimido",
  CANCELLED: "Cancelado",
  FAILED: "Fallido",
};

export default async function LifecyclePage({ searchParams }: PageProps<"/admin/lifecycle">) {
  const session = await requireAdminPage("crm:read");
  const raw = await searchParams;
  const rawJourney = single(raw.journey) || undefined;
  const rawCursor = single(raw.cursor) || undefined;
  const parsedJourney = uuidParamSchema.safeParse(rawJourney);
  const parsedCursor = uuidParamSchema.safeParse(rawCursor);
  const paramsValid = parsedJourney.success && parsedCursor.success;
  const validJourney = parsedJourney.success ? parsedJourney.data : undefined;
  const validCursor = parsedCursor.success ? parsedCursor.data : undefined;

  const lifecycle = lifecycleService();
  let invalidCursorFromDb = false;
  const [journeys, segments] = await Promise.all([
    parsedCursor.success
      ? lifecycle
          .listJourneys(session.profile.id, {
            ...(validCursor ? { cursor: validCursor } : {}),
          })
          .catch((error: unknown) => {
            if (
              error instanceof LifecycleError &&
              (error.code === "NOT_FOUND" || error.code === "VALIDATION")
            ) {
              invalidCursorFromDb = true;
              return { items: [], nextCursor: null };
            }
            throw error;
          })
      : Promise.resolve({ items: [], nextCursor: null }),
    segmentationService().listSegments(session.profile.id, { limit: 100 }),
  ]);
  const detailResult = validJourney
    ? await lifecycle.getJourneyDetail(session.profile.id, validJourney).then(
        (record) => ({ record, notFound: false }),
        (error: unknown) => {
          if (error instanceof LifecycleError && error.code === "NOT_FOUND") {
            return { record: null, notFound: true };
          }
          throw error;
        },
      )
    : null;
  const detail = detailResult?.record ?? null;
  const detailNotFound = detailResult?.notFound ?? false;
  const queryInvalid = !paramsValid || invalidCursorFromDb;
  const canWrite = hasAdminPermission(session.profile.role, "crm:write");
  const canReadFinance = hasAdminPermission(session.profile.role, "finance:read");

  const firstPageParams = new URLSearchParams();
  if (validJourney && !detailNotFound) firstPageParams.set("journey", validJourney);
  const firstPageHref = firstPageParams.size
    ? `/admin/lifecycle?${firstPageParams.toString()}`
    : "/admin/lifecycle";

  const nextParams = new URLSearchParams(firstPageParams);
  if (journeys.nextCursor) nextParams.set("cursor", journeys.nextCursor);

  const openJourneyHref = (journeyId: string) => {
    const params = new URLSearchParams();
    params.set("journey", journeyId);
    if (validCursor && !invalidCursorFromDb) params.set("cursor", validCursor);
    return `/admin/lifecycle?${params.toString()}`;
  };
  const showClearFilters =
    Boolean(rawJourney) || Boolean(rawCursor) || queryInvalid || detailNotFound;
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Journeys lifecycle</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Secuencias persistentes e idempotentes. Cada despacho vuelve a validar journey,
          inscripción, membresía, consentimiento y supresión antes de crear o enviar el correo.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <Link className="text-primary underline" href="/admin/crm">
            Abrir consola CRM 360°
          </Link>
          <Link className="text-primary underline" href="/admin/fidelizacion">
            Ver fidelización y referidos
          </Link>
          <Link className="text-primary underline" href="/admin/segmentos">
            Administrar segmentos y evidencia
          </Link>
          {canReadFinance ? (
            <Link className="text-primary underline" href="/admin/analitica-rfm">
              Ver analítica RFM/LTV
            </Link>
          ) : null}
        </div>
      </div>
      {canWrite ? (
        <CmsStepUp session={session} />
      ) : (
        <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          Vista de solo lectura para tu rol actual.
        </p>
      )}
      {canWrite ? (
        <section aria-labelledby="journey-create" className="space-y-4">
          <h2 id="journey-create" className="text-2xl font-semibold">
            Nuevo journey
          </h2>
          <div className="rounded-xl border border-border bg-card p-5">
            <JourneyEditorForm
              segments={segments.items.map(({ id, name, status }) => ({ id, name, status }))}
            />
          </div>
        </section>
      ) : null}
      <section aria-labelledby="journey-list" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="journey-list" className="text-2xl font-semibold">
            Journeys persistidos
          </h2>
          {showClearFilters ? (
            <Link href="/admin/lifecycle" className="text-sm text-primary underline">
              Limpiar filtros
            </Link>
          ) : null}
        </div>
        {queryInvalid ? (
          <p role="alert" className="text-sm text-destructive">
            El journey o cursor no es válido.
          </p>
        ) : detailNotFound ? (
          <p role="alert" className="text-sm text-destructive">
            El journey solicitado no existe o ya no está disponible.
          </p>
        ) : null}
        {journeys.items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No hay journeys en esta página. Crea un segmento y una secuencia para comenzar.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {journeys.items.map((journey) => (
              <article key={journey.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">{journey.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {lifecycleJourneyStatusLabels[journey.status]} · {journey._count.steps} pasos
                      · {journey._count.enrollments} inscripciones
                    </p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={openJourneyHref(journey.id)}>Abrir</Link>
                  </Button>
                </div>
                <p className="mt-3 text-sm">{journey.description ?? "Sin descripción."}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Segmento: {journey.segment.name} (
                  {customerSegmentStatusLabels[journey.segment.status]})
                </p>
              </article>
            ))}
          </div>
        )}
        {rawCursor || journeys.nextCursor ? (
          <nav aria-label="Paginación de journeys" className="flex flex-wrap items-center gap-4">
            {rawCursor ? (
              <Link className="text-sm text-primary underline" href={firstPageHref}>
                Primera página
              </Link>
            ) : null}
            {journeys.nextCursor ? (
              <Link
                className="text-sm text-primary underline"
                href={`/admin/lifecycle?${nextParams.toString()}`}
              >
                Página siguiente
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
      {detail ? (
        <section aria-labelledby="journey-detail" className="space-y-5">
          <div>
            <h2 id="journey-detail" className="text-2xl font-semibold">
              {detail.name}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {lifecycleJourneyStatusLabels[detail.status]} · {detail.segment.name} · versión{" "}
              {detail.version}
            </p>
          </div>
          {canWrite ? (
            <JourneyStateButtons
              key={`state:${detail.id}`}
              journey={{ id: detail.id, version: detail.version, status: detail.status }}
            />
          ) : null}
          {canWrite && detail.status === "DRAFT" ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <JourneyEditorForm
                key={`editor:${detail.id}`}
                journey={{
                  id: detail.id,
                  name: detail.name,
                  description: detail.description,
                  segmentId: detail.segmentId,
                  version: detail.version,
                  steps: detail.steps,
                }}
                segments={segments.items.map(({ id, name, status }) => ({ id, name, status }))}
              />
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-border bg-card p-5">
              <h3 className="font-semibold">Pasos sellados</h3>
              <ol className="space-y-2 text-sm">
                {detail.steps.map((step) => (
                  <li key={step.position}>
                    Paso {step.position + 1}: {step.subject} · {step.offsetMinutes} minutos desde la
                    inscripción
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="space-y-3">
            <h3 className="text-xl font-semibold">Inscripciones y mensajes</h3>
            {detail.enrollments.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
                No hay inscripciones. El scheduler inscribirá miembros elegibles una sola vez por
                journey.
              </p>
            ) : (
              <div className="space-y-3">
                {detail.enrollments.map((enrollment) => (
                  <article
                    key={enrollment.id}
                    className="rounded-xl border border-border bg-card p-5"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <h4 className="font-medium">{enrollment.customerEmail}</h4>
                      <p className="text-sm">
                        {lifecycleEnrollmentStatusLabels[enrollment.status]}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Ingresó {dateFormatter.format(enrollment.enteredAt)}
                      {enrollment.exitReason
                        ? ` · ${
                            lifecycleEnrollmentExitReasonLabels[
                              enrollment.exitReason as keyof typeof lifecycleEnrollmentExitReasonLabels
                            ] ?? enrollment.exitReason
                          }`
                        : ""}
                    </p>
                    <ul className="mt-3 space-y-2 text-sm">
                      {enrollment.messages.map((message) => (
                        <li
                          key={message.id}
                          className="flex flex-wrap justify-between gap-2 border-t border-border pt-2"
                        >
                          <span>
                            Paso {message.step.position + 1} ·{" "}
                            {dateFormatter.format(message.scheduledAt)}
                          </span>
                          <span>
                            {lifecycleMessageStatusLabels[message.status]}
                            {message.emailEvent
                              ? ` · ${emailStatusLabels[message.emailEvent.status] ?? message.emailEvent.status}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
