import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission, maskEmail } from "@mundonettech/core";
import { assertAdminActorInTransaction, inInventoryTransaction } from "@mundonettech/db";
import Link from "next/link";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  paymentAttemptStatusLabels,
  paymentProviderLabels,
  paymentTransactionKindLabels,
  paymentTransactionStatusLabels,
  refundReasonLabels,
  refundStatusLabels,
} from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabase } from "@/lib/db";
import { blockedIdentityService } from "@/lib/integrations";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Operación de pagos" };

const codStatusLabels: Record<string, string> = {
  PENDING_COLLECTION: "Pendiente de recaudo",
  DISCREPANCY: "Con discrepancia",
  RECONCILED: "Conciliado",
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

const allowedSectionFilters = [
  "ALL",
  "BANK_TRANSFER",
  "COD",
  "REFUNDS",
  "COMPENSATIONS",
  "VOIDS",
] as const;
type SectionFilter = (typeof allowedSectionFilters)[number];

function labelFor<T extends string>(map: Record<T, string>, value: string): string {
  return (
    (map as Record<string, string | undefined>)[value] ??
    (value === "PROCESSING" ? "En proceso" : value)
  );
}

function paymentsHref(q: string, estado: SectionFilter, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado !== "ALL") params.set("estado", estado);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/pagos?${qs}` : "/admin/pagos";
}

function OrderNumberHeading({
  orderId,
  orderNumber,
  canReadOrders,
  suffix,
}: {
  orderId: string;
  orderNumber: string;
  canReadOrders: boolean;
  suffix?: string;
}) {
  return (
    <h3 className="font-semibold">
      {canReadOrders ? (
        <Link href={`/admin/pedidos/${orderId}`} className="underline">
          {orderNumber}
        </Link>
      ) : (
        orderNumber
      )}
      {suffix ? ` · ${suffix}` : ""}
    </h3>
  );
}

export default async function PaymentsPage({ searchParams }: PageProps<"/admin/pagos">) {
  const session = await requireAdminPage("payments:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  const rawEstado = single(raw.estado) ?? "ALL";
  const estado: SectionFilter = allowedSectionFilters.includes(rawEstado as SectionFilter)
    ? (rawEstado as SectionFilter)
    : "ALL";
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 20;
  const skip = (page - 1) * pageSize;
  const take = pageSize + 1;

  const showBank = estado === "ALL" || estado === "BANK_TRANSFER";
  const showCod = estado === "ALL" || estado === "COD";
  const showRefunds = estado === "ALL" || estado === "REFUNDS";
  const showCompensations = estado === "ALL" || estado === "COMPENSATIONS";
  const showVoids = estado === "ALL" || estado === "VOIDS";

  const db = getDatabase();
  const [rawBank, rawCod, rawRefunds, rawCompensations, rawVoids] = await inInventoryTransaction(
    db,
    async (tx) => {
      await assertAdminActorInTransaction(tx, session.profile.id, "payments:read");
      return Promise.all([
        showBank
          ? tx.paymentAttempt.findMany({
              where: {
                provider: "BANK_TRANSFER",
                status: { in: ["PENDING", "PROCESSING", "REQUIRES_ACTION"] },
                ...(q
                  ? {
                      OR: [
                        { order: { orderNumber: { contains: q, mode: "insensitive" } } },
                        { reference: { contains: q, mode: "insensitive" } },
                      ],
                    }
                  : {}),
              },
              select: {
                id: true,
                amountCents: true,
                reference: true,
                order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
              },
              orderBy: { createdAt: "asc" },
              skip,
              take,
            })
          : [],
        showCod
          ? tx.paymentAttempt.findMany({
              where: {
                provider: "COD",
                status: { in: ["PENDING", "PROCESSING", "REQUIRES_ACTION"] },
                ...(q
                  ? {
                      OR: [
                        { order: { orderNumber: { contains: q, mode: "insensitive" } } },
                        { reference: { contains: q, mode: "insensitive" } },
                      ],
                    }
                  : {}),
              },
              select: {
                id: true,
                amountCents: true,
                order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
                codReconciliation: { select: { status: true } },
              },
              orderBy: { createdAt: "asc" },
              skip,
              take,
            })
          : [],
        showRefunds
          ? tx.orderRefund.findMany({
              where: {
                status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] },
                ...(q ? { order: { orderNumber: { contains: q, mode: "insensitive" } } } : {}),
              },
              select: {
                id: true,
                reason: true,
                status: true,
                totalCents: true,
                order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
              },
              orderBy: { createdAt: "asc" },
              skip,
              take,
            })
          : [],
        showCompensations
          ? tx.paymentTransaction.findMany({
              where: {
                kind: { in: ["REFUND", "VOID"] },
                status: { in: ["PENDING", "PROCESSING"] },
                provider: { not: "STORE_CREDIT" },
                ...(q
                  ? {
                      attempt: {
                        order: { orderNumber: { contains: q, mode: "insensitive" } },
                      },
                    }
                  : {}),
              },
              select: {
                id: true,
                kind: true,
                provider: true,
                amountCents: true,
                status: true,
                attempt: { select: { order: { select: { id: true, orderNumber: true } } } },
              },
              orderBy: { createdAt: "asc" },
              skip,
              take,
            })
          : [],
        showVoids
          ? tx.paymentAttempt.findMany({
              where: {
                status: "SUCCEEDED",
                provider: { not: "STORE_CREDIT" },
                ...(q
                  ? {
                      OR: [
                        { order: { orderNumber: { contains: q, mode: "insensitive" } } },
                        { reference: { contains: q, mode: "insensitive" } },
                      ],
                    }
                  : {}),
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
                order: { select: { id: true, orderNumber: true } },
              },
              orderBy: { createdAt: "desc" },
              skip,
              take,
            })
          : [],
      ]);
    },
  );

  const hasMore =
    rawBank.length > pageSize ||
    rawCod.length > pageSize ||
    rawRefunds.length > pageSize ||
    rawCompensations.length > pageSize ||
    rawVoids.length > pageSize;
  const bankAttempts = rawBank.slice(0, pageSize);
  const codAttempts = rawCod.slice(0, pageSize);
  const refunds = rawRefunds.slice(0, pageSize);
  const compensations = rawCompensations.slice(0, pageSize);
  const successfulAttempts = rawVoids.slice(0, pageSize);

  const blocked = await blockedIdentityService().list(100, session.profile.id);
  const canWrite = hasAdminPermission(session.profile.role, "payments:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const creditOperationKey = `admin-credit:${randomUUID()}`;
  const hasFilters = Boolean(q || estado !== "ALL");

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
      <form
        key={`${q}|${estado}`}
        action="/admin/pagos"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="payments-q" className="sr-only">
          Buscar pagos por pedido o referencia
        </label>
        <Input
          id="payments-q"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder="Número de pedido o referencia"
          className="min-w-60 flex-1"
        />
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar cola operativa"
          fullWidth={false}
        >
          <option value="ALL">Todas las colas</option>
          <option value="BANK_TRANSFER">Transferencias pendientes</option>
          <option value="COD">Remesas COD pendientes</option>
          <option value="REFUNDS">Reembolsos activos</option>
          <option value="COMPENSATIONS">Compensaciones por conciliar</option>
          <option value="VOIDS">Capturas anulables</option>
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/pagos"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      {showBank ? (
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
                      <OrderNumberHeading
                        orderId={attempt.order.id}
                        orderNumber={attempt.order.orderNumber}
                        canReadOrders={canReadOrders}
                      />
                      <p className="mt-1 text-sm text-muted-foreground">
                        {attempt.order.emailSnapshot
                          ? maskEmail(attempt.order.emailSnapshot)
                          : "Sin correo"}
                      </p>
                    </div>
                    <p className="font-semibold">{formatCopCents(attempt.amountCents)}</p>
                  </div>
                  <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                    {attempt.reference}
                  </p>
                  {canWrite ? <BankTransferConfirmationForm paymentAttemptId={attempt.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showCod ? (
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
                      <OrderNumberHeading
                        orderId={attempt.order.id}
                        orderNumber={attempt.order.orderNumber}
                        canReadOrders={canReadOrders}
                      />
                      <p className="mt-1 text-sm text-muted-foreground">
                        {attempt.order.emailSnapshot
                          ? maskEmail(attempt.order.emailSnapshot)
                          : "Sin correo"}{" "}
                        ·{" "}
                        {codStatusLabels[
                          attempt.codReconciliation?.status ?? "PENDING_COLLECTION"
                        ] ??
                          attempt.codReconciliation?.status ??
                          paymentAttemptStatusLabels.PENDING}
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
      ) : null}
      {showRefunds ? (
        <section id="refunds" aria-labelledby="refunds-title" className="space-y-4">
          <h2 id="refunds-title" className="text-xl font-semibold">
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
                      <OrderNumberHeading
                        orderId={refund.order.id}
                        orderNumber={refund.order.orderNumber}
                        canReadOrders={canReadOrders}
                        suffix={labelFor(refundReasonLabels, refund.reason)}
                      />
                      <p className="mt-1 text-sm text-muted-foreground">
                        {refund.order.emailSnapshot
                          ? maskEmail(refund.order.emailSnapshot)
                          : "Sin correo"}{" "}
                        · {labelFor(refundStatusLabels, refund.status)}
                      </p>
                    </div>
                    <p className="font-semibold">{formatCopCents(refund.totalCents)}</p>
                  </div>
                  {canWrite && ["REQUESTED", "APPROVED", "FAILED"].includes(refund.status) ? (
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
      ) : null}
      {showCompensations ? (
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
                  <OrderNumberHeading
                    orderId={transaction.attempt.order.id}
                    orderNumber={transaction.attempt.order.orderNumber}
                    canReadOrders={canReadOrders}
                    suffix={labelFor(paymentTransactionKindLabels, transaction.kind)}
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    {labelFor(paymentProviderLabels, transaction.provider)} ·{" "}
                    {formatCopCents(transaction.amountCents)} ·{" "}
                    {labelFor(paymentTransactionStatusLabels, transaction.status)}
                  </p>
                  {canWrite ? <CompensationForm transactionId={transaction.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showVoids ? (
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
                  <OrderNumberHeading
                    orderId={attempt.order.id}
                    orderNumber={attempt.order.orderNumber}
                    canReadOrders={canReadOrders}
                    suffix={labelFor(paymentProviderLabels, attempt.provider)}
                  />
                  <p className="mt-1 text-sm break-all text-muted-foreground">
                    {formatCopCents(attempt.amountCents)} · {attempt.reference}
                  </p>
                  {canWrite ? <VoidPaymentForm paymentAttemptId={attempt.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {page > 1 || hasMore ? (
        <nav aria-label="Paginación de pagos" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Página {page}</span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={paymentsHref(q, estado, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={paymentsHref(q, estado, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
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
