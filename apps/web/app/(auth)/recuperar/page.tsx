import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordResetForm, RecoveryRequestForm } from "@/components/auth/customer-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Recuperar contraseña" };

export default async function RecoveryPage({ searchParams }: PageProps<"/recuperar">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const email = typeof params.email === "string" ? params.email.slice(0, 320) : "";
  const hasCode = params.code === "1";
  return (
    <AuthShell
      title="Recupera tu contraseña"
      description={
        hasCode
          ? "Usa el código recibido y define una contraseña nueva y segura."
          : "Si tu correo puede recibir recuperación, te enviaremos un código de seis dígitos."
      }
    >
      {hasCode ? (
        <PasswordResetForm {...security} defaultEmail={email} />
      ) : (
        <RecoveryRequestForm {...security} />
      )}
    </AuthShell>
  );
}
