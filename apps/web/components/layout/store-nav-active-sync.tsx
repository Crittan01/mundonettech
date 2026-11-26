"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

export function StoreNavActiveSync() {
  const pathname = usePathname() ?? "/";

  useEffect(() => {
    const links = document.querySelectorAll<HTMLAnchorElement>("a[data-store-nav]");
    for (const link of links) {
      const href = link.dataset.storeNav ?? "";
      const exact = link.dataset.storeNavExact === "1";
      const active = exact
        ? pathname === href
        : Boolean(href) && (pathname === href || pathname.startsWith(`${href}/`));
      if (active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }, [pathname]);

  return null;
}
