const percentFormatter = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function UvtThresholdMeter({
  progressBps,
  status,
  thresholdUvt,
}: Readonly<{
  progressBps: number;
  status: string;
  thresholdUvt: number;
}>) {
  const clampedBps = Math.max(0, Math.min(10_000, progressBps));
  const percent = clampedBps / 100;
  const barTone =
    status === "THRESHOLD_REACHED"
      ? "bg-destructive"
      : status === "APPROACHING_LIMIT"
        ? "bg-warning"
        : "bg-brand-cyan";

  return (
    <div className="mt-5 space-y-2.5">
      <div className="flex items-center justify-between text-xs tabular-nums">
        <span className="font-medium text-muted-foreground">
          Avance acumulado hacia {thresholdUvt.toLocaleString("es-CO")} UVT
        </span>
        <span className="font-mono text-sm font-bold text-foreground">
          {percentFormatter.format(percent)} %
        </span>
      </div>

      <div
        role="progressbar"
        aria-label="Avance hacia el umbral anual"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent * 10) / 10}
        className="relative h-3 w-full overflow-hidden rounded-full border border-border/70 bg-secondary"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barTone}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
        {/* Precision 70% and 90% Alert Threshold Markers */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-[70%] w-px bg-foreground/30"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-[90%] w-px bg-foreground/45"
        />
      </div>

      <div className="relative flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>0 %</span>
        <span>70 % alerta temprana</span>
        <span>90 % crítico</span>
        <span>100 % ({thresholdUvt.toLocaleString("es-CO")} UVT)</span>
      </div>
    </div>
  );
}
