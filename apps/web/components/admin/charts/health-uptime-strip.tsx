"use client";

import { useState } from "react";

export interface HealthTimelineEntry {
  readonly id: string;
  readonly capturedLabel: string;
  readonly status: "HEALTHY" | "DEGRADED" | "CRITICAL";
  readonly statusLabel: string;
  readonly pendingOutbox: number;
  readonly failedOutbox: number;
  readonly backupFresh: boolean;
  readonly drillCurrent: boolean;
}

const barClassByStatus: Record<HealthTimelineEntry["status"], string> = {
  HEALTHY: "bg-success hover:bg-success/85",
  DEGRADED: "bg-warning hover:bg-warning/85",
  CRITICAL: "bg-destructive hover:bg-destructive/85",
};

export function HealthUptimeStrip({
  entries,
}: Readonly<{
  entries: readonly HealthTimelineEntry[];
}>) {
  const ordered = [...entries].reverse();
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, ordered.length - 1));
  const selected = ordered[selectedIndex];

  if (!selected) return null;

  return (
    <section
      aria-label="Línea de tiempo de salud operativa"
      className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            Continuidad de capturas recientes
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Inspecciona cada corte agregado de base de datos, cola de eventos, respaldo y DR.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" aria-hidden="true" />
            Saludable
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
            Degradada
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
            Crítica
          </span>
        </div>
      </div>

      <ul className="mt-4 flex items-stretch gap-1.5" aria-label="Cortes de salud">
        {ordered.map((entry, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <li key={entry.id} className="flex flex-1">
              <button
                type="button"
                aria-label={`${entry.capturedLabel}: ${entry.statusLabel}`}
                aria-pressed={isSelected}
                onMouseEnter={() => setSelectedIndex(idx)}
                onFocus={() => setSelectedIndex(idx)}
                onClick={() => setSelectedIndex(idx)}
                className={`h-10 w-full rounded-md outline-hidden transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card ${barClassByStatus[entry.status]} ${
                  isSelected ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card" : ""
                }`}
              />
            </li>
          );
        })}
      </ul>

      <dl className="mt-4 grid gap-3 rounded-xl border border-border/80 bg-secondary/50 p-3.5 text-xs sm:grid-cols-5">
        <div>
          <dt className="text-muted-foreground">Captura</dt>
          <dd className="mt-0.5 font-mono font-semibold text-foreground">
            {selected.capturedLabel}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Estado</dt>
          <dd className="mt-0.5 font-semibold text-foreground">{selected.statusLabel}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pendientes / Fallidos</dt>
          <dd className="mt-0.5 font-mono font-semibold text-foreground tabular-nums">
            {selected.pendingOutbox} / {selected.failedOutbox}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Respaldo ≤ 36 h</dt>
          <dd className="mt-0.5 font-semibold text-foreground">
            {selected.backupFresh ? "Vigente" : "Vencido"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">DR mensual</dt>
          <dd className="mt-0.5 font-semibold text-foreground">
            {selected.drillCurrent ? "Vigente" : "Pendiente"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
