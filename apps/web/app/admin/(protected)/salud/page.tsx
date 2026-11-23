import { OperationalHealthService } from "@mundonettech/db";
import Link from "next/link";

import { getDatabase } from "@/lib/db";
import { getIntegrationEnvironment } from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Salud y recuperación" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");
const statusLabels = {
  HEALTHY: "Saludable",
  DEGRADED: "Degradada",
  CRITICAL: "Crítica",
  RUNNING: "En ejecución",
  SUCCEEDED: "Exitosa",
  FAILED: "Fallida",
} as const;
const failureLabels: Record<string, string> = {
  BACKUP_STALE_RUN: "La ejecución superó su tiempo máximo.",
  BACKUP_NOT_FRESH: "El respaldo superó la ventana de 36 horas.",
  BACKUP_HASH_MISMATCH: "El hash del objeto cifrado no coincide.",
  BACKUP_MANIFEST_MISMATCH: "El manifiesto no coincide con la evidencia.",
  DR_SCHEMA_MISMATCH: "La restauración no reproduce el esquema esperado.",
  DR_BUCKET_COVERAGE_INCOMPLETE: "La cobertura o lectura de buckets es incompleta.",
  GPG_ENCRYPTION_FAILED: "GPG no completó el cifrado.",
  GPG_DECRYPTION_FAILED: "GPG no pudo descifrar con la credencial configurada.",
  PG_DUMP_FAILED: "PostgreSQL no completó el volcado.",
  PG_RESTORE_FAILED: "PostgreSQL no completó la restauración.",
  R2_BUCKET_ACCESS_FAILED: "Al menos un bucket no está accesible.",
};

function date(value: string | null): string {
  return value ? dateFormatter.format(new Date(value)) : "Sin evidencia";
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export default async function HealthPage() {
  const session = await requireAdminPage("audit:read");
  const dashboard = await new OperationalHealthService(getDatabase()).dashboard(
    session.profile.id,
    getIntegrationEnvironment(),
  );
  const { snapshot } = dashboard;
  const latestBackup = dashboard.backups[0];
  const cards = [
    ["Base de datos", snapshot.databaseReady ? "Apta" : "No apta"],
    ["Eventos pendientes", numberFormatter.format(snapshot.pendingOutbox)],
    ["Eventos fallidos", numberFormatter.format(snapshot.failedOutbox)],
    ["Respaldo ≤ 36 h", snapshot.backupFresh ? "Vigente" : "Requiere acción"],
    ["DR mensual", snapshot.drillCurrent ? "Vigente" : "Requiere acción"],
  ] as const;
  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm font-semibold text-primary">Observabilidad sin RUM crudo</p>
        <h1 className="mt-2 text-3xl font-bold">Salud operativa y recuperación</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Sondas, contadores agregados y evidencia inmutable de respaldos cifrados y restauraciones.
          Las alertas operativas se gestionan desde la bandeja de hoy con permisos de auditoría.
        </p>
      </div>
      <section
        role={snapshot.status === "HEALTHY" ? "status" : "alert"}
        className="rounded-xl border border-border bg-card p-5 aria-[current=true]:border-destructive"
        aria-current={snapshot.status !== "HEALTHY"}
      >
        <h2 className="text-xl font-semibold">Estado: {statusLabels[snapshot.status]}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Captura {date(snapshot.capturedAt)} · latencia de consulta {snapshot.databaseLatencyMs}{" "}
          ms.
          {snapshot.status === "HEALTHY"
            ? " Todas las comprobaciones vigentes están dentro de sus umbrales."
            : " Revisa las secciones siguientes y ejecuta el procedimiento indicado antes de promover cambios."}
        </p>
        <Link href="/admin/hoy" className="mt-4 inline-block font-semibold underline">
          Revisar alertas accionables
        </Link>
      </section>
      <section aria-label="Resumen de salud" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(([label, value]) => (
          <article key={label} className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-3 text-2xl font-bold">{value}</p>
          </article>
        ))}
      </section>
      <section
        aria-labelledby="recovery-runbook"
        className="rounded-xl border border-border bg-card p-6"
      >
        <h2 id="recovery-runbook" className="text-xl font-semibold">
          Procedimiento operativo
        </h2>
        <ol className="mt-4 list-decimal space-y-3 pl-6 text-sm leading-6 text-muted-foreground">
          <li>
            Programa <code className="text-foreground">pnpm backup:create</code> al menos cada 24
            horas y <code className="text-foreground">pnpm dr:drill</code> mensualmente en el
            ambiente aislado correspondiente.
          </li>
          <li>
            Si una corrida falla, conserva su código, valida credenciales y conectividad sin
            imprimir secretos y repite el comando. Nunca restaures sobre la base de origen.
          </li>
          <li>
            Una ejecución exitosa no sustituye las aprobaciones de lanzamiento. Verifica también las
            sondas <code className="text-foreground">/api/health/live</code> y{" "}
            <code className="text-foreground">/api/health/ready</code>.
          </li>
        </ol>
      </section>
      <section aria-labelledby="backup-history" className="space-y-4">
        <div>
          <h2 id="backup-history" className="text-xl font-semibold">
            Respaldos recientes
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Último éxito: {date(snapshot.latestSuccessfulBackupAt)}
            {latestBackup?.failureCode
              ? ` · Último fallo: ${failureLabels[latestBackup.failureCode] ?? "Consulta el código de corrida en el runbook."}`
              : ""}
          </p>
        </div>
        {dashboard.backups.length === 0 ? (
          <Empty>
            No existe evidencia de respaldos. Ejecuta el procedimiento antes de continuar.
          </Empty>
        ) : (
          <div className="space-y-4">
            {dashboard.backups.map((backup) => (
              <article key={backup.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <h3 className="font-semibold">{statusLabels[backup.status]}</h3>
                  <p className="text-sm text-muted-foreground">{date(backup.startedAt)}</p>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">Finalizó</dt>
                    <dd className="mt-1">{date(backup.completedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Bytes cifrados</dt>
                    <dd className="mt-1">
                      {backup.byteSize ? numberFormatter.format(BigInt(backup.byteSize)) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Esquema auth</dt>
                    <dd className="mt-1">
                      {backup.authSchemaVerified ? "Verificado" : "No verificado"}
                    </dd>
                  </div>
                </dl>
                {backup.failureCode ? (
                  <p role="alert" className="mt-4 text-sm">
                    {failureLabels[backup.failureCode] ?? `Fallo registrado: ${backup.failureCode}`}
                  </p>
                ) : null}
                <ul aria-label="Cobertura de buckets" className="mt-4 flex flex-wrap gap-2 text-xs">
                  {backup.buckets.map((bucket) => (
                    <li key={bucket.bucketName} className="rounded-md bg-secondary px-3 py-2">
                      {bucket.bucketName}: {bucket.accessible ? "accesible" : "sin acceso"}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="dr-history" className="space-y-4">
        <div>
          <h2 id="dr-history" className="text-xl font-semibold">
            Simulacros de recuperación
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Último éxito: {date(snapshot.latestSuccessfulDrillAt)} · próximo vencimiento:{" "}
            {date(
              dashboard.drills.find((drill) => drill.status === "SUCCEEDED")?.nextDueAt ?? null,
            )}
          </p>
        </div>
        {dashboard.drills.length === 0 ? (
          <Empty>No existe evidencia de restauración. Programa el primer simulacro mensual.</Empty>
        ) : (
          <div className="space-y-4">
            {dashboard.drills.map((drill) => (
              <article key={drill.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <h3 className="font-semibold">{statusLabels[drill.status]}</h3>
                  <p className="text-sm text-muted-foreground">{date(drill.startedAt)}</p>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {drill.verifiedRelationCount} relaciones verificadas · auth{" "}
                  {drill.authSchemaVerified ? "verificado" : "no verificado"} · siguiente ejercicio{" "}
                  {date(drill.nextDueAt)}
                </p>
                {drill.failureCode ? (
                  <p role="alert" className="mt-4 text-sm">
                    {failureLabels[drill.failureCode] ?? `Fallo registrado: ${drill.failureCode}`}
                  </p>
                ) : null}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <caption className="sr-only">Verificación del 100 % de los buckets</caption>
                    <thead className="bg-secondary">
                      <tr>
                        <th scope="col" className="p-3">
                          Bucket
                        </th>
                        <th scope="col" className="p-3">
                          Acceso
                        </th>
                        <th scope="col" className="p-3">
                          Objetos
                        </th>
                        <th scope="col" className="p-3">
                          Lectura
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {drill.buckets.map((bucket) => (
                        <tr key={bucket.bucketName} className="border-t border-border">
                          <th scope="row" className="p-3">
                            {bucket.bucketName}
                          </th>
                          <td className="p-3">{bucket.accessible ? "Verificado" : "Fallido"}</td>
                          <td className="p-3">
                            {bucket.objectCount
                              ? numberFormatter.format(BigInt(bucket.objectCount))
                              : "—"}
                          </td>
                          <td className="p-3">
                            {bucket.objectCount === "0"
                              ? "Vacío; no aplica"
                              : bucket.readVerified
                                ? "Verificada"
                                : "No verificada"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="health-history" className="space-y-4">
        <h2 id="health-history" className="text-xl font-semibold">
          Capturas agregadas recientes
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">
              Historial de salud sin eventos individuales ni PII
            </caption>
            <thead className="bg-secondary">
              <tr>
                {(["Captura", "Estado", "Pendientes", "Fallidos", "Respaldo", "DR"] as const).map(
                  (heading) => (
                    <th key={heading} scope="col" className="p-3">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {dashboard.recentSnapshots.map((record) => (
                <tr key={record.id} className="border-t border-border">
                  <th scope="row" className="p-3">
                    {date(record.capturedAt)}
                  </th>
                  <td className="p-3">{statusLabels[record.status]}</td>
                  <td className="p-3">{record.pendingOutbox}</td>
                  <td className="p-3">{record.failedOutbox}</td>
                  <td className="p-3">{record.backupFresh ? "Vigente" : "Vencido"}</td>
                  <td className="p-3">{record.drillCurrent ? "Vigente" : "Pendiente"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
