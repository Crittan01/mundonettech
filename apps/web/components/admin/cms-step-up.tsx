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
  if (!factor) return null;
  const mfaAge = session.lastMfaAt ? now.getTime() - session.lastMfaAt.getTime() : null;
  const recent = mfaAge !== null && mfaAge >= -30_000 && mfaAge <= 600_000;
  const initialRemainingMs =
    recent && mfaAge !== null ? Math.max(0, 600_000 - Math.max(0, mfaAge)) : 0;
  return (
    <StepUpPrompt
      factorId={factor.id}
      initialRemainingMs={initialRemainingMs}
      checkedAtMs={now.getTime()}
    />
  );
}
