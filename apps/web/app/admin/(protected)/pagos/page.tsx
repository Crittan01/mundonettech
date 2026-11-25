import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission, maskEmail } from "@mundonettech/core";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import {
  BankTransferConfirmationForm,
  BlockIdentityForm,
  CodRemittanceForm,
  CompensationForm,
  RefundExecutionForm,
  StoreCreditAdjustmentForm,
  UnblockIdentityForm,
  VoidPaymentForm,
} from "@/components/admin/payment-operations-forms";
import { getDatabase } from "@/lib/db";
import { blockedIdentityService } from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación de pagos" };

const providerLabels = {
  WOMPI: "Wompi",
  COD: "Contraentrega",
  BANK_TRANSFER: "Transferencia",
  STORE_CREDIT: "Crédito",
} as const;

const statusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  PROCESSING: "En proceso",
  REQUIRES_ACTION: "Requiere acción",
  SUCCEEDED: "Exitoso",
  FAILED: "Fallido",
  REQUESTED: "Solicitado",
  APPROVED: "Aprobado",
  PENDING_COLLECTION: "Pendiente de recaudo",
  DISCREPANCY: "Con discrepancia",
  PARTIALLY_REFUNDED: "Reembolso parcial",
};
const refundReasonLabels: Record<string, string> = {
  CUSTOMER_SUPPORT: "Servicio al cliente",
  RETRACT: "Retracto",
  WARRANTY: "Garantía",
  ADJUSTMENT: "Ajuste comercial",
};
const identityKindLabels: Record<string, string> = {
  EMAIL: "Correo",
  PHONE: "Teléfono",
  DOCUMENT: "Documento",
};
const bogotaDateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "medium",
});

export default async function PaymentsPage() {
  const session = await requireAdminPage("payments:read");
  const db = getDatabase();
  const [bankAttempts, codAttempts, refunds, compensations, successfulAttempts, blocked] =
    await Promise.all([
      db.paymentAttempt.findMany({
        where: { provider: "BANK_TRANSFER", status: { in: ["PENDING", "PROCESSING"] } },
        select: {
          id: true,
          amountCents: true,
          reference: true,
          order: { select: { orderNumber: true, emailSnapshot: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      db.paymentAttempt.findMany({
        where: { provider: "COD", status: { in: ["PENDING", "PROCESSING"] } },
        select: {
          id: true,
          amountCents: true,
          order: { select: { orderNumber: true, emailSnapshot: true } },
          codReconciliation: { select: { status: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      db.orderRefund.findMany({
        where: { status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] } },
        select: {
          id: true,
          reason: true,
          status: true,
          totalCents: true,
          order: { select: { orderNumber: true, emailSnapshot: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      db.paymentTransaction.findMany({
        where: { kind: { in: ["REFUND", "VOID"] }, status: { in: ["PENDING", "PROCESSING"] } },
        select: {
          id: true,
          kind: true,
          provider: true,
          amountCents: true,
          status: true,
          attempt: { select: { order: { select: { orderNumber: true } } } },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      db.paymentAttempt.findMany({
        where: {
          status: "SUCCEEDED",
          provider: { not: "STORE_CREDIT" },
          AND: [
            {
              transactions: {
                none: {
                  kind: "REFUND",
                  status: { not: "CANCELLED" },
                },
              },
            },
            {
              transactions: {
                none: {
                  kind: "VOID",
                  status: { in: ["PENDING", "PROCESSING", "SUCCEEDED"] },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          provider: true,
          reference: true,
          amountCents: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      blockedIdentityService().list(100),
    ]);
  const canWrite = hasAdminPermission(session.profile.role, "payments:write");
  const creditOperationKey = `admin-credit:${randomUUID()}`;
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Operación de pagos</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Confirmaciones, conciliaciones y compensaciones con dinero entero en centavos COP,
          trazabilidad transaccional y MFA reciente. Ninguna acción manual acredita fondos sin
          referencia verificable.
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
      <section aria-labelledby="bank-transfers" className="space-y-4">
        <h2 id="bank-transfers" className="text-xl font-semibold">
          Transferencias por confirmar
        </h2>
        {bankAttempts.length === 0 ? (
          <Empty>No hay transferencias pendientes.</Empty>
        ) : (
          <ul className="space-y-3">
            {bankAttempts.map((attempt) => (
              <li key={attempt.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{attempt.order.orderNumber}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {attempt.order.emailSnapshot
                        ? maskEmail(attempt.order.emailSnapshot)
                        : "Sin correo"}
                    </p>
                  </div>
                  <p className="font-semibold">{formatCopCents(attempt.amountCents)}</p>
                </div>
                <p className="mt-2 font-mono text-xs text-muted-foreground">{attempt.reference}</p>
                {canWrite ? <BankTransferConfirmationForm paymentAttemptId={attempt.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="cod-remittances" className="space-y-4">
        <h2 id="cod-remittances" className="text-xl font-semibold">
          Recaudo y remesas COD
        </h2>
        {codAttempts.length === 0 ? (
          <Empty>No hay pagos contraentrega pendientes de conciliación.</Empty>
        ) : (
          <ul className="space-y-3">
            {codAttempts.map((attempt) => (
              <li key={attempt.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{attempt.order.orderNumber}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {attempt.order.emailSnapshot
                        ? maskEmail(attempt.order.emailSnapshot)
                        : "Sin correo"}{" "}
                      ·{" "}
                      {statusLabels[attempt.codReconciliation?.status ?? "PENDING_COLLECTION"] ??
                        attempt.codReconciliation?.status}
                    </p>
                  </div>
                  <p className="font-semibold">{formatCopCents(attempt.amountCents)}</p>
                </div>
                {canWrite && attempt.codReconciliation ? (
                  <CodRemittanceForm
                    paymentAttemptId={attempt.id}
                    expectedCents={attempt.amountCents.toString()}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="refunds" className="space-y-4">
        <h2 id="refunds" className="text-xl font-semibold">
          Reembolsos
        </h2>
        {refunds.length === 0 ? (
          <Empty>No hay reembolsos por ejecutar o conciliar.</Empty>
        ) : (
          <ul className="space-y-3">
            {refunds.map((refund) => (
              <li key={refund.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {refund.order.orderNumber} ·{" "}
                      {refundReasonLabels[refund.reason] ?? refund.reason}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {refund.order.emailSnapshot
                        ? maskEmail(refund.order.emailSnapshot)
                        : "Sin correo"}{" "}
                      · {statusLabels[refund.status] ?? refund.status}
                    </p>
                  </div>
                  <p className="font-semibold">{formatCopCents(refund.totalCents)}</p>
                </div>
                {canWrite && refund.status !== "COMPLETED" ? (
                  <RefundExecutionForm
                    refundId={refund.id}
                    requiresApproval={refund.status === "REQUESTED"}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="compensations" className="space-y-4">
        <h2 id="compensations" className="text-xl font-semibold">
          Compensaciones por conciliar
        </h2>
        {compensations.length === 0 ? (
          <Empty>No hay reembolsos o anulaciones con resultado pendiente.</Empty>
        ) : (
          <ul className="space-y-3">
            {compensations.map((transaction) => (
              <li key={transaction.id} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">
                  {transaction.attempt.order.orderNumber} ·{" "}
                  {transaction.kind === "REFUND" ? "Reembolso" : "Anulación"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {providerLabels[transaction.provider]} · {formatCopCents(transaction.amountCents)}{" "}
                  · {statusLabels[transaction.status] ?? transaction.status}
                </p>
                {canWrite ? <CompensationForm transactionId={transaction.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="voids" className="space-y-4">
        <h2 id="voids" className="text-xl font-semibold">
          Anulaciones de pagos
        </h2>
        {successfulAttempts.length === 0 ? (
          <Empty>No hay capturas disponibles para anular.</Empty>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {successfulAttempts.map((attempt) => (
              <li key={attempt.id} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">
                  {attempt.order.orderNumber} · {providerLabels[attempt.provider]}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatCopCents(attempt.amountCents)} · {attempt.reference}
                </p>
                {canWrite ? <VoidPaymentForm paymentAttemptId={attempt.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {canWrite ? (
        <section
          aria-labelledby="credit-adjustment"
          className="space-y-4 rounded-xl border border-border bg-card p-5"
        >
          <div>
            <h2 id="credit-adjustment" className="text-xl font-semibold">
              Ajuste de crédito de tienda
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Abonos y retiros con libro consecutivo, locks por cliente e idempotencia persistente.
            </p>
          </div>
          <StoreCreditAdjustmentForm operationKey={creditOperationKey} />
        </section>
      ) : null}
      <section aria-labelledby="blocked-identities" className="space-y-4">
        <h2 id="blocked-identities" className="text-xl font-semibold">
          Identidades bloqueadas para COD
        </h2>
        {canWrite ? (
          <div className="rounded-xl border border-border bg-card p-5">
            <BlockIdentityForm />
          </div>
        ) : null}
        {blocked.length === 0 ? (
          <Empty>No hay identidades bloqueadas.</Empty>
        ) : (
          <ul className="space-y-3">
            {blocked.map((identity) => (
              <li key={identity.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {identityKindLabels[identity.kind] ?? identity.kind} ·{" "}
                      {identity.active ? "Bloqueo activo" : "Bloqueo histórico"}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">{identity.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {identity.expiresAt
                        ? `Expira ${bogotaDateFormatter.format(identity.expiresAt)}`
                        : "Sin expiración"}{" "}
                      · El hash no se muestra.
                    </p>
                  </div>
                  {canWrite && identity.active ? (
                    <UnblockIdentityForm blockedIdentityId={identity.id} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
