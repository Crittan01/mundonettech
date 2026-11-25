import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { CustomerLoginForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";
import { normalizeInternalNextPath } from "@/lib/security/customer-auth-request";

export const metadata = { title: "Iniciar sesión" };

function reasonMessage(reason: string | undefined): string | null {
  if (reason === "timeout") {
    return "Tu sesión expiró por inactividad. Solicita un código nuevo para continuar.";
  }
  if (reason === "security") {
    return "Inicia sesión para acceder a tu cuenta.";
  }
  if (reason === "anonymized") {
    return "Tu cuenta quedó anonimizada y cerramos tu sesión conforme a la Ley 1581.";
  }
  return null;
}

export default async function CustomerLoginPage({ searchParams }: PageProps<"/ingresar">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const notice = reasonMessage(typeof params.reason === "string" ? params.reason : undefined);
  const next = normalizeInternalNextPath(typeof params.next === "string" ? params.next : undefined);
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
      {notice ? (
        <p
          role="status"
          className="mb-5 rounded-lg border border-border bg-secondary/50 p-3 text-sm text-secondary-foreground"
        >
          {notice}
        </p>
      ) : null}
      <CustomerLoginForm {...security} next={next} />
    </AuthShell>
  );
}
