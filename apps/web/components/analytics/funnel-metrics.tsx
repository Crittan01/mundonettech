"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

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
  const timer = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
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
    })
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  }, []);

  const scheduleFlush = useCallback(() => {
    const pending = counters.current;
    const total =
      pending.pageViews + pending.productViews + pending.cartAdditions + pending.checkoutStarts;
    if (
      pending.pageViews >= 1_000 ||
      pending.productViews >= 1_000 ||
      pending.cartAdditions >= 1_000 ||
      pending.checkoutStarts >= 1_000 ||
      total >= 2_000
    ) {
      flushPending();
      return;
    }
    if (timer.current !== null) return;
    timer.current = window.setTimeout(flushPending, 2_000);
  }, [flushPending]);

  useEffect(() => {
    function visibility() {
      if (document.visibilityState === "hidden") flushPending();
    }
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      document.removeEventListener("visibilitychange", visibility);
      flushPending();
    };
  }, [flushPending]);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    counters.current.pageViews += 1;
    if (pathname.startsWith("/producto/")) counters.current.productViews += 1;
    if (pathname === "/checkout") counters.current.checkoutStarts += 1;
    scheduleFlush();
  }, [pathname, scheduleFlush]);

  useEffect(() => {
    function added() {
      counters.current.cartAdditions += 1;
      scheduleFlush();
    }
    window.addEventListener("store:cart-add", added);
    return () => window.removeEventListener("store:cart-add", added);
  }, [scheduleFlush]);

  return null;
}
