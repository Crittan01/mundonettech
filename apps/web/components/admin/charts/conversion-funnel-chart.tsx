const numberFormatter = new Intl.NumberFormat("es-CO");

export interface FunnelStepMetric {
  readonly label: string;
  readonly count: number;
  readonly conversionLabel?: string;
}

export function ConversionFunnelChart({
  steps,
}: Readonly<{
  steps: readonly FunnelStepMetric[];
}>) {
  const max = Math.max(1, ...steps.map((step) => step.count));

  return (
    <div className="space-y-3.5">
      {steps.map((step, index) => {
        const widthPct = Math.max(step.count > 0 ? 4 : 0, Math.round((step.count / max) * 100));
        const sharePct = max > 0 ? ((step.count / max) * 100).toFixed(1) : "0.0";
        const isLast = index === steps.length - 1;

        return (
          <div key={step.label} className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-semibold text-muted-foreground tabular-nums">
                  0{index + 1}
                </span>
                <span className="font-medium text-foreground">{step.label}</span>
                {step.conversionLabel ? (
                  <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[11px] font-semibold text-accent-foreground tabular-nums">
                    {step.conversionLabel}
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-2 tabular-nums">
                <span className="font-mono text-sm font-semibold text-foreground">
                  {numberFormatter.format(step.count)}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{sharePct}%</span>
              </div>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isLast ? "bg-success" : "bg-brand-cyan"
                }`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
