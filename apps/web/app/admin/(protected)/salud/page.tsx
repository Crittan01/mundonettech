import { hasAdminPermission } from "@mundonettech/core";
import { OperationalHealthService } from "@mundonettech/db";
import {
  Activity,
  AlertTriangle,
  Database,
  HardDriveDownload,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import { HealthUptimeStrip } from "@/components/admin/charts/health-uptime-strip";
import { EmptyState as Empty } from "@/components/admin/empty-state";
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
  AUTH_SCHEMA_MISSING: "La base de origen no contiene el esquema auth o la tabla auth.users.",
  BACKUP_EVIDENCE_FAILED: "No fue posible sellar la evidencia final del respaldo.",
  BACKUP_HASH_MISMATCH: "El hash del objeto cifrado no coincide con el manifiesto.",
  BACKUP_MANIFEST_EMPTY: "El manifiesto del respaldo está vacío.",
  BACKUP_MANIFEST_INVALID: "El manifiesto del respaldo no tiene un formato JSON/UTF-8 válido.",
  BACKUP_MANIFEST_MISMATCH: "El manifiesto no coincide con la evidencia persistida.",
  BACKUP_MANIFEST_TOO_LARGE: "El manifiesto del respaldo supera el tamaño máximo permitido.",
  BACKUP_NOT_FOUND: "No existe un respaldo cifrado exitoso disponible.",
  BACKUP_NOT_FRESH: "El respaldo superó la ventana de vigencia de 36 horas.",
  BACKUP_OBJECT_EMPTY: "El objeto cifrado descargado desde R2 está vacío.",
  BACKUP_SIZE_MISMATCH: "El tamaño del objeto cifrado no coincide con el manifiesto.",
  BACKUP_STALE_RUN: "La ejecución de respaldo superó su tiempo máximo permitido.",
  DATABASE_CONFIGURATION_INVALID: "La configuración de conexión PostgreSQL es inválida.",
  DATABASE_SCHEMA_EMPTY: "El esquema de la base de datos de origen está incompleto.",
  DATABASE_VERSION_UNSUPPORTED: "El respaldo exige PostgreSQL 17 o superior.",
  DR_BUCKET_COVERAGE_INCOMPLETE: "La cobertura, inventario o lectura de buckets es incompleta.",
  DR_DATABASE_VERSION_UNSUPPORTED: "El servidor aislado de DR exige PostgreSQL 17 o superior.",
  DR_EVIDENCE_FAILED: "No fue posible sellar la evidencia final del simulacro DR.",
  DR_MIGRATIONS_INVALID: "El historial de migraciones restaurado está incompleto.",
  DR_SCHEMA_MISMATCH: "La restauración no reproduce exactamente las relaciones public y auth.",
  DR_STALE_RUN: "El simulacro DR superó su tiempo máximo permitido.",
  DR_TARGET_NOT_ISOLATED: "El destino de DR no está aislado de la base de datos de origen.",
  GPG_DECRYPTION_FAILED: "GPG no pudo descifrar con la credencial configurada.",
  GPG_ENCRYPTION_FAILED: "GPG no completó el cifrado del flujo.",
  GPG_PASSPHRASE_CONFIGURATION_INVALID: "La configuración de la frase secreta GPG es inválida.",
  PG_DUMP_FAILED: "PostgreSQL no completó el volcado.",
  PG_RESTORE_FAILED: "PostgreSQL no completó la restauración transaccional.",
  POSTGRES_RUNNER_INVALID: "El ejecutor de herramientas PostgreSQL configurado no es válido.",
  R2_BUCKET_ACCESS_FAILED: "Al menos un bucket configurado no está accesible.",
  R2_BUCKET_COVERAGE_MISMATCH: "Los buckets configurados no coinciden con los descubiertos en R2.",
  R2_BUCKET_DISCOVERY_FAILED: "No fue posible descubrir los buckets visibles en R2.",
  R2_BUCKET_OBJECT_INVALID: "R2 devolvió un objeto sin clave verificable.",
  R2_BUCKET_PAGINATION_INVALID: "R2 devolvió un cursor de paginación inválido.",
  R2_BUCKET_READ_FAILED: "No fue posible verificar la lectura de objetos en R2.",
  R2_CONFIGURATION_INVALID: "La configuración o separación de credenciales R2 es inválida.",
  R2_MULTIPART_UPLOAD_FAILED: "La carga en múltiples partes cifrada hacia R2 falló y fue abortada.",
  RECOVERY_ENVIRONMENT_INVALID: "Los parámetros de entorno de recuperación son inválidos.",
  RECOVERY_STREAM_FAILED: "Un flujo de respaldo o restauración se cerró de forma inesperada.",
  RECOVERY_UNEXPECTED_FAILURE: "Se produjo un fallo inesperado durante el procedimiento.",
};

function date(value: string | null): string {
  return value ? dateFormatter.format(new Date(value)) : "Sin evidencia";
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
    {
      label: "Base de datos",
      value: snapshot.databaseReady ? "Apta" : "No apta",
      ok: snapshot.databaseReady,
      icon: Database,
    },
    {
      label: "Eventos pendientes",
      value: numberFormatter.format(snapshot.pendingOutbox),
      ok: snapshot.pendingOutbox === 0,
      icon: Activity,
    },
    {
      label: "Eventos fallidos",
      value: numberFormatter.format(snapshot.failedOutbox),
      ok: snapshot.failedOutbox === 0,
      icon: AlertTriangle,
    },
    {
      label: "Respaldo ≤ 36 h",
      value: snapshot.backupFresh ? "Vigente" : "Requiere acción",
      ok: snapshot.backupFresh,
      icon: HardDriveDownload,
    },
    {
      label: "DR mensual",
      value: snapshot.drillCurrent ? "Vigente" : "Requiere acción",
      ok: snapshot.drillCurrent,
      icon: RefreshCw,
    },
  ] as const;
  const canReadUsers = hasAdminPermission(session.profile.role, "users:read");
  const canReadOwnSecurity = hasAdminPermission(session.profile.role, "security:read_own");

  const timelineEntries = dashboard.recentSnapshots.map((record) => ({
    id: record.id,
    capturedLabel: date(record.capturedAt),
    status: record.status,
    statusLabel: statusLabels[record.status],
    pendingOutbox: record.pendingOutbox,
    failedOutbox: record.failedOutbox,
    backupFresh: record.backupFresh,
    drillCurrent: record.drillCurrent,
  }));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold tracking-wider text-primary uppercase">
          Observabilidad sin telemetría por visita cruda
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Salud operativa y recuperación</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Sondas, contadores agregados y evidencia inmutable de respaldos cifrados y restauraciones.
          Las alertas operativas se gestionan desde la bandeja de hoy con permisos de auditoría.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <Link
            className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
            href="/admin/auditoria"
          >
            Consultar registros de auditoría
          </Link>
          {canReadUsers ? (
            <Link
              className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
              href="/admin/usuarios"
            >
              Administrar usuarios
            </Link>
          ) : null}
          {canReadOwnSecurity ? (
            <Link
              className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3.5 font-semibold text-primary transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
              href="/admin/seguridad"
            >
              Configurar mi seguridad y MFA
            </Link>
          ) : null}
        </div>
      </div>

      <section
        role={snapshot.status === "HEALTHY" ? "status" : "alert"}
        className={`rounded-2xl border bg-card p-6 shadow-xs ${
          snapshot.status === "HEALTHY" ? "border-border" : "border-destructive"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex size-10 items-center justify-center rounded-xl ${
                snapshot.status === "HEALTHY"
                  ? "bg-success text-success-foreground"
                  : snapshot.status === "DEGRADED"
                    ? "bg-warning text-warning-foreground"
                    : "bg-destructive text-destructive-foreground"
              }`}
            >
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                Estado: {statusLabels[snapshot.status]}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Captura {date(snapshot.capturedAt)} · latencia de consulta{" "}
                <span className="font-mono font-semibold text-foreground tabular-nums">
                  {snapshot.databaseLatencyMs} ms
                </span>
                .
                {snapshot.status === "HEALTHY"
                  ? " Todas las comprobaciones vigentes están dentro de sus umbrales."
                  : " Revisa las secciones siguientes y ejecuta el procedimiento indicado antes de promover cambios."}
              </p>
            </div>
          </div>
          <Link
            href="/admin/hoy"
            className="inline-flex min-h-10 items-center rounded-full border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
          >
            Revisar alertas accionables
          </Link>
        </div>
      </section>

      <section aria-label="Resumen de salud" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article
              key={card.label}
              className="rounded-2xl border border-border bg-card p-5 shadow-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {card.label}
                </h2>
                <Icon
                  className={`size-4 shrink-0 ${card.ok ? "text-success" : "text-warning"}`}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </div>
              <p className="mt-3 font-mono text-xl font-bold text-foreground tabular-nums">
                {card.value}
              </p>
            </article>
          );
        })}
      </section>

      {timelineEntries.length > 0 ? <HealthUptimeStrip entries={timelineEntries} /> : null}

      <section
        aria-labelledby="recovery-runbook"
        className="rounded-2xl border border-border bg-card p-6 shadow-xs"
      >
        <h2 id="recovery-runbook" className="text-xl font-semibold tracking-tight">
          Procedimiento operativo
        </h2>
        <ol className="mt-4 list-decimal space-y-3 pl-6 text-sm leading-6 text-muted-foreground">
          <li>
            Programa <code className="font-mono text-foreground">pnpm backup:create</code> al menos
            cada 24 horas y <code className="font-mono text-foreground">pnpm dr:drill</code>{" "}
            mensualmente en el ambiente aislado correspondiente.
          </li>
          <li>
            Si una corrida falla, conserva su código, valida credenciales y conectividad sin
            imprimir secretos y repite el comando. Nunca restaures sobre la base de origen.
          </li>
          <li>
            Una ejecución exitosa no sustituye las aprobaciones de lanzamiento. Verifica también las
            sondas <code className="font-mono text-foreground">/api/health/live</code> y{" "}
            <code className="font-mono text-foreground">/api/health/ready</code>.
          </li>
        </ol>
      </section>

      <section aria-labelledby="backup-history" className="space-y-4">
        <div>
          <h2 id="backup-history" className="text-xl font-semibold tracking-tight">
            Respaldos recientes
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Últimos {dashboard.backups.length} respaldos (ventana de los 5 más recientes) · Último
            éxito: {date(snapshot.latestSuccessfulBackupAt)}
            {latestBackup?.failureCode
              ? ` · Último fallo: ${failureLabels[latestBackup.failureCode] ?? "Consulta el código de corrida en el procedimiento operativo."}`
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
              <article
                key={backup.id}
                className="rounded-2xl border border-border bg-card p-5 shadow-xs"
              >
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
                    <dd className="mt-1 font-mono tabular-nums">
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
                  <p className="mt-4 text-sm text-destructive">
                    {failureLabels[backup.failureCode] ?? `Fallo registrado: ${backup.failureCode}`}
                  </p>
                ) : null}
                {backup.buckets.length > 0 ? (
                  <ul
                    aria-label="Cobertura de buckets"
                    className="mt-4 flex flex-wrap gap-2 text-xs"
                  >
                    {backup.buckets.map((bucket) => (
                      <li key={bucket.bucketName} className="rounded-full bg-secondary px-3 py-1.5">
                        {bucket.bucketName}: {bucket.accessible ? "accesible" : "sin acceso"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-xs text-muted-foreground">
                    Sin verificación de buckets registrada en esta corrida.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="dr-history" className="space-y-4">
        <div>
          <h2 id="dr-history" className="text-xl font-semibold tracking-tight">
            Simulacros de recuperación
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Últimos {dashboard.drills.length} simulacros (ventana de los 5 más recientes) · Último
            éxito: {date(snapshot.latestSuccessfulDrillAt)} · próximo vencimiento:{" "}
            {date(dashboard.nextDrillDueAt)}
          </p>
        </div>
        {dashboard.drills.length === 0 ? (
          <Empty>No existe evidencia de restauración. Programa el primer simulacro mensual.</Empty>
        ) : (
          <div className="space-y-4">
            {dashboard.drills.map((drill, index) => (
              <article
                key={drill.id}
                className="rounded-2xl border border-border bg-card p-5 shadow-xs"
              >
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
                  <p className="mt-4 text-sm text-destructive">
                    {failureLabels[drill.failureCode] ?? `Fallo registrado: ${drill.failureCode}`}
                  </p>
                ) : null}
                {drill.buckets.length > 0 ? (
                  <div
                    role="region"
                    aria-label={`Verificación de buckets del simulacro ${index + 1}`}
                    tabIndex={0}
                    className="mt-4 overflow-x-auto rounded-xl border border-border outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <caption className="sr-only">Verificación del 100 % de los buckets</caption>
                      <thead className="bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                        <tr>
                          <th scope="col" className="px-4 py-3">
                            Bucket
                          </th>
                          <th scope="col" className="px-4 py-3">
                            Acceso
                          </th>
                          <th scope="col" className="px-4 py-3">
                            Objetos
                          </th>
                          <th scope="col" className="px-4 py-3">
                            Lectura
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {drill.buckets.map((bucket) => (
                          <tr key={bucket.bucketName} className="border-t border-border/80">
                            <th scope="row" className="px-4 py-3">
                              {bucket.bucketName}
                            </th>
                            <td className="px-4 py-3">
                              {bucket.accessible ? "Verificado" : "Fallido"}
                            </td>
                            <td className="px-4 py-3 font-mono tabular-nums">
                              {bucket.objectCount
                                ? numberFormatter.format(BigInt(bucket.objectCount))
                                : "—"}
                            </td>
                            <td className="px-4 py-3">
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
                ) : (
                  <p className="mt-4 text-xs text-muted-foreground">
                    La corrida finalizó antes de inventariar los buckets.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="health-history" className="space-y-4">
        <div>
          <h2 id="health-history" className="text-xl font-semibold tracking-tight">
            Capturas agregadas recientes
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Últimas {dashboard.recentSnapshots.length} capturas agregadas (ventana de las 12 más
            recientes).
          </p>
        </div>
        {dashboard.recentSnapshots.length === 0 ? (
          <Empty>Todavía no hay capturas agregadas de salud registradas.</Empty>
        ) : (
          <div
            role="region"
            aria-label="Tabla de capturas agregadas de salud"
            tabIndex={0}
            className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">
                Historial de salud sin eventos individuales ni PII
              </caption>
              <thead className="bg-secondary/80 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                <tr>
                  {(["Captura", "Estado", "Pendientes", "Fallidos", "Respaldo", "DR"] as const).map(
                    (heading) => (
                      <th key={heading} scope="col" className="px-4 py-3">
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {dashboard.recentSnapshots.map((record) => (
                  <tr
                    key={record.id}
                    className="border-t border-border/80 transition-colors hover:bg-secondary/40"
                  >
                    <th scope="row" className="px-4 py-3 font-medium">
                      {date(record.capturedAt)}
                    </th>
                    <td className="px-4 py-3">{statusLabels[record.status]}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {numberFormatter.format(record.pendingOutbox)}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {numberFormatter.format(record.failedOutbox)}
                    </td>
                    <td className="px-4 py-3">{record.backupFresh ? "Vigente" : "Vencido"}</td>
                    <td className="px-4 py-3">{record.drillCurrent ? "Vigente" : "Pendiente"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
