import { AuthShell } from "@/components/auth/auth-shell";
import { AdminLoginForm } from "@/components/admin/admin-auth-forms";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Acceso administrativo" };

export default async function AdminLoginPage() {
  const security = await getAuthPageSecurity();
  return (
    <AuthShell
      title="Acceso administrativo"
      description="Ingresa con tu cuenta autorizada. Después verificaremos tu autenticador."
    >
      <AdminLoginForm {...security} />
    </AuthShell>
  );
}
