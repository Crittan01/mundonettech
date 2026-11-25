import { formatCopCents, hasAdminPermission, maskEmail } from "@mundonettech/core";
import { CartNotFoundError, CartService } from "@mundonettech/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  AssistedAddBundleForm,
  AssistedAddVariantForm,
  AssistedCancelForm,
  AssistedClearForm,
  AssistedCouponForm,
  AssistedIssueLinkForm,
  AssistedQuantityForm,
  AssistedRemoveItemForm,
} from "@/components/admin/assisted-sale-forms";
import { CmsStepUp } from "@/components/admin/cms-step-up";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = {
  title: "Detalle de venta asistida",
  robots: { index: false, follow: false },
};
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const statusLabels = {
  ACTIVE: "Expirada",
  CONVERTED: "Convertida",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
} as const;

export default async function AssistedSaleDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/venta-asistida/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const session = await requireAdminPage("sales:read");
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = getDatabase();
  const cart = await new CartService(db).getById(id).catch((error: unknown) => {
    if (error instanceof CartNotFoundError) return null;
    throw error;
  });
  if (!cart || cart.kind !== "ASSISTED") notFound();
  const record = await db.cart.findUnique({
    where: { id },
    select: {
      assistedClaimedAt: true,
      assistedTokenHash: true,
      customer: { select: { email: true } },
    },
  });
  if (!record) notFound();
  const canWrite = hasAdminPermission(session.profile.role, "sales:write");
  const active =
    cart.status === "ACTIVE" && new Date(cart.expiresAt) > new Date() && !record.assistedClaimedAt;
  const manageable = canWrite && active;
  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/venta-asistida" className="text-sm text-primary hover:underline">
          Volver a venta asistida
        </Link>
        <h1 className="mt-3 text-3xl font-bold">
          Venta <span className="font-mono text-xl">{cart.id}</span>
        </h1>
        <p className="mt-2 text-muted-foreground">
          Cliente: {record.customer ? maskEmail(record.customer.email) : "Invitado"} ·{" "}
          {record.assistedClaimedAt
            ? `Aceptada ${dateFormatter.format(record.assistedClaimedAt)}`
            : active
              ? "En preparación"
              : statusLabels[cart.status]}
        </p>
      </div>
      {query.creado === "1" ? (
        <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
          Venta creada. Añade productos, valida el total y emite el enlace cuando esté lista.
        </p>
      ) : null}
      {canWrite ? <CmsStepUp session={session} /> : null}
      <section aria-labelledby="assisted-lines" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="assisted-lines" className="text-2xl font-bold">
            Productos
          </h2>
          {manageable && cart.items.length ? <AssistedClearForm cartId={id} /> : null}
        </div>
        {cart.items.length ? (
          cart.items.map((line, index) => {
            const firstBundle =
              line.bundle &&
              cart.items.findIndex((item) => item.bundle?.id === line.bundle?.id) === index;
            return (
              <article key={line.id} className="rounded-xl border border-border bg-card p-5">
                {firstBundle && line.bundle ? (
                  <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
                    <h3 className="font-semibold">{line.bundle.name}</h3>
                    {manageable ? (
                      <div className="grid grid-cols-2 gap-2">
                        <AssistedQuantityForm
                          cartId={id}
                          itemId={line.id}
                          bundleId={line.bundle.id}
                          quantity={line.bundle.quantity}
                        />
                        <AssistedRemoveItemForm cartId={id} itemId={line.id} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                  <div>
                    <h4 className="font-medium">{line.productName}</h4>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {line.sku} · {line.available} disponibles
                    </p>
                    <p className="mt-2 text-sm">
                      {line.quantity} × {formatCopCents(line.unitPriceCents)}
                    </p>
                    {BigInt(line.wholesaleDiscountCents) > 0n ? (
                      <p className="text-sm text-success">
                        Mayorista: −{formatCopCents(line.wholesaleDiscountCents)}
                      </p>
                    ) : null}
                    {BigInt(line.bundleDiscountCents) > 0n ? (
                      <p className="text-sm text-success">
                        Bundle: −{formatCopCents(line.bundleDiscountCents)}
                      </p>
                    ) : null}
                    {BigInt(line.couponDiscountCents) > 0n ? (
                      <p className="text-sm text-success">
                        Cupón: −{formatCopCents(line.couponDiscountCents)}
                      </p>
                    ) : null}
                  </div>
                  <div className="sm:text-right">
                    <p className="font-bold">{formatCopCents(line.lineTotalCents)}</p>
                    {manageable && !line.bundle ? (
                      <div className="mt-3 grid gap-2">
                        <AssistedQuantityForm
                          cartId={id}
                          itemId={line.id}
                          quantity={line.quantity}
                        />
                        <AssistedRemoveItemForm cartId={id} itemId={line.id} />
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <p className="rounded-xl border border-border bg-card p-6 text-muted-foreground">
            La venta está vacía. Añade una variante o bundle antes de emitir el enlace.
          </p>
        )}
      </section>
      {manageable ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 font-semibold">Añadir variante</h2>
            <AssistedAddVariantForm cartId={id} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 font-semibold">Añadir bundle</h2>
            <AssistedAddBundleForm cartId={id} />
          </section>
        </div>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[340px_1fr]">
        <aside className="space-y-4 rounded-xl border border-border bg-card p-5">
          <h2 className="text-xl font-bold">Resumen</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatCopCents(cart.subtotalCents)}</dd>
            </div>
            {BigInt(cart.wholesaleDiscountCents) > 0n ? (
              <div className="flex justify-between text-success">
                <dt>Mayorista</dt>
                <dd>−{formatCopCents(cart.wholesaleDiscountCents)}</dd>
              </div>
            ) : null}
            {BigInt(cart.bundleDiscountCents) > 0n ? (
              <div className="flex justify-between text-success">
                <dt>Bundles</dt>
                <dd>−{formatCopCents(cart.bundleDiscountCents)}</dd>
              </div>
            ) : null}
            {BigInt(cart.couponDiscountCents) > 0n ? (
              <div className="flex justify-between text-success">
                <dt>Cupón</dt>
                <dd>−{formatCopCents(cart.couponDiscountCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-3 text-lg font-bold">
              <dt>Total</dt>
              <dd>{formatCopCents(cart.totalCents)}</dd>
            </div>
          </dl>
          {manageable ? (
            <AssistedCouponForm cartId={id} code={cart.coupon?.code ?? null} />
          ) : cart.coupon ? (
            <p className="text-sm">
              Cupón: <span className="font-mono">{cart.coupon.code}</span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Vigencia: {dateFormatter.format(new Date(cart.assistedExpiresAt ?? cart.expiresAt))} ·
            Última validación: {dateFormatter.format(new Date(cart.revalidatedAt))}
          </p>
        </aside>
        <div className="space-y-4">
          {manageable ? (
            <>
              <AssistedIssueLinkForm cartId={id} hasLink={record.assistedTokenHash !== null} />
              {!cart.canContinue ? (
                <p role="alert" className="rounded-xl border border-warning bg-card p-4 text-sm">
                  Resuelve las alertas de stock, productos o bundles antes de emitir. El servicio
                  volverá a validarlas de forma transaccional.
                </p>
              ) : null}
              <AssistedCancelForm cartId={id} />
            </>
          ) : (
            <section className="rounded-xl border border-border bg-card p-5">
              <h2 className="font-semibold">Gestión bloqueada</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {!canWrite
                  ? "Tu rol tiene acceso de solo lectura."
                  : record.assistedClaimedAt
                    ? "El cliente ya aceptó esta venta; el enlace quedó invalidado."
                    : "La venta no está activa o ya expiró."}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
