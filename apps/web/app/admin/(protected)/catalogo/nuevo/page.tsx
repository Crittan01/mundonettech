import { CatalogService } from "@mundonettech/db";

import { CatalogProductForm } from "@/components/admin/catalog-forms";
import { StepUpPrompt } from "@/components/admin/security-manager";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Crear producto" };

export default async function NewCatalogProductPage() {
  const session = await requireAdminPage("catalog:write");
  const db = getDatabase();
  const [references, now, factors] = await Promise.all([
    new CatalogService(db).getReferences(),
    getDatabaseClock(db),
    session.supabase.auth.mfa.listFactors(),
  ]);
  const verifiedFactor = factors.data?.totp.find((factor) => factor.status === "verified");
  const recentMfa = session.lastMfaAt && now.getTime() - session.lastMfaAt.getTime() <= 600_000;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Crear producto</h1>
        <p className="mt-2 text-muted-foreground">
          Registra el producto y su primera variante. Los cambios exigen MFA reciente y quedan en
          auditoría.
        </p>
      </div>
      {!recentMfa && verifiedFactor ? <StepUpPrompt factorId={verifiedFactor.id} /> : null}
      <CatalogProductForm references={references} />
    </div>
  );
}
