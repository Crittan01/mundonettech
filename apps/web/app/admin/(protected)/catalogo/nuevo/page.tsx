import { CatalogService } from "@mundonettech/db";

import { CatalogProductForm } from "@/components/admin/catalog-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Crear producto" };

export default async function NewCatalogProductPage() {
  const session = await requireAdminPage("catalog:write");
  const references = await new CatalogService(getDatabase()).getReferences();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Crear producto</h1>
        <p className="mt-2 text-muted-foreground">
          Registra el producto y su primera variante. Los cambios exigen MFA reciente y quedan en
          auditoría.
        </p>
      </div>
      <CmsStepUp session={session} />
      <CatalogProductForm references={references} />
    </div>
  );
}
