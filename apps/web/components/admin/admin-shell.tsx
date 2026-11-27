import { adminNavigation, adminRing, maskEmail, type AdminRoleValue } from "@mundonettech/core";
import type { AdminUser } from "@mundonettech/db";
import type { ReactNode } from "react";

import { AdminShellClient } from "@/components/admin/admin-nav";
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
  const signOutSlot = (
    <form action={signOutAdminAction}>
      <Button type="submit" variant="outline" size="sm">
        Cerrar sesión
      </Button>
    </form>
  );

  return (
    <>
      <a
        href="#admin-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring focus:outline-hidden"
      >
        Saltar al contenido
      </a>
      <AdminShellClient
        items={adminNavigation(profile.role)}
        maskedEmail={maskEmail(profile.email)}
        roleLabel={roleLabels[profile.role]}
        ring={adminRing(profile.role)}
        signOutSlot={signOutSlot}
      >
        {children}
      </AdminShellClient>
    </>
  );
}
