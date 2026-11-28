"use client";

import { useState } from "react";

export interface SegmentDistributionRow {
  readonly key: string;
  readonly label: string;
  readonly customers: number;
  readonly ltvNumber: number;
  readonly formattedLtv: string;
}

const numberFormatter = new Intl.NumberFormat("es-CO");

export function SegmentBarChart({
  rows,
}: Readonly<{
  rows: readonly SegmentDistributionRow[];
}>) {
  const [metric, setMetric] = useState<"customers" | "ltv">("ltv");

  const totalCustomers = rows.reduce((acc, row) => acc + row.customers, 0);
  const maxCustomers = Math.max(1, ...rows.map((row) => row.customers));
  const maxLtv = Math.max(1, ...rows.map((row) => Math.max(0, row.ltvNumber)));

  return (
    <section
      aria-label="Distribución visual por segmento RFM"
      className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            Comparativa por segmento RFM
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Alterna entre volumen de clientes y valor de vida neto (LTV) en COP.
          </p>
        </div>
        <div
          role="group"
          aria-label="Métrica de distribución RFM"
          className="inline-flex rounded-full border border-border bg-secondary p-1"
        >
          <button
            type="button"
            aria-pressed={metric === "ltv"}
            onClick={() => setMetric("ltv")}
            className={`min-h-8 rounded-full px-3 text-xs font-semibold outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              metric === "ltv"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            LTV neto (COP)
          </button>
          <button
            type="button"
            aria-pressed={metric === "customers"}
            onClick={() => setMetric("customers")}
            className={`min-h-8 rounded-full px-3 text-xs font-semibold outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              metric === "customers"
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Clientes
          </button>
        </div>
      </div>

      <div className="mt-5 space-y-3.5">
        {rows.map((row) => {
          const ratio =
            metric === "customers"
              ? row.customers / maxCustomers
              : Math.max(0, row.ltvNumber) / maxLtv;
          const widthPct = ratio > 0 ? Math.max(3, Math.round(ratio * 100)) : 0;
          const sharePct =
            totalCustomers > 0 ? ((row.customers / totalCustomers) * 100).toFixed(1) : "0.0";

          return (
            <div key={row.key} className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">{row.label}</span>
                <div className="flex items-baseline gap-2.5 font-mono tabular-nums">
                  <span className="font-semibold text-foreground">
                    {metric === "customers"
                      ? `${numberFormatter.format(row.customers)} clientes`
                      : row.formattedLtv}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{sharePct}% base</span>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    metric === "ltv" ? "bg-success" : "bg-brand-cyan"
                  }`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
