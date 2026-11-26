import {
  canManageDeliveryZones as canManageDeliveryZonesForRole,
  formatCopCents,
  hasAdminPermission,
  maskEmail,
  maskName,
  maskPhone,
} from "@mundonettech/core";
import type { Prisma, ShippingProviderCode } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  orderFulfillmentStatusLabels,
  paymentStatusLabels,
  shipmentPackageStatusLabels,
  shipmentStatusLabels,
  shippingProviderLabels,
} from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación logística" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});

const shipmentKindLabels: Record<string, string> = {
  DELIVERY: "Envío a domicilio",
  CLICK_COLLECT: "Recogida en sede",
};

const packageOperationalLabels: Record<string, string> = {
  SEALED: shipmentPackageStatusLabels.SEALED,
  CLAIMED: shipmentPackageStatusLabels.CLAIMED,
  LABELLED: "Con guía",
  RECONCILING: "Por conciliar",
  RECONCILE_REQUIRED: "Por conciliar",
  SHIPPED: shipmentStatusLabels.SHIPPED,
  DELIVERED: shipmentStatusLabels.DELIVERED,
  CANCELLED: shipmentPackageStatusLabels.CANCELLED,
};

const allowedFulfillmentStates = [
  "PENDING",
  "PICKING",
  "PACKED",
  "RECONCILING",
  "LABELLED",
  "SHIPPED",
  "DELIVERED",
] as const;
type ActiveFulfillmentState = (typeof allowedFulfillmentStates)[number];

const allowedProviders = ["AVEONLINE", "FLEX", "PICKUP"] as const;

function logisticsHref(q: string, estado: string, proveedor: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado) params.set("estado", estado);
  if (proveedor) params.set("proveedor", proveedor);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/logistica?${qs}` : "/admin/logistica";
}

export default async function LogisticsPage({ searchParams }: PageProps<"/admin/logistica">) {
  const session = await requireAdminPage("fulfillment:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  const rawEstado = single(raw.estado) ?? "";
  const estado: ActiveFulfillmentState | "" = (
    allowedFulfillmentStates as readonly string[]
  ).includes(rawEstado)
    ? (rawEstado as ActiveFulfillmentState)
    : "";
  const rawProveedor = single(raw.proveedor) ?? "";
  const proveedor: ShippingProviderCode | "" = (allowedProviders as readonly string[]).includes(
    rawProveedor,
  )
    ? (rawProveedor as ShippingProviderCode)
    : "";
  const rawPage = single(raw.page)?.trim() ?? "";
  const parsedPage = /^[1-9]\d*$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  const requestedPage = Math.max(
    1,
    Math.min(10_000, Number.isSafeInteger(parsedPage) ? parsedPage : 1),
  );
  const pageSize = 20;

  const unfulfilledProviderFilter: Prisma.ShipmentWhereInput =
    proveedor === "PICKUP"
      ? { fulfillment: null, kind: "CLICK_COLLECT" }
      : proveedor === "FLEX"
        ? { fulfillment: null, localDeliveryZoneId: { not: null } }
        : proveedor === "AVEONLINE"
          ? { fulfillment: null, kind: "DELIVERY", localDeliveryZoneId: null }
          : { fulfillment: null };

  const shipmentWhere: Prisma.ShipmentWhereInput = {
    ...(estado === "DELIVERED"
      ? { status: "DELIVERED" }
      : { status: { notIn: ["DELIVERED", "CANCELLED"] } }),
    ...(estado === "PENDING"
      ? {
          OR: [
            unfulfilledProviderFilter,
            {
              fulfillment: {
                status: "PENDING",
                ...(proveedor ? { provider: proveedor } : {}),
              },
            },
          ],
        }
      : estado
        ? {
            fulfillment: {
              status: estado,
              ...(proveedor ? { provider: proveedor } : {}),
            },
          }
        : proveedor
          ? {
              OR: [unfulfilledProviderFilter, { fulfillment: { provider: proveedor } }],
            }
          : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { order: { orderNumber: { contains: q, mode: "insensitive" } } },
                { trackingCode: { contains: q, mode: "insensitive" } },
                { packages: { some: { trackingCode: { contains: q, mode: "insensitive" } } } },
              ],
            },
          ],
        }
      : {}),
    order: {
      orderStatus: { in: ["CONFIRMED", "COMPLETED"] },
      OR: [
        { paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] } },
        {
          paymentStatus: { in: ["UNPAID", "PARTIALLY_PAID"] },
          paymentAttempts: {
            some: { provider: "COD", status: { in: ["PENDING", "REQUIRES_ACTION"] } },
          },
        },
      ],
    },
  };

  const db = getDatabase();
  const [total, zoneRecords] = await Promise.all([
    db.shipment.count({ where: shipmentWhere }),
    db.localDeliveryZone.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        municipalityCodes: true,
        polygon: true,
        baseFeeCents: true,
        freeShippingThresholdCents: true,
        cutoffMinutes: true,
        deliveryPromiseMinutes: true,
        updatedAt: true,
      },
      orderBy: [{ code: "asc" }, { createdAt: "asc" }],
      take: 1000,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const shipments =
    total > 0
      ? await db.shipment.findMany({
          where: shipmentWhere,
          select: {
            id: true,
            kind: true,
            status: true,
            originLocationId: true,
            shippingCents: true,
            localDriverName: true,
            localDriverPhoneE164: true,
            order: {
              select: { id: true, orderNumber: true, emailSnapshot: true, paymentStatus: true },
            },
            fulfillment: { select: { status: true, provider: true } },
            items: {
              select: {
                id: true,
                quantity: true,
                orderItem: {
                  select: {
                    titleSnapshot: true,
                    variantId: true,
                    variant: { select: { product: { select: { trackSerial: true } } } },
                  },
                },
              },
            },
            packages: {
              select: {
                id: true,
                packageNumber: true,
                weightGrams: true,
                declaredValueCents: true,
                status: true,
                trackingCode: true,
                lastError: true,
                labelUrl: true,
              },
              orderBy: { packageNumber: "asc" },
            },
            localDeliveryZone: { select: { code: true } },
          },
          orderBy: [{ promisedAt: "asc" }, { createdAt: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        })
      : [];
  const serialUnits = shipments.length
    ? await db.serializedUnit.findMany({
        where: {
          status: "SOLD",
          orderId: { in: shipments.map((shipment) => shipment.order.id) },
          OR: [
            { shipmentId: null },
            { shipmentId: { in: shipments.map((shipment) => shipment.id) } },
          ],
        },
        select: {
          id: true,
          serial: true,
          imei: true,
          variantId: true,
          locationId: true,
          orderId: true,
          shipmentId: true,
        },
        orderBy: [{ variantId: "asc" }, { serial: "asc" }],
        take: 10_000,
      })
    : [];
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
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const canManageDeliveryZones = canManageDeliveryZonesForRole(session.profile.role);
  const hasFilters = Boolean(q || estado || proveedor);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Operación logística</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Alistamiento, multi-bulto, guías asíncronas y Flex con reclamos idempotentes, conciliación
          ante resultados inciertos y auditoría con MFA reciente.
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      <form
        key={`${q}|${estado}|${proveedor}`}
        action="/admin/logistica"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="logistics-q" className="sr-only">
          Buscar por pedido o guía
        </label>
        <Input
          id="logistics-q"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder="Número de pedido o guía"
          className="min-w-56 flex-1"
        />
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar por etapa logística"
          fullWidth={false}
        >
          <option value="">Activos (no entregados)</option>
          {allowedFulfillmentStates.map((st) => (
            <option key={st} value={st}>
              {orderFulfillmentStatusLabels[st]}
            </option>
          ))}
        </Select>
        <Select
          name="proveedor"
          defaultValue={proveedor}
          aria-label="Filtrar por proveedor"
          fullWidth={false}
        >
          <option value="">Todos los proveedores</option>
          {allowedProviders.map((prov) => (
            <option key={prov} value={prov}>
              {shippingProviderLabels[prov]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/logistica"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      <section aria-labelledby="fulfillment-queue" className="space-y-4">
        <h2 id="fulfillment-queue" className="text-xl font-semibold">
          Cola de alistamiento y despacho
        </h2>
        {shipments.length === 0 ? (
          <Empty>
            {hasFilters
              ? "No hay envíos que coincidan con estos filtros."
              : "No hay envíos pendientes de operación."}
          </Empty>
        ) : (
          <ul className="space-y-4">
            {shipments.map((shipment) => {
              const providerLabel = shipment.fulfillment?.provider
                ? shippingProviderLabels[shipment.fulfillment.provider]
                : null;
              const shipmentStageLabel = shipment.fulfillment
                ? (orderFulfillmentStatusLabels[shipment.fulfillment.status] ??
                  shipment.fulfillment.status)
                : (shipmentStatusLabels[shipment.status] ?? shipment.status);
              return (
                <li key={shipment.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold">
                        {canReadOrders ? (
                          <Link href={`/admin/pedidos/${shipment.order.id}`} className="underline">
                            {shipment.order.orderNumber}
                          </Link>
                        ) : (
                          shipment.order.orderNumber
                        )}{" "}
                        ·{" "}
                        {shipment.localDeliveryZone?.code ??
                          providerLabel ??
                          shipmentKindLabels[shipment.kind] ??
                          shipment.kind}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {shipment.order.emailSnapshot
                          ? maskEmail(shipment.order.emailSnapshot)
                          : "Sin correo"}{" "}
                        ·{" "}
                        {paymentStatusLabels[shipment.order.paymentStatus] ??
                          shipment.order.paymentStatus}{" "}
                        · {shipmentStageLabel}
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
                      Conductor: {maskName(shipment.localDriverName)}
                      {shipment.localDriverPhoneE164
                        ? ` · ${maskPhone(shipment.localDriverPhoneE164)}`
                        : ""}
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
                        <li
                          key={record.id}
                          className="min-w-0 rounded-lg bg-secondary/40 p-3 text-sm"
                        >
                          <div className="flex flex-wrap justify-between gap-2">
                            <span>
                              Bulto {record.packageNumber} · {record.weightGrams} g ·{" "}
                              {formatCopCents(record.declaredValueCents)}
                            </span>
                            <span>{packageOperationalLabels[record.status] ?? record.status}</span>
                          </div>
                          <p className="mt-1 wrap-break-word text-muted-foreground">
                            {record.trackingCode ?? "Sin guía"}
                            {record.lastError ? (
                              <span className="break-all"> · {record.lastError}</span>
                            ) : null}
                          </p>
                          {record.labelUrl ? (
                            <a
                              href={record.labelUrl}
                              target="_blank"
                              rel="noopener noreferrer"
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
                      items={shipment.items.map((item) => ({
                        variantId: item.orderItem.variantId,
                        title: item.orderItem.titleSnapshot,
                        quantity: item.quantity,
                        trackSerial: item.orderItem.variant.product.trackSerial,
                      }))}
                      serialUnits={serialUnits.filter(
                        (unit) =>
                          unit.orderId === shipment.order.id &&
                          unit.locationId === shipment.originLocationId &&
                          (unit.shipmentId === null || unit.shipmentId === shipment.id),
                      )}
                    />
                  ) : null}
                  {canWrite && shipment.fulfillment?.status === "SHIPPED" ? (
                    <DeliverShipmentForm shipmentId={shipment.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {total > 0 ? (
          <nav aria-label="Paginación logística" className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Página {page} de {totalPages} · {total} {total === 1 ? "envío" : "envíos"}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={logisticsHref(q, estado, proveedor, page - 1)}>Anterior</Link>
                </Button>
              ) : null}
              {page < totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={logisticsHref(q, estado, proveedor, page + 1)}>Siguiente</Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
      <section aria-labelledby="delivery-zones" className="space-y-4">
        <h2 id="delivery-zones" className="text-xl font-semibold">
          Zonas Flex
        </h2>
        {!canManageDeliveryZones ? (
          <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            Tu rol puede consultar la cobertura histórica. Crear, editar o archivar zonas requiere
            un rol de gestión logística autorizado.
          </p>
        ) : null}
        {canManageDeliveryZones ? (
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
                  {canManageDeliveryZones ? <ArchiveDeliveryZoneForm zone={zone} /> : null}
                </div>
                {canManageDeliveryZones ? (
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
