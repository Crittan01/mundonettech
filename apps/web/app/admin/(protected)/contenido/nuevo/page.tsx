import Link from "next/link";

import { CmsPageForm } from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Crear página editorial" };

export default async function NewCmsPage() {
  const session = await requireAdminPage("content:write");
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/contenido" className="text-sm text-primary underline underline-offset-4">
          Volver al contenido
        </Link>
        <h1 className="mt-3 text-3xl font-bold">Crear página</h1>
        <p className="mt-2 text-muted-foreground">
          Define metadatos y el primer bloque. Todo contenido inicia como borrador versionado.
        </p>
      </div>
      <CmsStepUp session={session} />
      <CmsPageForm />
    </div>
  );
}
