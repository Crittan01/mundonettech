"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

interface PendingCounters {
  pageViews: number;
  productViews: number;
  cartAdditions: number;
  checkoutStarts: number;
}

const emptyCounters = (): PendingCounters => ({
  pageViews: 0,
  productViews: 0,
  cartAdditions: 0,
  checkoutStarts: 0,
});

export function FunnelMetrics() {
  const pathname = usePathname();
  const previousPath = useRef<string | null>(null);
  const counters = useRef<PendingCounters>(emptyCounters());

  useEffect(() => {
    function flush() {
      const pending = counters.current;
      if (Object.values(pending).every((value) => value === 0)) return;
      const body = JSON.stringify(pending);
      counters.current = emptyCounters();
      void fetch("/api/metrics/funnel", {
        method: "POST",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body,
      }).catch(() => undefined);
    }
    const interval = window.setInterval(flush, 15_000);
    function visibility() {
      if (document.visibilityState === "hidden") flush();
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
      flush();
    };
  }, []);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    counters.current.pageViews += 1;
    if (pathname.startsWith("/producto/")) counters.current.productViews += 1;
    if (pathname === "/checkout") counters.current.checkoutStarts += 1;
  }, [pathname]);

  useEffect(() => {
    function added() {
      counters.current.cartAdditions += 1;
    }
    window.addEventListener("store:cart-add", added);
    return () => window.removeEventListener("store:cart-add", added);
  }, []);

  return null;
}
