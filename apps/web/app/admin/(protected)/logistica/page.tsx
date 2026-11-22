import {
  formatCopCents,
  hasAdminPermission,
  maskEmail,
  maskName,
  maskPhone,
} from "@mundonettech/core";
import { LocalDeliveryService } from "@mundonettech/db";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import {
  ArchiveDeliveryZoneForm,
  DeliverShipmentForm,
  DeliveryZoneForm,
  DispatchShipmentForm,
  LabelOperationForm,
  PackShipmentForm,
  StartPickingForm,
  type DeliveryZoneView,
} from "@/components/admin/logistics-operations-forms";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación logística" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const statusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  PICKING: "En alistamiento",
  PACKED: "Empaquetado",
  RECONCILING: "Por conciliar",
  LABELLED: "Con guía",
  SHIPPED: "Despachado",
  DELIVERED: "Entregado",
  SEALED: "Sellado",
  READY: "Listo",
  CANCELLED: "Cancelado",
};

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export default async function LogisticsPage() {
  const session = await requireAdminPage("fulfillment:read");
  const db = getDatabase();
  const [shipments, zoneRecords] = await Promise.all([
    db.shipment.findMany({
      where: { status: { notIn: ["DELIVERED", "CANCELLED"] } },
      include: {
        order: { select: { orderNumber: true, emailSnapshot: true, paymentStatus: true } },
        fulfillment: true,
        items: { include: { orderItem: { select: { titleSnapshot: true } } } },
        packages: { orderBy: { packageNumber: "asc" } },
        localDeliveryZone: { select: { code: true } },
      },
      orderBy: [{ promisedAt: "asc" }, { createdAt: "asc" }],
      take: 100,
    }),
    new LocalDeliveryService(db).list(true),
  ]);
  const zones: DeliveryZoneView[] = zoneRecords.map((zone) => ({
    id: zone.id,
    code: zone.code,
    name: zone.name,
    active: zone.active,
    municipalityCodes: zone.municipalityCodes as string[],
    polygon: zone.polygon as { latitudeE6: number; longitudeE6: number }[],
    baseFeeCents: zone.baseFeeCents.toString(),
    freeShippingThresholdCents: zone.freeShippingThresholdCents?.toString() ?? null,
    cutoffMinutes: zone.cutoffMinutes,
    deliveryPromiseMinutes: zone.deliveryPromiseMinutes,
    updatedAt: zone.updatedAt.toISOString(),
  }));
  const canWrite = hasAdminPermission(session.profile.role, "fulfillment:write");
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Operación logística</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Alistamiento, multi-bulto, guías asíncronas y Flex con claims idempotentes, conciliación
          ante resultados inciertos y auditoría con MFA reciente.
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      <section aria-labelledby="fulfillment-queue" className="space-y-4">
        <h2 id="fulfillment-queue" className="text-xl font-semibold">
          Cola de alistamiento y despacho
        </h2>
        {shipments.length === 0 ? (
          <Empty>No hay envíos pendientes de operación.</Empty>
        ) : (
          <ul className="space-y-4">
            {shipments.map((shipment) => (
              <li key={shipment.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">
                      {shipment.order.orderNumber} ·{" "}
                      {shipment.localDeliveryZone?.code ?? shipment.kind}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {shipment.order.emailSnapshot
                        ? maskEmail(shipment.order.emailSnapshot)
                        : "Sin correo"}{" "}
                      · {shipment.order.paymentStatus} ·{" "}
                      {statusLabels[shipment.fulfillment?.status ?? shipment.status] ??
                        shipment.status}
                    </p>
                  </div>
                  <p className="font-semibold">{formatCopCents(shipment.shippingCents)}</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {shipment.items
                    .map((item) => `${item.quantity} × ${item.orderItem.titleSnapshot}`)
                    .join(" · ")}
                </p>
                {shipment.localDriverName ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Conductor: {maskName(shipment.localDriverName)} ·{" "}
                    {shipment.localDriverPhoneE164 ? maskPhone(shipment.localDriverPhoneE164) : ""}
                  </p>
                ) : null}
                {canWrite &&
                (!shipment.fulfillment || shipment.fulfillment.status === "PENDING") ? (
                  <StartPickingForm shipmentId={shipment.id} />
                ) : null}
                {canWrite && shipment.fulfillment?.status === "PICKING" ? (
                  <PackShipmentForm
                    shipmentId={shipment.id}
                    items={shipment.items.map((item) => ({
                      id: item.id,
                      title: item.orderItem.titleSnapshot,
                      quantity: item.quantity,
                    }))}
                  />
                ) : null}
                {shipment.packages.length ? (
                  <ul className="mt-4 space-y-3 border-t border-border pt-4">
                    {shipment.packages.map((record) => (
                      <li key={record.id} className="rounded-lg bg-secondary/40 p-3 text-sm">
                        <div className="flex flex-wrap justify-between gap-2">
                          <span>
                            Bulto {record.packageNumber} · {record.weightGrams} g ·{" "}
                            {formatCopCents(record.declaredValueCents)}
                          </span>
                          <span>{statusLabels[record.status] ?? record.status}</span>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {record.trackingCode ?? "Sin guía"}
                          {record.lastError ? ` · ${record.lastError}` : ""}
                        </p>
                        {record.labelUrl ? (
                          <a
                            href={record.labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block text-primary underline"
                          >
                            Abrir rótulo
                          </a>
                        ) : null}
                        {canWrite &&
                        record.status === "SEALED" &&
                        shipment.fulfillment?.provider === "AVEONLINE" ? (
                          <LabelOperationForm packageId={record.id} />
                        ) : null}
                        {canWrite && record.status === "RECONCILING" ? (
                          <LabelOperationForm packageId={record.id} reconcile />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canWrite && shipment.fulfillment?.status === "LABELLED" ? (
                  <DispatchShipmentForm
                    shipmentId={shipment.id}
                    flex={shipment.fulfillment.provider === "FLEX"}
                  />
                ) : null}
                {canWrite && shipment.fulfillment?.status === "SHIPPED" ? (
                  <DeliverShipmentForm shipmentId={shipment.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="delivery-zones" className="space-y-4">
        <h2 id="delivery-zones" className="text-xl font-semibold">
          Zonas Flex
        </h2>
        {canWrite ? (
          <details className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer font-semibold">
              Crear una zona de entrega local
            </summary>
            <div className="mt-5">
              <DeliveryZoneForm />
            </div>
          </details>
        ) : null}
        {zones.length === 0 ? (
          <Empty>No hay zonas Flex configuradas.</Empty>
        ) : (
          <ul className="space-y-3">
            {zones.map((zone) => (
              <li key={zone.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {zone.code} · {zone.name}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {zone.active ? "Activa" : "Inactiva"} · Actualizada{" "}
                      {dateFormatter.format(new Date(zone.updatedAt))} ·{" "}
                      {formatCopCents(zone.baseFeeCents)} · corte {zone.cutoffMinutes} min
                    </p>
                  </div>
                  {canWrite ? <ArchiveDeliveryZoneForm zone={zone} /> : null}
                </div>
                {canWrite ? (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium">
                      Editar cobertura y tarifa
                    </summary>
                    <div className="mt-4">
                      <DeliveryZoneForm zone={zone} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
