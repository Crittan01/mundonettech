const tokens = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.1408 0.0044 285.8)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.1408 0.0044 285.8)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.1408 0.0044 285.8)",
  primary: "oklch(0.5 0.1193 242.7)",
  primaryForeground: "oklch(1 0 0)",
  secondary: "oklch(0.97 0.0029 264.5)",
  secondaryForeground: "oklch(0.2103 0.0059 285.9)",
  muted: "oklch(0.97 0.0029 264.5)",
  mutedForeground: "oklch(0.45 0.015 264.5)",
  accent: "oklch(0.9514 0.025 236.8)",
  accentForeground: "oklch(0.3912 0.0845 240.9)",
  destructive: "oklch(0.53 0.2 26)",
  destructiveForeground: "oklch(1 0 0)",
  success: "oklch(0.5081 0.1049 165.6)",
  successForeground: "oklch(1 0 0)",
  warning: "oklch(0.49 0.105 68)",
  warningForeground: "oklch(1 0 0)",
  info: "oklch(0.5 0.1193 242.7)",
  infoForeground: "oklch(1 0 0)",
  border: "oklch(0.91 0.006 264.5)",
  input: "oklch(0.56 0.014 264.5)",
  ring: "oklch(0.5876 0.1389 242)",
  brandSurface: "oklch(0.1408 0.0044 285.8)",
  brandSurfaceElevated: "oklch(0.1964 0.0082 274.5)",
  brandSurfaceForeground: "oklch(0.9851 0 0)",
  brandSurfaceMuted: "oklch(0.7118 0.0129 286.1)",
  brandSurfaceBorder: "oklch(0.2739 0.0055 286)",
  brandSurfaceInput: "oklch(0.5517 0.0138 285.9)",
  brandCyan: "oklch(0.6847 0.1479 237.3)",
  brandCyanForeground: "oklch(0.1408 0.0044 285.8)",
  brandCyanMuted: "oklch(0.2935 0.0632 243.2)",
} as const;

const assetColors = {
  background: "#ffffff",
  secondary: "#f4f5f7",
  primary: "#0369a1",
  success: "#047857",
  brandSurface: "#09090b",
  brandSurfaceElevated: "#141519",
  brandSurfaceForeground: "#fafafa",
  brandSurfaceMuted: "#a1a1aa",
  brandSurfaceBorder: "#27272a",
  brandCyan: "#0ea5e9",
  brandCyanForeground: "#09090b",
  brandCyanMuted: "#082f49",
} as const;

const fonts = {
  sans: 'var(--font-sans-local, ui-sans-serif), ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'var(--font-mono-local, ui-monospace), ui-monospace, "Cascadia Code", "Segoe UI Mono", monospace',
} as const;

const toCssVariables = (values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  );

export const themeConfig = {
  name: "Titanium & Electric Sky",
  tokens,
  assetColors,
  fonts,
  cssVariables: {
    ...toCssVariables(tokens),
    "--font-sans": fonts.sans,
    "--font-mono": fonts.mono,
  },
} as const;

export type ThemeConfig = typeof themeConfig;
