"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface StoreMobileMenuProps {
  readonly showWholesale: boolean;
}

function StoreMobileMenuInner({
  showWholesale,
  pathname,
}: StoreMobileMenuProps & { readonly pathname: string | null }) {
  const [open, setOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    if (open) {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const links = [
    { href: "/productos", label: "Catálogo completo", description: "Explora todas las categorías" },
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
    },
    { href: "/legal", label: "Legal y privacidad", description: "Ley 1480, retracto y datos" },
  ] as const;

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="store-mobile-drawer"
        aria-label={open ? "Cerrar menú de tienda" : "Abrir menú de tienda"}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-input bg-background px-2.5 text-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {open ? (
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
        ) : (
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
        )}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-x-0 top-16 bottom-0 z-50 flex flex-col bg-brand-surface/70 backdrop-blur-xs lg:hidden"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setOpen(false);
                  triggerRef.current?.focus();
                }
              }}
            >
              <div
                id="store-mobile-drawer"
                className="max-h-full overflow-y-auto border-b border-border bg-background px-4 py-5 shadow-xl"
              >
                <form
                  action="/productos"
                  method="get"
                  role="search"
                  aria-label="Buscar productos en móvil"
                  onSubmit={() => setOpen(false)}
                  className="flex items-center gap-2"
                >
                  <label htmlFor="mobile-store-search" className="sr-only">
                    Buscar en la tienda
                  </label>
                  <input
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
                      const active =
                        pathname === item.href || pathname?.startsWith(`${item.href}/`);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            prefetch={false}
                            aria-current={active ? "page" : undefined}
                            onClick={() => setOpen(false)}
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function ActiveStoreMobileMenu(props: StoreMobileMenuProps) {
  const pathname = usePathname() ?? "/";
  return <StoreMobileMenuInner {...props} pathname={pathname} />;
}

export function StoreMobileMenu(props: StoreMobileMenuProps) {
  return (
    <Suspense fallback={<StoreMobileMenuInner {...props} pathname={null} />}>
      <ActiveStoreMobileMenu {...props} />
    </Suspense>
  );
}
