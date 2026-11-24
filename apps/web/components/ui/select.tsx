import type { ComponentProps } from "react";

import { selectStyles, type SelectStyleOptions } from "./select-styles";

export function Select({
  className,
  compact = false,
  fullWidth = true,
  focusRing = true,
  ...props
}: ComponentProps<"select"> & SelectStyleOptions) {
  return (
    <select className={selectStyles({ className, compact, fullWidth, focusRing })} {...props} />
  );
}
