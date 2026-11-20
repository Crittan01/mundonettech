import { redirect } from "next/navigation";

import { AdminMfaForm } from "@/components/admin/admin-auth-forms";
import { AuthShell } from "@/components/auth/auth-shell";
import { AdminAuthorizationError, getAdminSession } from "@/lib/security/admin-auth";
import { getAuthPageSecurity } from "@/lib/security/auth-page";

export const metadata = { title: "Verificación administrativa" };

async function sessionOrRedirect() {
  try {
    return await getAdminSession({ requireAal2: false });
  } catch (error) {
    if (error instanceof AdminAuthorizationError) redirect("/admin/login?reason=security");
    throw error;
  }
}

export default async function AdminMfaPage() {
  const session = await sessionOrRedirect();
  const [security, factors] = await Promise.all([
    getAuthPageSecurity(),
    session.supabase.auth.mfa.listFactors(),
  ]);
  if (factors.error) throw new Error("Unable to list MFA factors.");
  const verified = factors.data.totp.find((factor) => factor.status === "verified");
  const canUseRecoveryCode = Boolean(verified) || session.profile.mfaEnrolledAt !== null;
  return (
    <AuthShell
      title="Verifica tu identidad"
      description="El panel exige un segundo factor válido y una sesión reciente."
    >
      <AdminMfaForm
        {...security}
        verifiedFactorId={verified?.id ?? null}
        canUseRecoveryCode={canUseRecoveryCode}
      />
    </AuthShell>
  );
}
