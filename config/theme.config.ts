const tokens = {
  background: "oklch(0.985 0.004 225)",
  foreground: "oklch(0.18 0.03 248)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.18 0.03 248)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.18 0.03 248)",
  primary: "oklch(0.45 0.082 222)",
  primaryForeground: "oklch(0.985 0.004 225)",
  secondary: "oklch(0.945 0.012 225)",
  secondaryForeground: "oklch(0.24 0.038 242)",
  muted: "oklch(0.95 0.01 225)",
  mutedForeground: "oklch(0.45 0.028 242)",
  accent: "oklch(0.92 0.034 206)",
  accentForeground: "oklch(0.24 0.044 226)",
  destructive: "oklch(0.53 0.2 26)",
  destructiveForeground: "oklch(0.985 0.004 225)",
  success: "oklch(0.46 0.11 155)",
  successForeground: "oklch(0.985 0.004 225)",
  warning: "oklch(0.49 0.105 68)",
  warningForeground: "oklch(0.985 0.004 225)",
  info: "oklch(0.47 0.095 232)",
  infoForeground: "oklch(0.985 0.004 225)",
  border: "oklch(0.89 0.014 228)",
  input: "oklch(0.58 0.022 235)",
  ring: "oklch(0.52 0.092 222)",
  brandSurface: "oklch(0.175 0.034 252)",
  brandSurfaceElevated: "oklch(0.225 0.038 250)",
  brandSurfaceForeground: "oklch(0.965 0.008 220)",
  brandSurfaceMuted: "oklch(0.76 0.024 228)",
  brandSurfaceBorder: "oklch(0.32 0.042 246)",
  brandSurfaceInput: "oklch(0.56 0.032 232)",
  brandCyan: "oklch(0.83 0.13 200)",
  brandCyanForeground: "oklch(0.16 0.034 252)",
  brandCyanMuted: "oklch(0.265 0.045 224)",
} as const;

const assetColors = {
  background: "#f7fbfc",
  primary: "#045f76",
  brandSurface: "#05111f",
  brandSurfaceElevated: "#0d1d2d",
  brandSurfaceForeground: "#eef5f7",
  brandSurfaceMuted: "#a2b4bd",
  brandSurfaceBorder: "#203547",
  brandCyan: "#3ae0e8",
  brandCyanForeground: "#030e1b",
  brandCyanMuted: "#052a35",
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
  name: "Midnight Cyan",
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
