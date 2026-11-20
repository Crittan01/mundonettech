import { AuthShell } from "@/components/auth/auth-shell";
import { OtpVerificationForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Verificar correo" };

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verificar-correo">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const mode = params.mode === "signup" ? "signup" : "email";
  const email = typeof params.email === "string" ? params.email.slice(0, 320) : "";
  return (
    <AuthShell
      title="Verifica tu correo"
      description="Ingresa el código de seis dígitos que enviamos. Expira después de diez minutos."
    >
      <OtpVerificationForm {...security} defaultEmail={email} mode={mode} />
    </AuthShell>
  );
}
