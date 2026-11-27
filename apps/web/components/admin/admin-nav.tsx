"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import {
  getAdminNavMetadata,
  groupAdminNavigation,
  isAdminNavItemActive,
  normalizeAdminSearch,
  resolveAdminBreadcrumb,
  type AdminNavItem,
} from "@/components/admin/admin-nav-groups";
import { BrandMark, BrandWordmark } from "@/components/brand/brand-mark";

interface AdminShellClientProps {
  readonly items: readonly AdminNavItem[];
  readonly maskedEmail: string;
  readonly roleLabel: string;
  readonly ring: number;
  readonly signOutSlot: ReactNode;
  readonly children: ReactNode;
}

interface PaletteEntry {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly groupTitle: string;
  readonly description: string;
  readonly searchText: string;
  readonly external?: boolean;
}

function GroupIcon({ groupId }: { readonly groupId: string }) {
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "shrink-0 text-brand-cyan/80",
  };
  switch (groupId) {
    case "operacion":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "comercial":
      return (
        <svg {...props}>
          <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
          <path d="M3 6h18" />
          <path d="M16 10a4 4 0 0 1-8 0" />
        </svg>
      );
    case "pedidos":
      return (
        <svg {...props}>
          <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
          <path d="M15 18H9" />
          <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
          <circle cx="17" cy="18" r="2" />
          <circle cx="7" cy="18" r="2" />
        </svg>
      );
    case "clientes":
      return (
        <svg {...props}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "finanzas":
      return (
        <svg {...props}>
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        </svg>
      );
  }
}

function SidebarNavList({
  items,
  pathname,
  onNavigate,
}: {
  readonly items: readonly AdminNavItem[];
  readonly pathname: string | null;
  readonly onNavigate?: () => void;
}) {
  const groups = useMemo(() => groupAdminNavigation(items), [items]);
  const allHrefs = useMemo(() => items.map((item) => item.href), [items]);

  return (
    <div className="space-y-5 px-3 py-4">
      {groups.map((group) => (
        <div key={group.id} className="space-y-1">
          <div className="flex items-center gap-2 px-2.5 pb-1 text-[11px] font-semibold tracking-wider text-brand-surface-muted uppercase">
            <GroupIcon groupId={group.id} />
            <span>{group.title}</span>
          </div>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname ? isAdminNavItemActive(pathname, item.href, allHrefs) : false;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    className={`flex min-h-10 items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface ${
                      active
                        ? "bg-brand-cyan-muted text-brand-cyan ring-1 ring-brand-cyan/35"
                        : "text-brand-surface-foreground/90 hover:bg-brand-surface-elevated hover:text-brand-surface-foreground"
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-cyan"
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ActiveSidebarNavList({
  items,
  onNavigate,
}: {
  readonly items: readonly AdminNavItem[];
  readonly onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "/admin";
  return (
    <SidebarNavList items={items} pathname={pathname} {...(onNavigate ? { onNavigate } : {})} />
  );
}

function DesktopBreadcrumbView({
  items,
  pathname,
}: {
  readonly items: readonly AdminNavItem[];
  readonly pathname: string | null;
}) {
  const breadcrumb = useMemo(() => resolveAdminBreadcrumb(pathname, items), [pathname, items]);
  return (
    <nav
      aria-label="Ruta actual administrativa"
      className="hidden min-w-0 items-center gap-1.5 text-sm lg:flex"
    >
      <Link
        href="/admin"
        prefetch={false}
        className="rounded-sm font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Administración
      </Link>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      <span className="text-muted-foreground">{breadcrumb.groupTitle}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      <span className="truncate font-semibold text-foreground">{breadcrumb.itemLabel}</span>
      {breadcrumb.subLabel ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <span className="truncate text-muted-foreground">{breadcrumb.subLabel}</span>
        </>
      ) : null}
    </nav>
  );
}

function ActiveDesktopBreadcrumb({ items }: { readonly items: readonly AdminNavItem[] }) {
  const pathname = usePathname() ?? "/admin";
  return <DesktopBreadcrumbView items={items} pathname={pathname} />;
}

function MobileSectionStripView({
  items,
  pathname,
  roleLabel,
}: {
  readonly items: readonly AdminNavItem[];
  readonly pathname: string | null;
  readonly roleLabel: string;
}) {
  const breadcrumb = useMemo(() => resolveAdminBreadcrumb(pathname, items), [pathname, items]);
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/70 bg-secondary/40 px-4 py-1.5 text-xs text-muted-foreground lg:hidden">
      <span className="truncate">
        {breadcrumb.groupTitle} ·{" "}
        <strong className="text-foreground">{breadcrumb.itemLabel}</strong>
      </span>
      <span className="shrink-0 font-mono text-[11px]">{roleLabel}</span>
    </div>
  );
}

function ActiveMobileSectionStrip({
  items,
  roleLabel,
}: {
  readonly items: readonly AdminNavItem[];
  readonly roleLabel: string;
}) {
  const pathname = usePathname() ?? "/admin";
  return <MobileSectionStripView items={items} pathname={pathname} roleLabel={roleLabel} />;
}

function RouteChangeCloser({ onRouteChange }: { readonly onRouteChange: () => void }) {
  const pathname = usePathname() ?? "/admin";
  const previousRef = useRef(pathname);

  useEffect(() => {
    if (previousRef.current !== pathname) {
      previousRef.current = pathname;
      onRouteChange();
    }
  }, [pathname, onRouteChange]);

  return null;
}

function AdminCommandPaletteContent({
  onClose,
  items,
  roleLabel,
  ring,
}: {
  readonly onClose: () => void;
  readonly items: readonly AdminNavItem[];
  readonly roleLabel: string;
  readonly ring: number;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/admin";
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listboxId = useId();

  const allHrefs = useMemo(() => items.map((item) => item.href), [items]);
  const entries = useMemo<readonly PaletteEntry[]>(() => {
    const navEntries: PaletteEntry[] = items.map((item) => {
      const meta = getAdminNavMetadata(item.href);
      return {
        id: item.href,
        href: item.href,
        label: item.label,
        groupTitle: meta.groupTitle,
        description: meta.description,
        searchText: normalizeAdminSearch(
          `${item.label} ${meta.groupTitle} ${meta.description} ${meta.keywords.join(" ")} ${item.href}`,
        ),
      };
    });
    navEntries.push({
      id: "storefront-home",
      href: "/",
      label: "Abrir tienda pública",
      groupTitle: "Acceso rápido",
      description: "Ver el storefront público en una nueva pestaña.",
      searchText: normalizeAdminSearch("tienda publica storefront inicio ver tienda"),
      external: true,
    });
    return navEntries;
  }, [items]);

  const filtered = useMemo(() => {
    const tokens = normalizeAdminSearch(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return entries;
    return entries.filter((entry) => tokens.every((token) => entry.searchText.includes(token)));
  }, [entries, query]);

  const clampedIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function executeEntry(entry: PaletteEntry) {
    setQuery("");
    setActiveIndex(0);
    onClose();
    if (entry.external) {
      window.open(entry.href, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(entry.href);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-brand-surface/75 px-4 pt-16 backdrop-blur-xs sm:pt-24"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <h2 id={titleId} className="sr-only">
            Paleta rápida de módulos administrativos
          </h2>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filtered.length > 0) {
                event.preventDefault();
                setActiveIndex((prev) => (prev + 1) % filtered.length);
              } else if (event.key === "ArrowUp" && filtered.length > 0) {
                event.preventDefault();
                setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
              } else if (event.key === "Enter" && filtered[clampedIndex]) {
                event.preventDefault();
                executeEntry(filtered[clampedIndex]);
              }
            }}
            aria-controls={listboxId}
            aria-label="Buscar módulo administrativo"
            placeholder="Ir a un módulo (ej. pedidos, inventario, finanzas, seguridad)…"
            className="w-full bg-transparent text-base text-foreground outline-hidden placeholder:text-muted-foreground sm:text-sm"
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-9 items-center rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cerrar
          </button>
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label="Módulos autorizados"
          className="max-h-80 overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No hay módulos autorizados que coincidan con «{query}».
            </p>
          ) : (
            filtered.map((entry, index) => {
              const selected = index === clampedIndex;
              const isCurrent =
                !entry.external && isAdminNavItemActive(pathname, entry.href, allHrefs);
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => executeEntry(entry)}
                  className={`flex w-full items-start justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-secondary/70"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <span>{entry.label}</span>
                      {isCurrent ? (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                          Actual
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {entry.groupTitle}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-secondary/50 px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            Filtrado para <strong className="text-foreground">{roleLabel}</strong> · Anillo {ring}
          </span>
          <span className="font-mono">↑↓ · Enter · Esc</span>
        </div>
      </div>
    </div>
  );
}

export function AdminShellClient({
  items,
  maskedEmail,
  roleLabel,
  ring,
  signOutSlot,
  children,
}: AdminShellClientProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileOpen(false);
        setPaletteOpen((current) => !current);
      } else if (event.key === "Escape" && mobileOpen) {
        setMobileOpen(false);
        toggleButtonRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-secondary/35 lg:flex-row">
      <Suspense fallback={null}>
        <RouteChangeCloser
          onRouteChange={() => {
            setMobileOpen(false);
            setPaletteOpen(false);
          }}
        />
      </Suspense>

      {/* Desktop Midnight Cyan Sidebar */}
      <aside className="hidden border-r border-brand-surface-border bg-brand-surface text-brand-surface-foreground lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:flex-col">
        <div className="flex h-16 shrink-0 items-center border-b border-brand-surface-border px-4">
          <Link
            href="/admin"
            prefetch={false}
            className="rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            <BrandWordmark variant="on-dark" size={30} subtitle="Consola operativa" />
          </Link>
        </div>
        <div className="border-b border-brand-surface-border px-3 py-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-brand-surface-input bg-brand-surface-elevated px-3 text-left text-xs font-medium text-brand-surface-muted outline-hidden transition-colors hover:border-brand-cyan hover:text-brand-surface-foreground focus-visible:ring-2 focus-visible:ring-brand-cyan"
          >
            <span className="flex items-center gap-2 truncate">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0 text-brand-cyan"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span>Buscar módulo…</span>
            </span>
            <kbd
              aria-hidden="true"
              className="rounded border border-brand-surface-border bg-brand-surface px-1.5 py-0.5 font-mono text-[10px] text-brand-cyan after:content-['⌘K']"
            />
          </button>
        </div>
        <nav
          aria-label="Navegación administrativa"
          className="flex-1 overflow-y-auto overscroll-contain"
        >
          <Suspense fallback={<SidebarNavList items={items} pathname={null} />}>
            <ActiveSidebarNavList items={items} />
          </Suspense>
        </nav>
        <div className="shrink-0 border-t border-brand-surface-border bg-brand-surface-elevated/60 p-3.5">
          <p className="truncate text-xs font-semibold text-brand-surface-foreground">
            {maskedEmail}
          </p>
          <p className="mt-1 truncate text-[11px] text-brand-surface-muted">{roleLabel}</p>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-brand-surface-muted">
            <span>Anillo {ring}</span>
            <span className="shrink-0 rounded-full bg-brand-cyan-muted px-2 py-0.5 font-mono text-[10px] font-semibold text-brand-cyan">
              MFA aal2
            </span>
          </div>
        </div>
      </aside>

      {/* Main Column — children stays OUTSIDE Suspense */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sticky Topbar (Desktop & Mobile) */}
        <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
          <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/admin"
                prefetch={false}
                className="inline-flex shrink-0 items-center gap-2 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              >
                <BrandMark size={28} variant="on-light" />
                <span className="text-sm font-bold tracking-tight text-foreground">
                  Admin<span className="sr-only"> — inicio</span>
                </span>
              </Link>
              <Suspense fallback={<DesktopBreadcrumbView items={items} pathname={null} />}>
                <ActiveDesktopBreadcrumb items={items} />
              </Suspense>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                ref={paletteTriggerRef}
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-3"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span className="sr-only sm:not-sr-only">Ir a módulo</span>
                <kbd
                  aria-hidden="true"
                  className="hidden rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground after:content-['⌘K'] sm:inline"
                />
              </button>
              <Link
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="hidden min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:inline-flex"
              >
                <span>Ver tienda</span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M15 3h6v6" />
                  <path d="M10 14 21 3" />
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                </svg>
                <span className="sr-only"> (se abre en una nueva pestaña)</span>
              </Link>
              <div className="hidden sm:block">{signOutSlot}</div>
              <button
                ref={toggleButtonRef}
                type="button"
                aria-expanded={mobileOpen}
                aria-controls="admin-mobile-menu"
                onClick={() => setMobileOpen((open) => !open)}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-xs font-semibold text-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
              >
                {mobileOpen ? "Cerrar menú" : "Menú de secciones"}
              </button>
            </div>
          </div>
          <Suspense
            fallback={
              <MobileSectionStripView items={items} pathname={null} roleLabel={roleLabel} />
            }
          >
            <ActiveMobileSectionStrip items={items} roleLabel={roleLabel} />
          </Suspense>
        </header>

        {/* Mobile Dark Midnight Drawer */}
        {mobileOpen ? (
          <div
            className="fixed inset-x-0 top-24 bottom-0 z-40 flex lg:hidden"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setMobileOpen(false);
                toggleButtonRef.current?.focus();
              }
            }}
          >
            <div
              id="admin-mobile-menu"
              className="flex h-full w-72 max-w-[85vw] flex-col border-r border-brand-surface-border bg-brand-surface text-brand-surface-foreground shadow-2xl"
            >
              <div className="border-b border-brand-surface-border px-4 py-3">
                <p className="truncate text-xs font-semibold text-brand-surface-foreground">
                  {maskedEmail}
                </p>
                <p className="mt-1 text-[11px] text-brand-surface-muted">
                  {roleLabel} · Anillo {ring} · MFA aal2
                </p>
              </div>
              <nav
                aria-label="Secciones administrativas móvil"
                className="flex-1 overflow-y-auto overscroll-contain"
              >
                <Suspense
                  fallback={
                    <SidebarNavList
                      items={items}
                      pathname={null}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  }
                >
                  <ActiveSidebarNavList items={items} onNavigate={() => setMobileOpen(false)} />
                </Suspense>
              </nav>
              <div className="flex items-center justify-between gap-2 border-t border-brand-surface-border bg-brand-surface-elevated p-3">
                <Link
                  href="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileOpen(false)}
                  className="inline-flex min-h-10 items-center rounded-md border border-brand-surface-input bg-brand-surface px-3 text-xs font-medium text-brand-surface-foreground outline-hidden hover:border-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan"
                >
                  Ver tienda
                  <span className="sr-only"> (se abre en una nueva pestaña)</span>
                </Link>
                <div>{signOutSlot}</div>
              </div>
            </div>
            <div className="flex-1 bg-brand-surface/65 backdrop-blur-xs" aria-hidden="true" />
          </div>
        ) : null}

        <main
          id="admin-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 outline-hidden sm:px-6 lg:py-8"
        >
          {children}
        </main>
      </div>

      {paletteOpen ? (
        <Suspense fallback={null}>
          <AdminCommandPaletteContent
            onClose={() => {
              setPaletteOpen(false);
              paletteTriggerRef.current?.focus();
            }}
            items={items}
            roleLabel={roleLabel}
            ring={ring}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
