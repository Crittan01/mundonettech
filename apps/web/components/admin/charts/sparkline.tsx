import { useId } from "react";

type SparklineTone = "cyan" | "success" | "primary";

const strokeVarByTone: Record<SparklineTone, string> = {
  cyan: "var(--brand-cyan)",
  success: "var(--success)",
  primary: "var(--primary)",
};

export function Sparkline({
  values,
  tone = "cyan",
  label,
}: Readonly<{
  values: readonly number[];
  tone?: SparklineTone;
  label: string;
}>) {
  const gradientId = useId();
  const width = 92;
  const height = 28;
  const padY = 4;
  const padX = 2;

  const series = values.length > 1 ? values : [0, values[0] ?? 0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const points = series.map((value, index) => {
    const x = padX + (index / (series.length - 1)) * innerW;
    const y = padY + innerH - ((value - min) / span) * innerH;
    return { x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const areaPath = `${linePath} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`;
  const stroke = strokeVarByTone[tone];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="shrink-0 overflow-visible"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={last.x}
        cy={last.y}
        r="2.4"
        fill="var(--card)"
        stroke={stroke}
        strokeWidth="1.5"
      />
    </svg>
  );
}
