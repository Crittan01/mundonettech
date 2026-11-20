import { maskEmail } from "@mundonettech/core";

import { Button } from "@/components/ui/button";
import { signOutCustomerAction } from "@/lib/actions/customer-auth";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mi cuenta" };

export default async function AccountPage() {
  const { profile } = await requireCustomerPage();
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Mi cuenta</h1>
        <p className="text-muted-foreground">
          Tu sesión y datos se consultaron de forma segura en el servidor.
        </p>
      </div>
      <dl className="mt-8 grid gap-4 rounded-xl border border-border bg-card p-6 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Correo</dt>
          <dd className="mt-1 font-medium">{maskEmail(profile.email)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Estado</dt>
          <dd className="mt-1 font-medium">Activa</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Puntos disponibles</dt>
          <dd className="mt-1 font-medium">{profile.loyaltyPoints}</dd>
        </div>
      </dl>
      <form action={signOutCustomerAction} className="mt-8">
        <Button type="submit" variant="outline">
          Cerrar sesión
        </Button>
      </form>
    </main>
  );
}
