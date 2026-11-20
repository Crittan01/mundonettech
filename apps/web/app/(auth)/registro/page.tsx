import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { RegistrationForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Crear cuenta" };

export default async function RegisterPage() {
  const security = await getAuthPageSecurity();
  return (
    <AuthShell
      title="Crea tu cuenta"
      description="Regístrate con un correo válido. Te enviaremos un código para confirmarla."
      footer={
        <p>
          ¿Ya tienes cuenta?{" "}
          <Link className="text-primary underline" href="/ingresar">
            Inicia sesión
          </Link>
        </p>
      }
    >
      <RegistrationForm {...security} />
    </AuthShell>
  );
}
