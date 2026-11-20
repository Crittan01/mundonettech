import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { CustomerLoginForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Iniciar sesión" };

export default async function CustomerLoginPage() {
  const security = await getAuthPageSecurity();
  return (
    <AuthShell
      title="Inicia sesión"
      description="Recibe un código de un solo uso en tu correo. No necesitas recordar otra contraseña para acceder."
      footer={
        <>
          <Link className="text-primary underline" href="/recuperar">
            Recupera tu contraseña
          </Link>
          <span className="mx-2">·</span>
          <Link className="text-primary underline" href="/registro">
            Crea una cuenta
          </Link>
        </>
      }
    >
      <CustomerLoginForm {...security} />
    </AuthShell>
  );
}
