"use client";

import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight * 1.05) return;
    setVisible(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -40px 0px", threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={delay > 0 ? { transitionDelay: `${Math.round(delay * 1000)}ms` } : undefined}
      className={cn("mnt-reveal", visible ? "mnt-reveal-visible" : "mnt-reveal-hidden", className)}
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
