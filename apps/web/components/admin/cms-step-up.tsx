import { StepUpPrompt } from "@/components/admin/security-manager";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import type { AdminSession } from "@/lib/security/admin-auth";

export async function CmsStepUp({ session }: { session: AdminSession }) {
  const [now, factors] = await Promise.all([
    getDatabaseClock(getDatabase()),
    session.supabase.auth.mfa.listFactors(),
  ]);
  const factor = factors.data?.totp.find((item) => item.status === "verified");
  const recent = session.lastMfaAt && now.getTime() - session.lastMfaAt.getTime() <= 600_000;
  return !recent && factor ? <StepUpPrompt factorId={factor.id} /> : null;
}
