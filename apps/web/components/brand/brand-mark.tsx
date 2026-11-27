import { storeConfig } from "@mundonettech/config/store";

export interface BrandMarkProps {
  readonly size?: number;
  readonly variant?: "on-light" | "on-dark";
  readonly className?: string;
}

/**
 * Scalable SVG isotype for MundoNetTech:
 * Concentric segmented cyan orbital rings framing a precision microchip with neural circuit core.
 * Driven 100% by semantic CSS custom properties from config/theme.config.ts.
 */
export function BrandMark({ size = 32, variant = "on-light", className }: BrandMarkProps) {
  const plateFill =
    variant === "on-light" ? "var(--brand-surface)" : "var(--brand-surface-elevated)";
  const plateStroke = "var(--brand-surface-border)";
  const ringStroke = "var(--brand-cyan)";
  const coreStroke = "var(--brand-surface-foreground)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="16"
        fill={plateFill}
        stroke={plateStroke}
        strokeWidth="1.5"
      />
      {/* Outer segmented orbital network ring */}
      <circle
        cx="32"
        cy="32"
        r="24"
        stroke={ringStroke}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="32 9 20 8 44 10 18 10"
      />
      {/* Middle precision orbital track */}
      <circle
        cx="32"
        cy="32"
        r="19.5"
        stroke={ringStroke}
        strokeOpacity="0.65"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeDasharray="16 8 6 6 24 8 8 6"
      />
      {/* Orbital nodes */}
      <circle cx="53" cy="20" r="1.75" fill={ringStroke} />
      <circle cx="11" cy="44" r="1.75" fill={ringStroke} />
      {/* Central microchip pins (3 per side) */}
      <g stroke={coreStroke} strokeWidth="1.75" strokeLinecap="round">
        {/* Top pins */}
        <line x1="27" y1="16.5" x2="27" y2="21.5" />
        <line x1="32" y1="15.5" x2="32" y2="21.5" />
        <line x1="37" y1="16.5" x2="37" y2="21.5" />
        {/* Bottom pins */}
        <line x1="27" y1="42.5" x2="27" y2="47.5" />
        <line x1="32" y1="42.5" x2="32" y2="48.5" />
        <line x1="37" y1="42.5" x2="37" y2="47.5" />
        {/* Left pins */}
        <line x1="16.5" y1="27" x2="21.5" y2="27" />
        <line x1="15.5" y1="32" x2="21.5" y2="32" />
        <line x1="16.5" y1="37" x2="21.5" y2="37" />
        {/* Right pins */}
        <line x1="42.5" y1="27" x2="47.5" y2="27" />
        <line x1="42.5" y1="32" x2="48.5" y2="32" />
        <line x1="42.5" y1="37" x2="47.5" y2="37" />
      </g>
      {/* Microchip terminal nodes */}
      <circle cx="32" cy="15.5" r="1.4" fill={ringStroke} />
      <circle cx="32" cy="48.5" r="1.4" fill={ringStroke} />
      <circle cx="15.5" cy="32" r="1.4" fill={ringStroke} />
      <circle cx="48.5" cy="32" r="1.4" fill={ringStroke} />
      {/* Microchip housing */}
      <rect
        x="21.5"
        y="21.5"
        width="21"
        height="21"
        rx="4"
        fill={plateFill}
        stroke={coreStroke}
        strokeWidth="2"
      />
      {/* Stylized neural-circuit core inside chip */}
      <path
        d="M32 25.5V38.5M30.5 26C28.4 26 27 27.3 27 29.1C26 29.6 25.4 30.7 25.6 32C25.4 33.3 26.1 34.4 27.1 34.9C27.2 36.7 28.6 38 30.5 38M33.5 26C35.6 26 37 27.3 37 29.1C38 29.6 38.6 30.7 38.4 32C38.6 33.3 37.9 34.4 36.9 34.9C36.8 36.7 35.4 38 33.5 38"
        stroke={ringStroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="29" cy="30.5" r="1" fill={coreStroke} />
      <circle cx="35" cy="30.5" r="1" fill={coreStroke} />
      <circle cx="29" cy="34" r="1" fill={coreStroke} />
      <circle cx="35" cy="34" r="1" fill={coreStroke} />
    </svg>
  );
}

export function BrandWordmark({
  variant = "on-light",
  size = 32,
  subtitle,
}: {
  readonly variant?: "on-light" | "on-dark";
  readonly size?: number;
  readonly subtitle?: string;
}) {
  const nameClass = variant === "on-light" ? "text-foreground" : "text-brand-surface-foreground";
  const subtitleClass = variant === "on-light" ? "text-muted-foreground" : "text-brand-cyan";

  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandMark size={size} variant={variant} className="shrink-0" />
      <span className="flex flex-col leading-none">
        <span className={`text-base font-bold tracking-tight sm:text-lg ${nameClass}`}>
          {storeConfig.name}
        </span>
        {subtitle ? (
          <span
            aria-hidden="true"
            className={`mt-1 text-[11px] font-medium tracking-wider uppercase ${subtitleClass}`}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
