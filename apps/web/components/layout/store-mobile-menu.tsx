"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { BrandWordmark } from "@/components/brand/brand-mark";

interface StoreMobileMenuProps {
  readonly showWholesale: boolean;
}

interface MobileNavEntry {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly matchPrefixes?: readonly string[];
}

const focusableSelector =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

const emptySubscribe = () => () => undefined;

function matchesPath(pathname: string, entry: MobileNavEntry): boolean {
  const check = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (check(entry.href)) return true;
  return entry.matchPrefixes?.some(check) ?? false;
}

export function StoreMobileMenu({ showWholesale }: StoreMobileMenuProps) {
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState("/");
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const closeDrawer = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openDrawer = useCallback(() => {
    setActivePath(window.location.pathname || "/");
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
      }
    }
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    function handleBreakpoint(event: MediaQueryListEvent) {
      if (event.matches) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    mediaQuery.addEventListener("change", handleBreakpoint);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      mediaQuery.removeEventListener("change", handleBreakpoint);
    };
  }, [open, closeDrawer]);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey) {
      if (
        document.activeElement === first ||
        !dialogRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        last.focus();
      }
    } else if (
      document.activeElement === last ||
      !dialogRef.current?.contains(document.activeElement)
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  const links: readonly MobileNavEntry[] = [
    {
      href: "/productos",
      label: "Catálogo completo",
      description: "Explora todas las categorías",
      matchPrefixes: ["/categoria", "/marca", "/producto"],
    },
    { href: "/comparar", label: "Comparar productos", description: "Especificaciones lado a lado" },
    ...(showWholesale
      ? [
          {
            href: "/empresas",
            label: "Empresas y mayoristas",
            description: "Cotizaciones y volumen B2B",
          },
        ]
      : []),
    {
      href: "/ayuda",
      label: "Centro de ayuda",
      description: "Guías de compra, envíos y garantías",
    },
    { href: "/mi-cuenta", label: "Mi cuenta", description: "Pedidos, direcciones y beneficios" },
    {
      href: "/carrito",
      label: "Carrito",
      description: "Revisa tus productos y finaliza tu compra",
      matchPrefixes: ["/checkout"],
    },
    { href: "/legal", label: "Legal y privacidad", description: "Ley 1480, retracto y datos" },
  ];

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? "store-mobile-drawer" : undefined}
        aria-label={open ? "Cerrar menú de tienda" : "Abrir menú de tienda"}
        onClick={() => (open ? closeDrawer(true) : openDrawer())}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-input bg-background px-2.5 text-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </svg>
      </button>

      {open && isClient
        ? createPortal(
            <div className="fixed inset-0 z-50 flex flex-col lg:hidden">
              <div
                ref={dialogRef}
                id="store-mobile-drawer"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onKeyDown={handleDialogKeyDown}
                className="max-h-[90vh] overflow-y-auto border-b border-border bg-background shadow-2xl"
              >
                <div className="flex min-h-16 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                  <div className="min-w-0">
                    <h2 id={titleId} className="sr-only">
                      Menú de navegación de la tienda
                    </h2>
                    <Link
                      href="/"
                      onClick={() => closeDrawer(false)}
                      className="inline-flex rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <BrandWordmark variant="on-light" size={30} />
                      <span className="sr-only">, inicio</span>
                    </Link>
                  </div>
                  <button
                    type="button"
                    aria-label="Cerrar menú de tienda"
                    onClick={() => closeDrawer(true)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-input bg-background text-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>

                <div className="px-4 py-5">
                  <form
                    action="/productos"
                    method="get"
                    role="search"
                    aria-label="Buscar productos en móvil"
                    onSubmit={() => closeDrawer(false)}
                    className="flex items-center gap-2"
                  >
                    <label htmlFor="mobile-store-search" className="sr-only">
                      Buscar en la tienda
                    </label>
                    <input
                      ref={searchInputRef}
                      id="mobile-store-search"
                      type="search"
                      name="q"
                      maxLength={100}
                      placeholder="Buscar en la tienda…"
                      className="flex h-11 min-w-0 flex-1 rounded-lg border border-input bg-card px-3.5 text-base text-foreground outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <button
                      type="submit"
                      className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground outline-hidden hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      Buscar
                    </button>
                  </form>

                  <nav aria-label="Menú móvil de la tienda" className="mt-4">
                    <ul className="divide-y divide-border/70">
                      {links.map((item) => {
                        const active = matchesPath(activePath, item);
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              prefetch={false}
                              aria-current={active ? "page" : undefined}
                              onClick={() => closeDrawer(false)}
                              className={`flex min-h-12 flex-col justify-center rounded-lg px-3 py-2.5 outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                                active
                                  ? "bg-accent text-accent-foreground"
                                  : "text-foreground hover:bg-secondary/70"
                              }`}
                            >
                              <span className="text-sm font-semibold">{item.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {item.description}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </nav>
                </div>
              </div>
              <div
                aria-hidden="true"
                onMouseDown={() => closeDrawer(true)}
                className="flex-1 cursor-pointer bg-brand-surface/70 backdrop-blur-xs"
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
