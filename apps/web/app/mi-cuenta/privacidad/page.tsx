import Link from "next/link";

import { AnonymizeAccountForm } from "@/components/account/account-forms";
import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = {
  title: "Privacidad y eliminación de cuenta",
  robots: { index: false, follow: false },
};

export default async function PrivacyPage() {
  const { profile } = await requireCustomerPage();
  const account = await accountService().getProfile(profile.id);
  return (
    <main className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Privacidad y eliminación</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Consulta el historial reciente de consentimientos y ejerce la supresión o anonimización de
          tus datos conforme a la Ley 1581.
        </p>
      </div>
      <section aria-labelledby="consent-history" className="space-y-4">
        <h2 id="consent-history" className="text-2xl font-semibold">
          Consentimientos recientes
        </h2>
        {account.consents.length === 0 ? (
          <p className="text-muted-foreground">No hay eventos de consentimiento para mostrar.</p>
        ) : (
          <ol className="space-y-3">
            {account.consents.map((consent) => (
              <li key={consent.id} className="rounded-xl border border-border bg-card p-4 text-sm">
                <strong>{consent.purpose}</strong> · {consent.status} · {consent.policyVersion}
                <span className="block text-muted-foreground">
                  {consent.occurredAt.toISOString()} · {consent.source}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="text-sm text-muted-foreground">
          Los eventos son append-only para conservar evidencia legal.{" "}
          <Link href="/legal/tratamiento-datos-personales" className="underline">
            Consulta la política de tratamiento de datos
          </Link>
          .
        </p>
      </section>
      <section aria-labelledby="delete-account" className="space-y-4">
        <h2 id="delete-account" className="text-2xl font-semibold">
          Anonimizar cuenta
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Debes usar primero cualquier saldo de crédito o puntos disponibles. Las direcciones y
          preferencias se eliminan; los pedidos conservan solo la información financiera y los
          documentos legalmente exigidos, disociados de tus identificadores personales.
        </p>
        <AnonymizeAccountForm />
      </section>
    </main>
  );
}
