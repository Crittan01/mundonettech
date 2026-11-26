import { cn } from "../../lib/utils";

export interface SelectStyleOptions {
  className?: string | undefined;
  compact?: boolean;
  fullWidth?: boolean;
  focusRing?: boolean;
}

export function selectStyles({
  className,
  compact = false,
  fullWidth = true,
  focusRing = true,
}: SelectStyleOptions = {}): string {
  return cn(
    "rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive sm:text-sm",
    compact ? "h-11 sm:h-10" : "h-11",
    fullWidth && "w-full",
    focusRing && "outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
}
