import {
  formatCopCents,
  loyaltyTxnTypeLabels,
  referralRejectionReasonLabels,
  referralStatusLabels,
} from "@mundonettech/core";
import { z } from "zod";

import { AttributeReferralForm, CreateReferralCodeForm } from "@/components/account/growth-forms";
import { growthService } from "@/lib/growth";
import { getPublicSiteUrl } from "@/lib/integrations";
import { requireCustomerPage } from "@/lib/security/customer-auth";
import { readReferralCode } from "@/lib/security/referral";

export const metadata = { title: "Puntos y referidos", robots: { index: false, follow: false } };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
  timeStyle: "short",
});
const codeSchema = z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/i);

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function BenefitsPage({ searchParams }: PageProps<"/mi-cuenta/beneficios">) {
  const { profile } = await requireCustomerPage();
  const raw = await searchParams;
  const parsedCode = codeSchema.safeParse(single(raw.codigo).trim());
  const overview = await growthService().getAccountOverview(profile.id);
  const cookieCode = parsedCode.success ? null : await readReferralCode();
  const initialCode = parsedCode.success ? parsedCode.data.toUpperCase() : (cookieCode ?? "");
  const shareUrl = overview.referralCode
    ? `${getPublicSiteUrl()}/referido/${encodeURIComponent(overview.referralCode)}`
    : null;
  return (
    <main className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Puntos y referidos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Consulta movimientos confirmados y comparte tu código. Las recompensas se otorgan solo
          sobre compras pagadas elegibles y se reversan proporcionalmente con reembolsos y
          anulaciones.
        </p>
      </div>
      {!parsedCode.success && single(raw.codigo) ? (
        <p role="alert" className="rounded-xl border border-destructive bg-card p-4 text-sm">
          El enlace de referido no contiene un código válido. Puedes ingresarlo manualmente.
        </p>
      ) : null}
      <section aria-labelledby="balance-title" className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 id="balance-title" className="text-sm text-muted-foreground">
            Puntos disponibles
          </h2>
          <p className="mt-2 text-3xl font-bold">{overview.loyaltyPoints}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Acumulación</h2>
          <p className="mt-2 font-medium">
            1 punto por cada {formatCopCents(overview.earnUnitCents)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Neto de descuentos, sin IVA ni flete.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm text-muted-foreground">Bono por referido</h2>
          <p className="mt-2 font-medium">{overview.referralPoints} puntos para cada parte</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Primera compra pagada que alcance el mínimo de acumulación.
          </p>
        </div>
      </section>
      <section aria-labelledby="share-title" className="space-y-4">
        <h2 id="share-title" className="text-2xl font-semibold">
          Tu código de referidos
        </h2>
        {overview.referralCode && shareUrl ? (
          <div className="space-y-3 rounded-xl border border-border bg-card p-5">
            <p className="text-2xl font-bold tracking-wider">{overview.referralCode}</p>
            <div className="space-y-2">
              <label htmlFor="share-url" className="text-sm font-medium">
                Enlace para compartir
              </label>
              <input
                id="share-url"
                readOnly
                value={shareUrl}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              Aún no has generado tu código. La creación es única y quedará asociada a tu cuenta.
            </p>
            <CreateReferralCodeForm />
          </div>
        )}
      </section>
      <section aria-labelledby="received-title" className="space-y-4">
        <h2 id="received-title" className="text-2xl font-semibold">
          ¿Te refirieron?
        </h2>
        {overview.referralReceived ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm">
            Estado de tu atribución: {referralStatusLabels[overview.referralReceived.status]}
            {overview.referralReceived.rejectionReason
              ? ` · ${referralRejectionReasonLabels[overview.referralReceived.rejectionReason]}`
              : ""}
            {overview.referralReceived.orderNumber
              ? ` · Pedido ${overview.referralReceived.orderNumber}`
              : ""}
            .
          </p>
        ) : (
          <AttributeReferralForm initialCode={initialCode} />
        )}
      </section>
      <section aria-labelledby="made-title" className="space-y-4">
        <h2 id="made-title" className="text-2xl font-semibold">
          Referidos compartidos
        </h2>
        {overview.referralsMade.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Todavía no hay cuentas con tu código atribuido.
          </p>
        ) : (
          <ul className="space-y-3">
            {overview.referralsMade.map((referral) => (
              <li key={referral.id} className="rounded-xl border border-border bg-card p-4 text-sm">
                <strong>{referralStatusLabels[referral.status]}</strong>
                <span className="ml-2 text-muted-foreground">
                  {dateFormatter.format(referral.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="ledger-title" className="space-y-4">
        <h2 id="ledger-title" className="text-2xl font-semibold">
          Movimientos de puntos
        </h2>
        {overview.ledger.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
            Aún no tienes movimientos. Los puntos aparecerán cuando se confirme el pago completo de
            una compra elegible.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <caption className="sr-only">Historial de puntos y reversas</caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className="p-4">
                    Fecha
                  </th>
                  <th scope="col" className="p-4">
                    Movimiento
                  </th>
                  <th scope="col" className="p-4">
                    Pedido
                  </th>
                  <th scope="col" className="p-4 text-right">
                    Puntos
                  </th>
                  <th scope="col" className="p-4 text-right">
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.ledger.map((entry) => (
                  <tr key={entry.id} className="border-b border-border last:border-0">
                    <td className="p-4">{dateFormatter.format(entry.createdAt)}</td>
                    <td className="p-4">{loyaltyTxnTypeLabels[entry.type]}</td>
                    <td className="p-4">{entry.orderNumber ?? "—"}</td>
                    <td className="p-4 text-right font-medium">
                      {entry.points > 0 ? "+" : ""}
                      {entry.points}
                    </td>
                    <td className="p-4 text-right">{entry.balanceAfter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
