"use client";

import {
  ExternalLink,
  LayoutGrid,
  Search,
  Shield,
  ShoppingBag,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

const focusableSelector =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

function GroupIcon({ groupId }: { readonly groupId: string }) {
  const iconClass = "size-3.5 shrink-0 text-brand-cyan/85";
  switch (groupId) {
    case "operacion":
      return <LayoutGrid className={iconClass} strokeWidth={2} aria-hidden="true" />;
    case "comercial":
      return <ShoppingBag className={iconClass} strokeWidth={2} aria-hidden="true" />;
    case "pedidos":
      return <Truck className={iconClass} strokeWidth={2} aria-hidden="true" />;
    case "clientes":
      return <Users className={iconClass} strokeWidth={2} aria-hidden="true" />;
    case "finanzas":
      return <TrendingUp className={iconClass} strokeWidth={2} aria-hidden="true" />;
    default:
      return <Shield className={iconClass} strokeWidth={2} aria-hidden="true" />;
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
                    className={`relative flex min-h-10 items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface ${
                      active
                        ? "bg-brand-cyan-muted text-brand-cyan ring-1 ring-brand-cyan/35"
                        : "text-brand-surface-foreground/85 hover:bg-brand-surface-elevated hover:text-brand-surface-foreground"
                    }`}
                  >
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-brand-cyan"
                      />
                    ) : null}
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
    <nav aria-label="Ruta actual administrativa" className="hidden min-w-0 lg:block">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li>
          <Link
            href="/admin"
            prefetch={false}
            className="rounded-sm font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Administración
          </Link>
        </li>
        <li aria-hidden="true" className="text-muted-foreground">
          /
        </li>
        <li className="text-muted-foreground">{breadcrumb.groupTitle}</li>
        <li aria-hidden="true" className="text-muted-foreground">
          /
        </li>
        <li className="min-w-0 truncate">
          {breadcrumb.subLabel && breadcrumb.itemHref ? (
            <Link
              href={breadcrumb.itemHref}
              prefetch={false}
              className="rounded-sm font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {breadcrumb.itemLabel}
            </Link>
          ) : (
            <span aria-current="page" className="font-semibold text-foreground">
              {breadcrumb.itemLabel}
            </span>
          )}
        </li>
        {breadcrumb.subLabel ? (
          <>
            <li aria-hidden="true" className="text-muted-foreground">
              /
            </li>
            <li className="min-w-0 truncate">
              <span aria-current="page" className="font-semibold text-foreground">
                {breadcrumb.subLabel}
              </span>
            </li>
          </>
        ) : null}
      </ol>
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
    <div className="flex h-8 items-center justify-between gap-2 border-t border-border/70 bg-secondary/40 px-4 text-xs text-muted-foreground lg:hidden">
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
  const dialogRef = useRef<HTMLDivElement>(null);
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
  const activeOptionId = filtered.length > 0 ? `${listboxId}-opt-${clampedIndex}` : undefined;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!activeOptionId) return;
    const activeElement = document.getElementById(activeOptionId);
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
          <h2 id={titleId} className="sr-only">
            Paleta rápida de módulos administrativos
          </h2>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-autocomplete="list"
            aria-controls={filtered.length > 0 ? listboxId : undefined}
            aria-activedescendant={activeOptionId}
            aria-label="Buscar módulo administrativo"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filtered.length > 0) {
                event.preventDefault();
                setActiveIndex((clampedIndex + 1) % filtered.length);
              } else if (event.key === "ArrowUp" && filtered.length > 0) {
                event.preventDefault();
                setActiveIndex((clampedIndex - 1 + filtered.length) % filtered.length);
              } else if (event.key === "Enter" && filtered[clampedIndex]) {
                event.preventDefault();
                executeEntry(filtered[clampedIndex]);
              }
            }}
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
        {filtered.length === 0 ? (
          <p
            role="status"
            aria-live="polite"
            className="px-4 py-8 text-center text-sm text-muted-foreground"
          >
            No hay módulos autorizados que coincidan con «{query}».
          </p>
        ) : (
          <div
            id={listboxId}
            role="listbox"
            aria-label="Módulos autorizados"
            className="max-h-80 overflow-y-auto p-2"
          >
            {filtered.map((entry, index) => {
              const selected = index === clampedIndex;
              const isCurrent =
                !entry.external && isAdminNavItemActive(pathname, entry.href, allHrefs);
              return (
                <button
                  key={entry.id}
                  id={`${listboxId}-opt-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
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
            })}
          </div>
        )}
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
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileOpen(false);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    const target = previousFocusRef.current;
    previousFocusRef.current = null;
    if (target && target.isConnected) {
      window.requestAnimationFrame(() => target.focus());
    }
  }, []);

  const closeMobile = useCallback((restoreFocus = false) => {
    setMobileOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => toggleButtonRef.current?.focus());
    }
  }, []);

  const handleRouteChange = useCallback(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
  }, []);

  useEffect(() => {
    if (!mobileOpen && !paletteOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen, paletteOpen]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    function handleBreakpoint(event: MediaQueryListEvent) {
      if (event.matches) {
        setMobileOpen(false);
      }
    }
    mediaQuery.addEventListener("change", handleBreakpoint);
    return () => mediaQuery.removeEventListener("change", handleBreakpoint);
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) {
          closePalette();
        } else {
          openPalette();
        }
      } else if (event.key === "Escape") {
        if (paletteOpen) {
          event.preventDefault();
          closePalette();
        } else if (mobileOpen) {
          event.preventDefault();
          closeMobile(true);
        }
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [mobileOpen, paletteOpen, openPalette, closePalette, closeMobile]);

  return (
    <div className="flex min-h-screen flex-col bg-secondary/75 lg:flex-row">
      <Suspense fallback={null}>
        <RouteChangeCloser onRouteChange={handleRouteChange} />
      </Suspense>

      {/* Desktop Obsidian & Electric Sky Sidebar */}
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
            onClick={openPalette}
            className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border border-brand-surface-input bg-brand-surface-elevated px-3 text-left text-xs font-medium text-brand-surface-muted outline-hidden transition-colors hover:border-brand-cyan hover:text-brand-surface-foreground focus-visible:ring-2 focus-visible:ring-brand-cyan"
          >
            <span className="flex items-center gap-2 truncate">
              <Search
                className="size-3.5 shrink-0 text-brand-cyan"
                strokeWidth={2}
                aria-hidden="true"
              />
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
        <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-md">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
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
                type="button"
                onClick={openPalette}
                className="inline-flex min-h-10 items-center gap-2 rounded-full border border-input bg-secondary/70 px-3 text-xs font-medium text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-3.5"
              >
                <Search className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Ir a módulo</span>
                <kbd
                  aria-hidden="true"
                  className="hidden rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground after:content-['⌘K'] sm:inline"
                />
              </button>
              <Link
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="hidden min-h-10 items-center gap-1.5 rounded-full border border-input bg-card px-3.5 text-xs font-medium text-foreground outline-hidden transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:inline-flex"
              >
                <span>Ver tienda</span>
                <ExternalLink className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span className="sr-only"> (se abre en una nueva pestaña)</span>
              </Link>
              <div className="hidden sm:block">{signOutSlot}</div>
              <button
                ref={toggleButtonRef}
                type="button"
                aria-expanded={mobileOpen}
                aria-controls={mobileOpen ? "admin-mobile-menu" : undefined}
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
          <div className="fixed inset-x-0 top-24 bottom-0 z-40 flex lg:hidden">
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
                      onNavigate={() => closeMobile(false)}
                    />
                  }
                >
                  <ActiveSidebarNavList items={items} onNavigate={() => closeMobile(false)} />
                </Suspense>
              </nav>
              <div className="flex items-center justify-between gap-2 border-t border-brand-surface-border bg-brand-surface-elevated p-3">
                <Link
                  href="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => closeMobile(false)}
                  className="inline-flex min-h-10 items-center rounded-md border border-brand-surface-input bg-brand-surface px-3 text-xs font-medium text-brand-surface-foreground outline-hidden hover:border-brand-cyan focus-visible:ring-2 focus-visible:ring-brand-cyan"
                >
                  Ver tienda
                  <span className="sr-only"> (se abre en una nueva pestaña)</span>
                </Link>
                <div>{signOutSlot}</div>
              </div>
            </div>
            <div
              aria-hidden="true"
              onMouseDown={() => closeMobile(true)}
              className="flex-1 cursor-pointer bg-brand-surface/65 backdrop-blur-xs"
            />
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
            onClose={closePalette}
            items={items}
            roleLabel={roleLabel}
            ring={ring}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
