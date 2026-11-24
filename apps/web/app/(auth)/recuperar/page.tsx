import { Suspense } from "react";
import { connection } from "next/server";

import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordResetForm, RecoveryRequestForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";
import { readCustomerAuthRequest } from "@/lib/security/customer-auth-request";

export const metadata = { title: "Recuperar contraseña" };

async function RecoveryContent({ searchParams }: PageProps<"/recuperar">) {
  await connection();
  const [security, params, request] = await Promise.all([
    getAuthPageSecurity(),
    searchParams,
    readCustomerAuthRequest(["recovery"]),
  ]);
  const hasCode = params.code === "1" && request !== null;
  const expiredRequest = params.code === "1" && request === null;
  return (
    <AuthShell
      title="Recupera tu contraseña"
      description={
        hasCode
          ? "Usa el código recibido y define una contraseña nueva y segura."
          : expiredRequest
            ? "La solicitud cifrada venció o no existe. Solicita un código nuevo sin compartir tu correo en el enlace."
            : "Si tu correo puede recibir recuperación, te enviaremos un código de seis dígitos."
      }
    >
      {hasCode ? <PasswordResetForm {...security} /> : <RecoveryRequestForm {...security} />}
    </AuthShell>
  );
}

export default function RecoveryPage(props: PageProps<"/recuperar">) {
  return (
    <Suspense
      fallback={
        <AuthShell
          title="Preparando recuperación"
          description="Estamos validando el estado seguro de tu solicitud."
        >
          <p role="status" className="text-sm text-muted-foreground">
            Cargando recuperación de contraseña…
          </p>
        </AuthShell>
      }
    >
      <RecoveryContent {...props} />
    </Suspense>
  );
}
