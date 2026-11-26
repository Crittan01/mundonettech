import { describe, expect, it } from "vitest";

import { selectStyles } from "../../apps/web/components/ui/select-styles.js";

describe("Select primitive", () => {
  it("preserves the default h-11 full-width field, disabled state and focus ring", () => {
    expect(selectStyles({ className: "disabled:opacity-50" })).toBe(
      "rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive sm:text-sm h-11 w-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
    );
  });

  it("preserves the compact mobile-safe h-11 sm:h-10 variant with composable flex and padding", () => {
    expect(selectStyles({ compact: true, className: "flex py-2" })).toBe(
      "rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive sm:text-sm h-11 sm:h-10 w-full outline-none focus-visible:ring-2 focus-visible:ring-ring flex py-2",
    );
  });

  it("preserves intrinsic width and the existing ring-only focus treatment", () => {
    expect(selectStyles({ fullWidth: false })).toBe(
      "rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive sm:text-sm h-11 outline-none focus-visible:ring-2 focus-visible:ring-ring",
    );
  });

  it("keeps the catalog variant without outline or ring utilities", () => {
    expect(selectStyles({ focusRing: false })).toBe(
      "rounded-md border border-input bg-background px-3 text-base text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive sm:text-sm h-11 w-full",
    );
  });
});
