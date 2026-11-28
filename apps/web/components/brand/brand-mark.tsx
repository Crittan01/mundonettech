import { storeConfig } from "@mundonettech/config/store";

export interface BrandMarkProps {
  readonly size?: number;
  readonly variant?: "on-light" | "on-dark";
  readonly className?: string;
}

/**
 * Scalable geometric SVG isotype for MundoNetTech:
 * Modular "M" circuit-node monogram — Electric Sky outer pillars + crisp obsidian/white inner V-circuit.
 * Driven 100% by semantic CSS custom properties from config/theme.config.ts.
 */
export function BrandMark({ size = 32, variant = "on-light", className }: BrandMarkProps) {
  const accent = "var(--brand-cyan)";
  const core = variant === "on-light" ? "var(--foreground)" : "var(--brand-surface-foreground)";
  const innerCut = variant === "on-light" ? "var(--background)" : "var(--brand-surface)";

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
      {/* Left & right vertical electric-sky circuit pillars */}
      <path d="M12 16V48" stroke={accent} strokeWidth="5.2" strokeLinecap="round" />
      <path d="M52 16V48" stroke={accent} strokeWidth="5.2" strokeLinecap="round" />
      {/* Upper diagonal sky shoulders meeting central V */}
      <path
        d="M12 16L24.5 28.5M52 16L39.5 28.5"
        stroke={accent}
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Central precision circuit V-bridge */}
      <path
        d="M21 25L32 37.5L43 25"
        stroke={core}
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Lower diagonal circuit legs */}
      <path
        d="M21 44.5L32 37.5L43 44.5"
        stroke={core}
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Four outer sky terminal nodes */}
      <circle cx="12" cy="14" r="4.6" fill={accent} />
      <circle cx="12" cy="50" r="4.6" fill={accent} />
      <circle cx="52" cy="14" r="4.6" fill={accent} />
      <circle cx="52" cy="50" r="4.6" fill={accent} />
      {/* Inner terminal nodes */}
      <circle cx="21" cy="44.5" r="3.4" fill={core} />
      <circle cx="43" cy="44.5" r="3.4" fill={core} />
      <circle cx="32" cy="37.5" r="4.4" fill={core} />
      <circle cx="32" cy="37.5" r="1.8" fill={innerCut} />
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
