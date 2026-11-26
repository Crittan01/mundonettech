import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { AdminInvitationForm } from "@/components/admin/admin-invitation-form";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Activar invitación administrativa" };

export default async function AdminInvitationPage({
  searchParams,
}: PageProps<"/admin/invitacion">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const email = typeof params.email === "string" ? params.email.slice(0, 320) : "";
  return (
    <AuthShell
      title="Activa tu invitación"
      description="Verifica el código recibido y define una contraseña segura. Después configurarás tu autenticador."
      footer={
        <p>
          ¿Ya activaste tu cuenta?{" "}
          <Link
            href="/admin/login"
            className="font-medium text-primary underline underline-offset-4"
          >
            Ir al acceso administrativo
          </Link>
        </p>
      }
    >
      <AdminInvitationForm {...security} defaultEmail={email} />
    </AuthShell>
  );
}
