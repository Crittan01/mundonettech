import Link from "next/link";

import { ProfileForm } from "@/components/account/account-forms";
import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";

export const metadata = { title: "Mi cuenta", robots: { index: false, follow: false } };

export default async function AccountPage() {
  const { profile } = await requireCustomerPage();
  const account = await accountService().getProfile(profile.id);
  const marketingEmail = account.marketingEmailGranted;
  const advertising = account.advertisingGranted;
  return (
    <main className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Mi cuenta</h1>
        <p className="mt-2 text-muted-foreground">
          Administra tus datos personales y tus autorizaciones comerciales y publicitarias.
        </p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Correo verificado</dt>
          <dd className="mt-2 font-medium break-all">{account.email}</dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Pedidos</dt>
          <dd className="mt-2 font-medium">
            <Link href="/mi-cuenta/pedidos" className="underline-offset-4 hover:underline">
              Consultar historial y posventa →
            </Link>
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Puntos disponibles</dt>
          <dd className="mt-2 font-medium">
            <Link href="/mi-cuenta/beneficios" className="underline-offset-4 hover:underline">
              {account.loyaltyPoints} · Ver beneficios →
            </Link>
          </dd>
        </div>
      </dl>
      <section aria-labelledby="profile-title" className="space-y-4">
        <h2 id="profile-title" className="text-2xl font-semibold">
          Perfil y tratamiento de datos
        </h2>
        <ProfileForm
          initial={{
            updatedAt: account.updatedAt.toISOString(),
            givenName: account.givenName ?? "",
            familyName: account.familyName ?? "",
            phoneE164: account.phoneE164 ?? "",
            marketingEmail,
            advertising,
          }}
        />
      </section>
    </main>
  );
}
