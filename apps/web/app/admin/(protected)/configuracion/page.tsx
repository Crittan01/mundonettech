import { StoreSettingsService } from "@mundonettech/cms";
import { storeConfig } from "@mundonettech/config/store";
import { formatCopCents, hasAdminPermission } from "@mundonettech/core";

import { StoreSettingsForm } from "@/components/admin/cms-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Configuración de tienda" };

const taxRegimeLabels = {
  NO_RESPONSABLE_IVA: "No responsable de IVA",
  RESPONSABLE_IVA: "Responsable de IVA",
} as const;

const bogotaFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export default async function StoreSettingsPage() {
  const session = await requireAdminPage("settings:read");
  const stored = await new StoreSettingsService(getDatabase()).get();
  const settings = {
    taxRegime: stored?.taxRegime ?? storeConfig.tax.regime,
    annualRevenueAlertUvt: stored?.annualRevenueAlertUvt ?? storeConfig.tax.annualRevenueAlertUvt,
    currency: stored?.currency ?? storeConfig.currency,
    timeZone: stored?.timeZone ?? storeConfig.timeZone,
    orderNumberPrefix: stored?.orderNumberPrefix ?? storeConfig.orderNumber.prefix,
    orderNumberPadding: stored?.orderNumberPadding ?? 4,
    uvtValueCents: stored?.uvtValueCents.toString() ?? storeConfig.tax.uvtValueCents,
    uvtYear: stored?.uvtYear ?? storeConfig.tax.uvtYear,
    standardShippingCents:
      stored?.standardShippingCents.toString() ?? storeConfig.checkout.standardShippingCents,
    deliveryPromiseDays: stored?.deliveryPromiseDays ?? storeConfig.checkout.deliveryPromiseDays,
    reservationMinutes: stored?.reservationMinutes ?? storeConfig.checkout.reservationMinutes,
    clickAndCollectEnabled: stored?.clickAndCollectEnabled ?? false,
    localDeliveryEnabled: stored?.localDeliveryEnabled ?? false,
  };
  const canWrite = hasAdminPermission(session.profile.role, "settings:write");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Configuración</h1>
        <p className="mt-2 text-muted-foreground">
          Parámetros operativos, fiscales y logísticos separados del contenido editorial. No se
          almacenan secretos.
        </p>
      </div>
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          <StoreSettingsForm settings={settings} />
        </>
      ) : (
        <dl className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
          {Object.entries({
            "Régimen tributario": taxRegimeLabels[settings.taxRegime],
            "Alerta UVT": String(settings.annualRevenueAlertUvt),
            Moneda: settings.currency,
            "Zona horaria": settings.timeZone,
            "Prefijo de orden": settings.orderNumberPrefix,
            "Dígitos del consecutivo": String(settings.orderNumberPadding),
            "UVT vigente": `${settings.uvtYear} · ${formatCopCents(settings.uvtValueCents)} (${settings.uvtValueCents} centavos)`,
            "Envío estándar": `${formatCopCents(settings.standardShippingCents)} (${settings.standardShippingCents} centavos)`,
            "Promesa de entrega": `${settings.deliveryPromiseDays} días calendario`,
            "Reserva de inventario": `${settings.reservationMinutes} minutos`,
            "Click & Collect": settings.clickAndCollectEnabled ? "Sí" : "No",
            "Entrega Flex": settings.localDeliveryEnabled ? "Sí" : "No",
          }).map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {stored?.updatedBy ? (
        <p className="text-sm text-muted-foreground">
          Última actualización (hora de Colombia): {bogotaFormatter.format(stored.updatedAt)} ·{" "}
          {stored.updatedBy.displayName} ({stored.updatedBy.email})
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Todavía se usan los valores canónicos de configuración.
        </p>
      )}
    </div>
  );
}
