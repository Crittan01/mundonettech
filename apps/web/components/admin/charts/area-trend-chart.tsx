"use client";

import { useId, useMemo, useState } from "react";

export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: "cyan" | "success" | "primary" | "destructive";
  readonly values: readonly number[];
  readonly formattedValues: readonly string[];
}

const strokeVarByTone: Record<TrendSeries["tone"], string> = {
  cyan: "var(--brand-cyan)",
  success: "var(--success)",
  primary: "var(--primary)",
  destructive: "var(--destructive)",
};

const dotClassByTone: Record<TrendSeries["tone"], string> = {
  cyan: "bg-brand-cyan",
  success: "bg-success",
  primary: "bg-primary",
  destructive: "bg-destructive",
};

function formatCompactAxis(value: number, currencyCop: boolean): string {
  const abs = Math.abs(value);
  const prefix = currencyCop ? "$ " : "";
  if (abs >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${prefix}${(value / 1_000).toFixed(0)}k`;
  return `${prefix}${Math.round(value)}`;
}

export function AreaTrendChart({
  title,
  subtitle,
  labels,
  series,
  currencyCop = false,
  emptyLabel = "Todavía no hay suficientes datos para graficar la serie temporal.",
}: Readonly<{
  title: string;
  subtitle: string;
  labels: readonly string[];
  series: readonly TrendSeries[];
  currencyCop?: boolean;
  emptyLabel?: string;
}>) {
  const baseId = useId();
  const [hiddenKeys, setHiddenKeys] = useState<readonly string[]>([]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => !hiddenKeys.includes(item.key)),
    [hiddenKeys, series],
  );

  const hasPoints = labels.length > 0 && series.some((item) => item.values.some((v) => v !== 0));
  const width = 760;
  const height = 248;
  const padLeft = 58;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const activeSeries = visibleSeries.length > 0 ? visibleSeries : series;
  const rawMax = Math.max(1, ...activeSeries.flatMap((item) => item.values));
  const yMax = rawMax * 1.1;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    ratio,
    value: yMax * ratio,
    y: padTop + plotH * (1 - ratio),
  }));

  const count = labels.length;
  const xFor = (index: number) =>
    count <= 1 ? padLeft + plotW / 2 : padLeft + (index / (count - 1)) * plotW;
  const yFor = (value: number) => padTop + plotH - (Math.max(0, value) / yMax) * plotH;

  const labelStep = count <= 7 ? 1 : Math.ceil(count / 6);
  const inspectedIndex = hoverIndex !== null && hoverIndex < count ? hoverIndex : count - 1;

  function toggleSeries(key: string) {
    setHiddenKeys((prev) => {
      if (prev.includes(key)) return prev.filter((item) => item !== key);
      if (prev.length >= series.length - 1) return prev;
      return [...prev, key];
    });
  }

  return (
    <section
      aria-label={title}
      className="rounded-2xl border border-border bg-card p-5 shadow-xs sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            {title}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {series.map((item) => {
            const hidden = hiddenKeys.includes(item.key);
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={!hidden}
                onClick={() => toggleSeries(item.key)}
                className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  hidden
                    ? "border-border bg-background text-muted-foreground opacity-60"
                    : "border-border bg-secondary/75 text-foreground hover:border-primary"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${dotClassByTone[item.tone]}`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!hasPoints ? (
        <div className="mt-6 flex min-h-44 items-center justify-center rounded-xl border border-dashed border-border bg-secondary/40 p-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {/* Precision Live Readout Header (No Overlap, Exact Tabular Nums) */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-secondary/50 px-3.5 py-2 text-xs">
            <span className="font-mono font-semibold text-foreground">
              {labels[inspectedIndex]}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              {activeSeries.map((item) => (
                <span key={item.key} className="inline-flex items-center gap-1.5 tabular-nums">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${dotClassByTone[item.tone]}`}
                  />
                  <span className="text-muted-foreground">{item.label}:</span>
                  <strong className="font-semibold text-foreground">
                    {item.formattedValues[inspectedIndex]}
                  </strong>
                </span>
              ))}
            </div>
          </div>

          <div
            role="region"
            aria-label={`Gráfica de ${title}`}
            tabIndex={0}
            className="w-full overflow-x-auto rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${title}. ${subtitle}`}
              className="h-60 w-full min-w-[540px] select-none"
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                {activeSeries.map((item) => {
                  const color = strokeVarByTone[item.tone];
                  return (
                    <linearGradient
                      key={item.key}
                      id={`${baseId}-${item.key}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={color} stopOpacity="0.16" />
                      <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                  );
                })}
              </defs>

              {/* Hairline Horizontal Grid */}
              {yTicks.map((tick) => (
                <g key={tick.ratio}>
                  <line
                    x1={padLeft}
                    y1={tick.y}
                    x2={width - padRight}
                    y2={tick.y}
                    stroke="var(--border)"
                    strokeWidth="1"
                    strokeDasharray={tick.ratio === 0 ? undefined : "3 4"}
                  />
                  <text
                    x={padLeft - 10}
                    y={tick.y + 3.5}
                    textAnchor="end"
                    fill="var(--muted-foreground)"
                    fontSize="10.5"
                    className="font-mono tabular-nums"
                  >
                    {formatCompactAxis(tick.value, currencyCop)}
                  </text>
                </g>
              ))}

              {/* Area Fills + Crisp 1.5px Strokes */}
              {activeSeries.map((item) => {
                const color = strokeVarByTone[item.tone];
                const coords = item.values.map((val, idx) => ({ x: xFor(idx), y: yFor(val) }));
                const lineD = coords
                  .map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
                  .join(" ");
                const first = coords[0]!;
                const last = coords[coords.length - 1]!;
                const baselineY = padTop + plotH;
                const areaD = `${lineD} L${last.x.toFixed(1)},${baselineY} L${first.x.toFixed(1)},${baselineY} Z`;

                return (
                  <g key={item.key}>
                    <path d={areaD} fill={`url(#${baseId}-${item.key})`} />
                    <path
                      d={lineD}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.65"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}

              {/* Vertical Crosshair + Hollow Precision Dots */}
              {inspectedIndex >= 0 ? (
                <g>
                  <line
                    x1={xFor(inspectedIndex)}
                    y1={padTop}
                    x2={xFor(inspectedIndex)}
                    y2={padTop + plotH}
                    stroke="var(--muted-foreground)"
                    strokeOpacity="0.45"
                    strokeWidth="1"
                    strokeDasharray="2 3"
                  />
                  {activeSeries.map((item) => {
                    const color = strokeVarByTone[item.tone];
                    const value = item.values[inspectedIndex] ?? 0;
                    return (
                      <circle
                        key={`dot-${item.key}`}
                        cx={xFor(inspectedIndex)}
                        cy={yFor(value)}
                        r="3.5"
                        fill="var(--card)"
                        stroke={color}
                        strokeWidth="1.75"
                      />
                    );
                  })}
                </g>
              ) : null}

              {/* X-Axis Labels */}
              {labels.map((label, idx) =>
                idx % labelStep === 0 || idx === count - 1 ? (
                  <text
                    key={`${label}-${idx}`}
                    x={xFor(idx)}
                    y={height - 8}
                    textAnchor={idx === 0 ? "start" : idx === count - 1 ? "end" : "middle"}
                    fill="var(--muted-foreground)"
                    fontSize="10.5"
                    className="font-mono"
                  >
                    {label}
                  </text>
                ) : null,
              )}

              {/* Invisible Pointer Columns for Smooth Crosshair Tracking */}
              {labels.map((_, idx) => {
                const colW = count <= 1 ? plotW : plotW / count;
                const xStart = count <= 1 ? padLeft : xFor(idx) - colW / 2;
                return (
                  <rect
                    key={`hit-${idx}`}
                    x={Math.max(padLeft, xStart)}
                    y={padTop}
                    width={colW}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                );
              })}
            </svg>
          </div>
        </div>
      )}
    </section>
  );
}
