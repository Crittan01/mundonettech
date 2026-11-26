import Link from "next/link";

import { AdminLoginForm } from "@/components/admin/admin-auth-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Acceso administrativo" };

function reasonNotice(
  reason: string | undefined,
): { text: string; tone: "status" | "alert" } | null {
  if (reason === "invitation") {
    return {
      text: "Invitación activada. Inicia sesión para configurar tu autenticador TOTP.",
      tone: "status",
    };
  }
  if (reason === "timeout") {
    return {
      text: "Tu sesión se cerró por inactividad. Vuelve a iniciar sesión.",
      tone: "alert",
    };
  }
  if (reason === "security") {
    return {
      text: "Inicia sesión nuevamente para verificar tu acceso administrativo.",
      tone: "alert",
    };
  }
  return null;
}

export default async function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  const [security, params] = await Promise.all([getAuthPageSecurity(), searchParams]);
  const notice = reasonNotice(typeof params.reason === "string" ? params.reason : undefined);
  return (
    <AuthShell
      title="Acceso administrativo"
      description="Ingresa con tu cuenta autorizada. Después verificaremos tu autenticador."
      footer={
        <p>
          ¿Recibiste un código de invitación?{" "}
          <Link
            href="/admin/invitacion"
            className="font-medium text-primary underline underline-offset-4"
          >
            Activa tu invitación
          </Link>
        </p>
      }
    >
      {notice ? (
        <p
          role={notice.tone}
          className="mb-5 rounded-lg border border-border bg-secondary/50 p-3 text-sm text-secondary-foreground"
        >
          {notice.text}
        </p>
      ) : null}
      <AdminLoginForm {...security} />
    </AuthShell>
  );
}
