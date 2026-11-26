import { StoreSettingsService } from "@mundonettech/cms";
import { storeConfig } from "@mundonettech/config/store";
import { formatCopCents, hasAdminPermission } from "@mundonettech/core";
import Link from "next/link";

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
  const canReadIntegrations = hasAdminPermission(session.profile.role, "integrations:read");
  const canReadAudit = hasAdminPermission(session.profile.role, "audit:read");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Configuración</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Revisa y actualiza los parámetros operativos, fiscales y logísticos separados del
          contenido editorial. Aquí no se almacenan secretos.
        </p>
        {canReadIntegrations || canReadAudit ? (
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            {canReadIntegrations ? (
              <Link className="text-primary underline" href="/admin/integraciones">
                Ir a integraciones y bóveda
              </Link>
            ) : null}
            {canReadAudit ? (
              <Link className="text-primary underline" href="/admin/auditoria">
                Consultar registros de auditoría
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      {canWrite ? (
        <>
          <CmsStepUp session={session} />
          <StoreSettingsForm settings={settings} />
        </>
      ) : (
        <div className="space-y-4">
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            Vista de solo lectura para tu rol actual.
          </p>
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
              "Recogida en sede": settings.clickAndCollectEnabled ? "Sí" : "No",
              "Entrega local Flex": settings.localDeliveryEnabled ? "Sí" : "No",
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {stored?.updatedBy ? (
        <p className="text-sm break-all text-muted-foreground">
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
