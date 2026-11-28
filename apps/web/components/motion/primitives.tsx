"use client";

import type { MouseEvent, ReactNode } from "react";
import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

export function FadeIn({
  children,
  className,
  delay = 0,
}: Readonly<{
  children: ReactNode;
  className?: string;
  delay?: number;
}>) {
  return (
    <div
      style={delay > 0 ? { animationDelay: `${Math.round(delay * 1000)}ms` } : undefined}
      className={cn("mnt-reveal", className)}
    >
      {children}
    </div>
  );
}

export function SpotlightCard({
  children,
  className,
  dark = false,
}: Readonly<{
  children: ReactNode;
  className?: string;
  dark?: boolean;
}>) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty("--spotlight-x", `${event.clientX - rect.left}px`);
    node.style.setProperty("--spotlight-y", `${event.clientY - rect.top}px`);
  }, []);

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      className={cn(
        "mnt-spotlight relative overflow-hidden",
        dark ? "mnt-spotlight-dark" : "mnt-spotlight-light",
        className,
      )}
    >
      {children}
    </div>
  );
}
