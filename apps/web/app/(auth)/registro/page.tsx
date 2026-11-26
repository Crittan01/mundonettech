import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { RegistrationForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";
import { normalizeInternalNextPath } from "@/lib/security/customer-auth-request";

export const metadata = { title: "Crear cuenta" };

export default async function RegisterPage({ searchParams }: PageProps<"/registro">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const next = normalizeInternalNextPath(typeof params.next === "string" ? params.next : undefined);
  return (
    <AuthShell
      title="Crea tu cuenta"
      description="Regístrate con un correo válido. Te enviaremos un código para confirmarla."
      footer={
        <p>
          ¿Ya tienes cuenta?{" "}
          <Link
            className="text-primary underline"
            href={next ? `/ingresar?next=${encodeURIComponent(next)}` : "/ingresar"}
          >
            Inicia sesión
          </Link>
        </p>
      }
    >
      <RegistrationForm {...security} next={next} />
    </AuthShell>
  );
}
