import { adminNavigation, adminRing, maskEmail, type AdminRoleValue } from "@mundonettech/core";
import type { AdminUser } from "@mundonettech/db";
import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAdminAction } from "@/lib/actions/admin-auth";
import { Button } from "@/components/ui/button";

const roleLabels: Record<AdminRoleValue, string> = {
  SUPERADMIN: "Superadministrador",
  OPERATIONS_MANAGER: "Dirección de operaciones",
  STORE_MANAGER: "Gestión de tienda",
  INVENTORY_BUYER: "Inventario y compras",
  FULFILLMENT: "Alistamiento y despacho",
  CUSTOMER_SUPPORT: "Servicio al cliente",
  FINANCE_ANALYST: "Análisis financiero",
  CMS_EDITOR: "Edición de contenido",
};

export function AdminShell({
  profile,
  children,
}: {
  profile: Omit<AdminUser, "role"> & { role: AdminRoleValue };
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-secondary/30">
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:absolute focus:bg-background focus:p-3"
      >
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/admin" className="text-lg font-bold">
              Administración
            </Link>
            <p className="text-sm text-muted-foreground">
              {maskEmail(profile.email)} · {roleLabels[profile.role]} · Anillo{" "}
              {adminRing(profile.role)}
            </p>
          </div>
          <form action={signOutAdminAction}>
            <Button type="submit" variant="outline" size="sm">
              Cerrar sesión
            </Button>
          </form>
        </div>
        <nav
          aria-label="Navegación administrativa"
          className="mx-auto flex max-w-7xl flex-wrap gap-1 px-4 pb-3"
        >
          {adminNavigation(profile.role).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="admin-content" className="mx-auto max-w-7xl px-6 py-8">
        {children}
      </main>
    </div>
  );
}
