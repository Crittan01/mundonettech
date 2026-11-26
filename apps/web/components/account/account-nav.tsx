"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { useFormStatus } from "react-dom";

import { signOutCustomerAction } from "@/lib/actions/customer-auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [
  ["/mi-cuenta", "Perfil"],
  ["/mi-cuenta/direcciones", "Direcciones"],
  ["/mi-cuenta/pedidos", "Pedidos y posventa"],
  ["/mi-cuenta/beneficios", "Puntos y referidos"],
  ["/mi-cuenta/soporte", "PQR"],
  ["/mi-cuenta/privacidad", "Privacidad"],
] as const;

function SignOutSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-busy={pending}>
      {pending ? "Cerrando sesión…" : "Cerrar sesión"}
    </Button>
  );
}

function AccountNavContent({ pathname }: { pathname: string | null }) {
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border pb-5 text-sm">
      <nav aria-label="Mi cuenta" className="flex flex-wrap items-center gap-1.5">
        {links.map(([href, label]) => {
          const active = pathname
            ? href === "/mi-cuenta"
              ? pathname === "/mi-cuenta"
              : pathname === href || pathname.startsWith(`${href}/`)
            : false;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "bg-secondary font-semibold text-foreground"
                  : "font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <form action={signOutCustomerAction} className="ml-auto">
        <SignOutSubmitButton />
      </form>
    </div>
  );
}

function ActiveAccountNav() {
  const pathname = usePathname();
  return <AccountNavContent pathname={pathname} />;
}

export function AccountNav() {
  return (
    <Suspense fallback={<AccountNavContent pathname={null} />}>
      <ActiveAccountNav />
    </Suspense>
  );
}
