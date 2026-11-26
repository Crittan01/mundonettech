"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

function isNavItemActive(pathname: string, href: string, allHrefs: readonly string[]): boolean {
  if (pathname === href) return true;
  if (href === "/admin") return false;
  if (!pathname.startsWith(`${href}/`)) return false;
  return !allHrefs.some(
    (other) =>
      other !== href &&
      other.length > href.length &&
      (pathname === other || pathname.startsWith(`${other}/`)),
  );
}

function AdminNavContent({
  items,
  pathname,
}: {
  items: readonly AdminNavItem[];
  pathname: string | null;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);

  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    if (mobileOpen) {
      setMobileOpen(false);
    }
  }

  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileOpen(false);
        toggleButtonRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const allHrefs = items.map((item) => item.href);
  const activeItem = pathname
    ? items.find((item) => isNavItemActive(pathname, item.href, allHrefs))
    : undefined;

  return (
    <nav aria-label="Navegación administrativa" className="mx-auto max-w-7xl px-4 pb-3 sm:px-6">
      <div className="flex items-center justify-between gap-3 md:hidden">
        <span className="truncate text-sm font-medium text-muted-foreground">
          Sección: <strong className="text-foreground">{activeItem?.label ?? "Panel"}</strong>
        </span>
        <button
          ref={toggleButtonRef}
          type="button"
          aria-expanded={mobileOpen}
          aria-controls="admin-mobile-menu"
          onClick={() => setMobileOpen((open) => !open)}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {mobileOpen ? "Cerrar menú" : "Menú de secciones"}
        </button>
      </div>
      <div
        id="admin-mobile-menu"
        className={`${mobileOpen ? "mt-3 grid grid-cols-2 gap-1.5" : "hidden"} md:mt-0 md:flex md:flex-wrap md:gap-1`}
      >
        {items.map((item) => {
          const active = pathname ? isNavItemActive(pathname, item.href, allHrefs) : false;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
              className={`inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:min-h-9 ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function ActiveAdminNav({ items }: { items: readonly AdminNavItem[] }) {
  const pathname = usePathname() ?? "/admin";
  return <AdminNavContent items={items} pathname={pathname} />;
}

export function AdminNav({ items }: { items: readonly AdminNavItem[] }) {
  return (
    <Suspense fallback={<AdminNavContent items={items} pathname={null} />}>
      <ActiveAdminNav items={items} />
    </Suspense>
  );
}
