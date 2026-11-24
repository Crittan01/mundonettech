import {
  abandonedCartReminderOutcomeLabels,
  formatCopCents,
  loyaltyTxnTypeLabels,
  referralRejectionReasonLabels,
  referralStatusLabels,
} from "@mundonettech/core";

import { EmptyState } from "@/components/admin/empty-state";
import { growthService } from "@/lib/growth";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Fidelización y recuperación" };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormatter = new Intl.NumberFormat("es-CO");
const abandonedStatusLabels = {
  DETECTED: "Detectado",
  RECOVERED: "Recuperado",
  EXPIRED: "Vencido",
} as const;

export default async function GrowthAdminPage() {
  const session = await requireAdminPage("crm:read");
  const overview = await growthService().getAdminOverview(session.profile.id);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Fidelización y recuperación</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Libro de puntos, referidos verificados y recuperación de carritos. Vista protegida por MFA
          y permisos CRM; los correos permanecen enmascarados en el DTO de servidor.
        </p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Puntos vigentes</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(BigInt(overview.totals.points))}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Cuentas con saldo</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(overview.totals.customers)}
          </dd>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <dt className="text-sm text-muted-foreground">Referidos con recompensa vigente</dt>
          <dd className="mt-2 text-2xl font-bold">
            {numberFormatter.format(overview.totals.referrals)}
          </dd>
        </div>
      </dl>
      <section aria-labelledby="admin-ledger" className="space-y-4">
        <h2 id="admin-ledger" className="text-2xl font-semibold">
          Movimientos recientes
        </h2>
        {overview.ledger.length === 0 ? (
          <EmptyState>No hay puntos otorgados o reversados todavía.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[58rem] text-left text-sm">
              <caption className="sr-only">Últimos movimientos del libro de lealtad</caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className="p-3">
                    Fecha
                  </th>
                  <th scope="col" className="p-3">
                    Cliente
                  </th>
                  <th scope="col" className="p-3">
                    Pedido
                  </th>
                  <th scope="col" className="p-3">
                    Movimiento
                  </th>
                  <th scope="col" className="p-3 text-right">
                    Puntos
                  </th>
                  <th scope="col" className="p-3 text-right">
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.ledger.map((entry) => (
                  <tr key={entry.id} className="border-b border-border last:border-0">
                    <td className="p-3">{dateFormatter.format(entry.createdAt)}</td>
                    <td className="p-3">{entry.customerEmail}</td>
                    <td className="p-3">{entry.orderNumber}</td>
                    <td className="p-3">{loyaltyTxnTypeLabels[entry.type]}</td>
                    <td className="p-3 text-right">
                      {entry.points > 0 ? "+" : ""}
                      {entry.points}
                    </td>
                    <td className="p-3 text-right">{entry.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="admin-referrals" className="space-y-4">
        <h2 id="admin-referrals" className="text-2xl font-semibold">
          Referidos verificables
        </h2>
        {overview.referrals.length === 0 ? (
          <EmptyState>No hay atribuciones de referidos registradas.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[58rem] text-left text-sm">
              <caption className="sr-only">
                Atribuciones y recompensas del programa de referidos
              </caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className="p-3">
                    Código
                  </th>
                  <th scope="col" className="p-3">
                    Referidor
                  </th>
                  <th scope="col" className="p-3">
                    Referido
                  </th>
                  <th scope="col" className="p-3">
                    Estado
                  </th>
                  <th scope="col" className="p-3">
                    Pedido
                  </th>
                  <th scope="col" className="p-3">
                    Atribución
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.referrals.map((referral) => (
                  <tr key={referral.id} className="border-b border-border last:border-0">
                    <td className="p-3 font-medium">{referral.code}</td>
                    <td className="p-3">{referral.referrerEmail}</td>
                    <td className="p-3">{referral.referredEmail}</td>
                    <td className="p-3">
                      {referralStatusLabels[referral.status]}
                      {referral.rejectionReason
                        ? ` · ${referralRejectionReasonLabels[referral.rejectionReason]}`
                        : ""}
                    </td>
                    <td className="p-3">{referral.orderNumber ?? "—"}</td>
                    <td className="p-3">{dateFormatter.format(referral.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="admin-abandoned" className="space-y-4">
        <h2 id="admin-abandoned" className="text-2xl font-semibold">
          Carritos y recordatorios
        </h2>
        {overview.abandonedCarts.length === 0 ? (
          <EmptyState>No hay carritos abandonados o recuperados registrados.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[62rem] text-left text-sm">
              <caption className="sr-only">Estado de carritos y recuperación por correo</caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className="p-3">
                    Detectado
                  </th>
                  <th scope="col" className="p-3">
                    Cliente
                  </th>
                  <th scope="col" className="p-3">
                    Carrito
                  </th>
                  <th scope="col" className="p-3">
                    Estado
                  </th>
                  <th scope="col" className="p-3">
                    Último resultado
                  </th>
                  <th scope="col" className="p-3 text-right">
                    Recordatorios
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.abandonedCarts.map((abandoned) => (
                  <tr key={abandoned.id} className="border-b border-border last:border-0">
                    <td className="p-3">{dateFormatter.format(abandoned.detectedAt)}</td>
                    <td className="p-3">{abandoned.customerEmail}</td>
                    <td className="p-3">
                      {abandoned.itemCount} unidades · {formatCopCents(abandoned.totalCents)}
                    </td>
                    <td className="p-3">{abandonedStatusLabels[abandoned.status]}</td>
                    <td className="p-3">
                      {abandoned.lastReminderOutcome
                        ? abandonedCartReminderOutcomeLabels[abandoned.lastReminderOutcome]
                        : "Sin intento"}
                    </td>
                    <td className="p-3 text-right">{abandoned.reminderCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
