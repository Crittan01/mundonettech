import {
  customerSegmentStatusLabels,
  formatSignedCopCents,
  hasAdminPermission,
  rfmClassLabels,
  segmentMembershipReasonLabels,
} from "@mundonettech/core";
import { LifecycleError } from "@mundonettech/db";
import Link from "next/link";
import { z } from "zod";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { SegmentEditorForm, SegmentStateButtons } from "@/components/admin/segment-forms";
import { Button } from "@/components/ui/button";
import { requireAdminPage } from "@/lib/security/admin-auth";
import { segmentationService } from "@/lib/lifecycle";

export const metadata = { title: "Segmentos y consentimiento" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const querySchema = z.object({
  segmento: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
});

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SegmentsPage({ searchParams }: PageProps<"/admin/segmentos">) {
  const session = await requireAdminPage("crm:read");
  const raw = await searchParams;
  const parsed = querySchema.safeParse({
    segmento: single(raw.segmento),
    cursor: single(raw.cursor),
  });
  const service = segmentationService();
  const segments = await service.listSegments(session.profile.id, {
    ...(parsed.success && parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
  });
  const detailResult =
    parsed.success && parsed.data.segmento
      ? await service.getSegmentDetail(session.profile.id, parsed.data.segmento).then(
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
  const canWrite = hasAdminPermission(session.profile.role, "crm:write");
  const nextParams = new URLSearchParams();
  if (parsed.success && parsed.data.segmento) nextParams.set("segmento", parsed.data.segmento);
  if (segments.nextCursor) nextParams.set("cursor", segments.nextCursor);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Segmentos y consentimiento</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Audiencias calculadas sobre capturas y reembolsos reales. Solo ingresan cuentas activas
          con autorización comercial vigente y sin supresión de lifecycle.
        </p>
        <div className="mt-4 flex gap-4 text-sm">
          <Link className="underline" href="/admin/lifecycle">
            Administrar journeys
          </Link>
          {hasAdminPermission(session.profile.role, "finance:read") ? (
            <Link className="underline" href="/admin/analitica-rfm">
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
        <section aria-labelledby="segment-create" className="space-y-4">
          <h2 id="segment-create" className="text-2xl font-semibold">
            Nuevo segmento
          </h2>
          <div className="rounded-xl border border-border bg-card p-5">
            <SegmentEditorForm />
          </div>
        </section>
      ) : null}
      <section aria-labelledby="segment-list" className="space-y-4">
        <h2 id="segment-list" className="text-2xl font-semibold">
          Segmentos persistidos
        </h2>
        {!parsed.success ? (
          <p role="alert" className="text-sm text-destructive">
            El segmento o cursor solicitado no es válido.
          </p>
        ) : detailNotFound ? (
          <p role="alert" className="text-sm text-destructive">
            El segmento solicitado no existe o ya no está disponible.
          </p>
        ) : null}
        {segments.items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            No hay segmentos en esta página. Crea uno para comenzar con una finalidad explícita.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {segments.items.map((segment) => (
              <article key={segment.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">{segment.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {customerSegmentStatusLabels[segment.status]} · {segment.members} miembros ·
                      versión {segment.version}
                    </p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/segmentos?segmento=${segment.id}`}>Abrir</Link>
                  </Button>
                </div>
                <p className="mt-3 text-sm">{segment.description ?? "Sin descripción."}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {segment.definition.rfmClass
                    ? rfmClassLabels[segment.definition.rfmClass]
                    : "Todas las clases RFM"}
                  {" · "}
                  {segment.lastRefreshedAt
                    ? `Evaluado ${dateFormatter.format(segment.lastRefreshedAt)}`
                    : "Pendiente de primera evaluación"}
                </p>
              </article>
            ))}
          </div>
        )}
        {segments.nextCursor ? (
          <Link
            className="inline-flex underline"
            href={`/admin/segmentos?${nextParams.toString()}`}
          >
            Página siguiente
          </Link>
        ) : null}
      </section>
      {detail ? (
        <section aria-labelledby="segment-detail" className="space-y-5">
          <div>
            <h2 id="segment-detail" className="text-2xl font-semibold">
              {detail.segment.name}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {customerSegmentStatusLabels[detail.segment.status]} · versión{" "}
              {detail.segment.version}
            </p>
          </div>
          {canWrite ? (
            <SegmentStateButtons key={`state:${detail.segment.id}`} segment={detail.segment} />
          ) : null}
          {canWrite && detail.segment.status === "DRAFT" ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <SegmentEditorForm key={`editor:${detail.segment.id}`} segment={detail.segment} />
            </div>
          ) : null}
          <div className="space-y-3">
            <h3 className="text-xl font-semibold">Evidencia de entradas y salidas</h3>
            {detail.history.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
                Todavía no hay cambios de membresía. Activa el segmento y ejecuta su evaluación.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-[68rem] text-left text-sm">
                  <caption className="sr-only">
                    Historial auditable de membresía del segmento
                  </caption>
                  <thead className="border-b border-border">
                    <tr>
                      <th scope="col" className="p-3">
                        Fecha
                      </th>
                      <th scope="col" className="p-3">
                        Cliente
                      </th>
                      <th scope="col" className="p-3">
                        Cambio
                      </th>
                      <th scope="col" className="p-3">
                        Motivo
                      </th>
                      <th scope="col" className="p-3">
                        Métricas al evaluar
                      </th>
                      <th scope="col" className="p-3">
                        Prueba
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.history.map((entry) => (
                      <tr key={entry.id} className="border-b border-border last:border-0">
                        <td className="p-3">{dateFormatter.format(entry.occurredAt)}</td>
                        <td className="p-3">{entry.customerEmail}</td>
                        <td className="p-3">{entry.status === "ENTERED" ? "Entrada" : "Salida"}</td>
                        <td className="p-3">
                          {
                            segmentMembershipReasonLabels[
                              entry.reason as keyof typeof segmentMembershipReasonLabels
                            ]
                          }
                        </td>
                        <td className="p-3">
                          {entry.metrics.rfmClass in rfmClassLabels
                            ? rfmClassLabels[entry.metrics.rfmClass as keyof typeof rfmClassLabels]
                            : entry.metrics.rfmClass}
                          {" · "}
                          {entry.metrics.frequency} pedidos ·{" "}
                          {formatSignedCopCents(entry.metrics.ltvCents)}
                        </td>
                        <td className="p-3 font-mono text-xs">
                          Consentimiento {entry.consentId.slice(0, 8)} · secuencia {entry.sequence}{" "}
                          · versión {entry.segmentVersion}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
