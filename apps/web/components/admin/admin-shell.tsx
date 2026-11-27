import { adminNavigation, adminRing, maskEmail, type AdminRoleValue } from "@mundonettech/core";
import type { AdminUser } from "@mundonettech/db";
import Link from "next/link";
import type { ReactNode } from "react";

import { AdminNav } from "@/components/admin/admin-nav";
import { Button } from "@/components/ui/button";
import { signOutAdminAction } from "@/lib/actions/admin-auth";
import { roleLabels } from "@/lib/admin-presenters";

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
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-hidden"
      >
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="min-w-0">
            <Link
              href="/admin"
              prefetch={false}
              className="rounded-sm text-lg font-bold outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
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
        <AdminNav items={adminNavigation(profile.role)} />
      </header>
      <main
        id="admin-content"
        tabIndex={-1}
        className="mx-auto max-w-7xl px-4 py-8 outline-hidden sm:px-6"
      >
        {children}
      </main>
    </div>
  );
}
