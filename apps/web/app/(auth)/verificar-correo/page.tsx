import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { OtpVerificationForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";
import { readCustomerAuthRequest } from "@/lib/security/customer-auth-request";

export const metadata = { title: "Verificar correo" };

async function VerifyEmailContent() {
  await connection();
  const [security, request] = await Promise.all([
    getAuthPageSecurity(),
    readCustomerAuthRequest(["signup", "login"]),
  ]);
  if (!request) {
    return (
      <AuthShell
        title="Solicitud de verificación no disponible"
        description="El enlace no contiene datos personales y la solicitud venció o no existe."
      >
        <div className="space-y-4">
          <p role="alert" className="text-sm text-destructive">
            Solicita un código nuevo para continuar de forma segura.
          </p>
          <Link href="/ingresar" className="text-sm font-medium text-primary underline">
            Volver a ingresar
          </Link>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="Verifica tu correo"
      description="Ingresa el código de seis dígitos. La solicitud cifrada expira después de diez minutos."
    >
      <OtpVerificationForm {...security} />
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <AuthShell
          title="Preparando verificación"
          description="Estamos validando el estado seguro de tu solicitud."
        >
          <p role="status" className="text-sm text-muted-foreground">
            Cargando verificación de correo…
          </p>
        </AuthShell>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
