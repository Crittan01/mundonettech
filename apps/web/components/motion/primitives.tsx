"use client";

import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import * as m from "motion/react-m";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

export function MotionProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

export function FadeIn({
  children,
  className,
  delay = 0,
  y = 14,
}: Readonly<{
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}>) {
  return (
    <m.div
      initial={{ y }}
      whileInView={{ y: 0 }}
      viewport={{ once: true, amount: "some" }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </m.div>
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
