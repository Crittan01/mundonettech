const tokens = {
  background: "oklch(0.985 0.003 250)",
  foreground: "oklch(0.21 0.028 262)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.21 0.028 262)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.21 0.028 262)",
  primary: "oklch(0.48 0.19 260)",
  primaryForeground: "oklch(0.985 0.003 250)",
  secondary: "oklch(0.95 0.012 250)",
  secondaryForeground: "oklch(0.3 0.035 262)",
  muted: "oklch(0.95 0.012 250)",
  mutedForeground: "oklch(0.49 0.025 262)",
  accent: "oklch(0.91 0.045 210)",
  accentForeground: "oklch(0.29 0.055 240)",
  destructive: "oklch(0.55 0.21 27)",
  destructiveForeground: "oklch(0.985 0.003 250)",
  success: "oklch(0.53 0.15 152)",
  successForeground: "oklch(0.985 0.003 250)",
  warning: "oklch(0.76 0.16 75)",
  warningForeground: "oklch(0.22 0.04 65)",
  info: "oklch(0.54 0.16 235)",
  infoForeground: "oklch(0.985 0.003 250)",
  border: "oklch(0.89 0.014 250)",
  input: "oklch(0.89 0.014 250)",
  ring: "oklch(0.56 0.16 260)",
} as const;

const fonts = {
  sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "Cascadia Code", "Segoe UI Mono", monospace',
} as const;

const toCssVariables = (values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  );

export const themeConfig = {
  name: "Tech Precision",
  tokens,
  fonts,
  cssVariables: {
    ...toCssVariables(tokens),
    "--font-sans": fonts.sans,
    "--font-mono": fonts.mono,
  },
} as const;

export type ThemeConfig = typeof themeConfig;
