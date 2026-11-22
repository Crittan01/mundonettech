import { AddressForm, type DaneDepartmentOption } from "@/components/account/account-forms";
import { accountService } from "@/lib/account";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { DeleteAddressForm } from "@/components/account/account-forms";

export const metadata = { title: "Mis direcciones", robots: { index: false, follow: false } };

export default async function AddressesPage() {
  const { profile } = await requireCustomerPage();
  const service = accountService();
  const [account, directory] = await Promise.all([
    service.getProfile(profile.id),
    service.getDaneDirectory(),
  ]);
  const departments: DaneDepartmentOption[] = directory.map((department) => ({
    code: department.code,
    name: department.name,
    municipalities: department.municipalities.map((municipality) => ({
      code: municipality.code,
      name: municipality.name,
    })),
  }));
  return (
    <main className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Direcciones</h1>
        <p className="mt-2 text-muted-foreground">
          Guarda hasta veinte direcciones con municipios validados por DANE. La primera será la
          predeterminada.
        </p>
      </div>
      <section aria-labelledby="saved-addresses" className="space-y-4">
        <h2 id="saved-addresses" className="text-2xl font-semibold">
          Direcciones guardadas
        </h2>
        {account.addresses.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-muted-foreground">
            Todavía no tienes direcciones guardadas.
          </p>
        ) : (
          account.addresses.map((address) => (
            <details key={address.id} className="rounded-xl border border-border bg-card p-5">
              <summary className="cursor-pointer font-semibold">
                {address.label} {address.isDefault ? "· Predeterminada" : ""}
              </summary>
              <p className="mt-3 text-sm text-muted-foreground">
                {address.recipientName} · {address.addressLine1}, {address.municipality.name},{" "}
                {address.municipality.department.name}
              </p>
              <div className="mt-5">
                <AddressForm
                  departments={departments}
                  initial={{
                    id: address.id,
                    updatedAt: address.updatedAt.toISOString(),
                    label: address.label,
                    recipientName: address.recipientName,
                    phoneE164: address.phoneE164,
                    departmentCode: address.departmentCode,
                    municipalityCode: address.municipalityCode,
                    addressLine1: address.addressLine1,
                    addressLine2: address.addressLine2 ?? "",
                    neighborhood: address.neighborhood ?? "",
                    postalCode: address.postalCode ?? "",
                    deliveryNotes: address.deliveryNotes ?? "",
                    isDefault: address.isDefault,
                  }}
                />
              </div>
              <div className="mt-3">
                <DeleteAddressForm addressId={address.id} />
              </div>
            </details>
          ))
        )}
      </section>
      <section aria-labelledby="new-address" className="space-y-4">
        <h2 id="new-address" className="text-2xl font-semibold">
          Nueva dirección
        </h2>
        <AddressForm
          departments={departments}
          initial={{
            recipientName: `${account.givenName ?? ""} ${account.familyName ?? ""}`.trim(),
            phoneE164: account.phoneE164 ?? "",
          }}
        />
      </section>
    </main>
  );
}
