import Link from "next/link";

import { signOutCustomerAction } from "@/lib/actions/customer-auth";
import { Button } from "@/components/ui/button";

const links = [
  ["/mi-cuenta", "Perfil"],
  ["/mi-cuenta/direcciones", "Direcciones"],
  ["/mi-cuenta/pedidos", "Pedidos y posventa"],
  ["/mi-cuenta/soporte", "PQR"],
  ["/mi-cuenta/privacidad", "Privacidad"],
] as const;

export function AccountNav() {
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border pb-5 text-sm">
      <nav aria-label="Mi cuenta" className="flex flex-wrap gap-x-5 gap-y-3">
        {links.map(([href, label]) => (
          <Link key={href} href={href} className="font-medium underline-offset-4 hover:underline">
            {label}
          </Link>
        ))}
      </nav>
      <form action={signOutCustomerAction} className="ml-auto">
        <Button type="submit" variant="ghost" size="sm">
          Cerrar sesión
        </Button>
      </form>
    </div>
  );
}
