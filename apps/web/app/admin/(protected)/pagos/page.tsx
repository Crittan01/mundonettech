import { randomUUID } from "node:crypto";

import { formatCopCents, hasAdminPermission, maskEmail, maskIdentifier } from "@mundonettech/core";
import {
  assertAdminActorInTransaction,
  inInventoryTransaction,
  type Prisma,
} from "@mundonettech/db";
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
const numberFormatter = new Intl.NumberFormat("es-CO");

const allowedSectionFilters = [
  "ALL",
  "BANK_TRANSFER",
  "COD",
  "REFUNDS",
  "COMPENSATIONS",
  "VOIDS",
] as const;
type SectionFilter = (typeof allowedSectionFilters)[number];

const allowedBlockedFilters = ["ALL", "ACTIVE"] as const;
type BlockedFilter = (typeof allowedBlockedFilters)[number];

function parsePositivePage(value: string | undefined, maxPage = 10_000): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return maxPage;
  return Math.max(1, Math.min(maxPage, parsed));
}

function labelFor<T extends string>(map: Record<T, string>, value: string): string {
  return (
    (map as Record<string, string | undefined>)[value] ??
    (value === "PROCESSING" ? "En proceso" : value)
  );
}

function paymentsHref(options: {
  q: string;
  estado: SectionFilter;
  page: number;
  bloqueosEstado: BlockedFilter;
  bloqueosPagina: number;
}): string {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.estado !== "ALL") params.set("estado", options.estado);
  if (options.page > 1) params.set("page", String(options.page));
  if (options.bloqueosEstado !== "ALL") params.set("bloqueosEstado", options.bloqueosEstado);
  if (options.bloqueosPagina > 1) params.set("bloqueosPagina", String(options.bloqueosPagina));
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
  const requestedPage = parsePositivePage(single(raw.page));
  const rawBlockedFilter = single(raw.bloqueosEstado) ?? "ALL";
  const bloqueosEstado: BlockedFilter = allowedBlockedFilters.includes(
    rawBlockedFilter as BlockedFilter,
  )
    ? (rawBlockedFilter as BlockedFilter)
    : "ALL";
  const requestedBlockedPage = parsePositivePage(single(raw.bloqueosPagina));
  const pageSize = 20;

  const showBank = estado === "ALL" || estado === "BANK_TRANSFER";
  const showCod = estado === "ALL" || estado === "COD";
  const showRefunds = estado === "ALL" || estado === "REFUNDS";
  const showCompensations = estado === "ALL" || estado === "COMPENSATIONS";
  const showVoids = estado === "ALL" || estado === "VOIDS";

  const bankWhere: Prisma.PaymentAttemptWhereInput = {
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
  };
  const codWhere: Prisma.PaymentAttemptWhereInput = {
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
  };
  const refundsWhere: Prisma.OrderRefundWhereInput = {
    status: { in: ["REQUESTED", "APPROVED", "PROCESSING", "FAILED"] },
    ...(q ? { order: { orderNumber: { contains: q, mode: "insensitive" } } } : {}),
  };
  const compensationsWhere: Prisma.PaymentTransactionWhereInput = {
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
  };
  const voidsWhere: Prisma.PaymentAttemptWhereInput = {
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
  };

  const db = getDatabase();
  const [queueData, blockedPage] = await Promise.all([
    inInventoryTransaction(db, async (tx) => {
      await assertAdminActorInTransaction(tx, session.profile.id, "payments:read");
      const [bankTotal, codTotal, refundsTotal, compensationsTotal, voidsTotal] = await Promise.all(
        [
          showBank ? tx.paymentAttempt.count({ where: bankWhere }) : Promise.resolve(0),
          showCod ? tx.paymentAttempt.count({ where: codWhere }) : Promise.resolve(0),
          showRefunds ? tx.orderRefund.count({ where: refundsWhere }) : Promise.resolve(0),
          showCompensations
            ? tx.paymentTransaction.count({ where: compensationsWhere })
            : Promise.resolve(0),
          showVoids ? tx.paymentAttempt.count({ where: voidsWhere }) : Promise.resolve(0),
        ],
      );
      const maxQueueTotal = Math.max(
        bankTotal,
        codTotal,
        refundsTotal,
        compensationsTotal,
        voidsTotal,
      );
      const totalPages = Math.max(1, Math.ceil(maxQueueTotal / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const skip = (page - 1) * pageSize;
      const [bankAttempts, codAttempts, refunds, compensations, successfulAttempts] =
        await Promise.all([
          showBank && bankTotal > 0
            ? tx.paymentAttempt.findMany({
                where: bankWhere,
                select: {
                  id: true,
                  amountCents: true,
                  reference: true,
                  order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                skip,
                take: pageSize,
              })
            : Promise.resolve([]),
          showCod && codTotal > 0
            ? tx.paymentAttempt.findMany({
                where: codWhere,
                select: {
                  id: true,
                  amountCents: true,
                  order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
                  codReconciliation: { select: { status: true } },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                skip,
                take: pageSize,
              })
            : Promise.resolve([]),
          showRefunds && refundsTotal > 0
            ? tx.orderRefund.findMany({
                where: refundsWhere,
                select: {
                  id: true,
                  reason: true,
                  status: true,
                  totalCents: true,
                  order: { select: { id: true, orderNumber: true, emailSnapshot: true } },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                skip,
                take: pageSize,
              })
            : Promise.resolve([]),
          showCompensations && compensationsTotal > 0
            ? tx.paymentTransaction.findMany({
                where: compensationsWhere,
                select: {
                  id: true,
                  kind: true,
                  provider: true,
                  amountCents: true,
                  status: true,
                  attempt: { select: { order: { select: { id: true, orderNumber: true } } } },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                skip,
                take: pageSize,
              })
            : Promise.resolve([]),
          showVoids && voidsTotal > 0
            ? tx.paymentAttempt.findMany({
                where: voidsWhere,
                select: {
                  id: true,
                  provider: true,
                  reference: true,
                  amountCents: true,
                  order: { select: { id: true, orderNumber: true } },
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                skip,
                take: pageSize,
              })
            : Promise.resolve([]),
        ]);
      return {
        bankAttempts,
        codAttempts,
        refunds,
        compensations,
        successfulAttempts,
        totals: {
          bank: bankTotal,
          cod: codTotal,
          refunds: refundsTotal,
          compensations: compensationsTotal,
          voids: voidsTotal,
        },
        maxQueueTotal,
        page,
        totalPages,
      };
    }),
    blockedIdentityService().listPage(session.profile.id, {
      activeOnly: bloqueosEstado === "ACTIVE",
      page: requestedBlockedPage,
      pageSize: 20,
    }),
  ]);

  const {
    bankAttempts,
    codAttempts,
    refunds,
    compensations,
    successfulAttempts,
    totals,
    maxQueueTotal,
    page,
    totalPages,
  } = queueData;
  const canWrite = hasAdminPermission(session.profile.role, "payments:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const creditOperationKey = `admin-credit:${randomUUID()}`;
  const hasFilters = Boolean(q || estado !== "ALL");
  const hasBlockedFilters = bloqueosEstado !== "ALL";

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
        key={`${q}|${estado}|${bloqueosEstado}|${blockedPage.page}`}
        action="/admin/pagos"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        {bloqueosEstado !== "ALL" ? (
          <input type="hidden" name="bloqueosEstado" value={bloqueosEstado} />
        ) : null}
        {blockedPage.page > 1 ? (
          <input type="hidden" name="bloqueosPagina" value={String(blockedPage.page)} />
        ) : null}
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
            href={paymentsHref({
              q: "",
              estado: "ALL",
              page: 1,
              bloqueosEstado,
              bloqueosPagina: blockedPage.page,
            })}
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      {showBank ? (
        <section aria-labelledby="bank-transfers" className="space-y-4">
          <div>
            <h2 id="bank-transfers" className="text-xl font-semibold">
              Transferencias por confirmar ({numberFormatter.format(totals.bank)})
            </h2>
            {totals.bank > 0 && bankAttempts.length < totals.bank ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(bankAttempts.length)} de{" "}
                {numberFormatter.format(totals.bank)}
              </p>
            ) : null}
          </div>
          {bankAttempts.length === 0 ? (
            <Empty>
              {totals.bank > 0
                ? `No hay más transferencias en la página ${page} (${numberFormatter.format(totals.bank)} en total).`
                : "No hay transferencias pendientes."}
            </Empty>
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
                    {maskIdentifier(attempt.reference)}
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
          <div>
            <h2 id="cod-remittances" className="text-xl font-semibold">
              Recaudo y remesas COD ({numberFormatter.format(totals.cod)})
            </h2>
            {totals.cod > 0 && codAttempts.length < totals.cod ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(codAttempts.length)} de{" "}
                {numberFormatter.format(totals.cod)}
              </p>
            ) : null}
          </div>
          {codAttempts.length === 0 ? (
            <Empty>
              {totals.cod > 0
                ? `No hay más remesas COD en la página ${page} (${numberFormatter.format(totals.cod)} en total).`
                : "No hay pagos contraentrega pendientes de conciliación."}
            </Empty>
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
          <div>
            <h2 id="refunds-title" className="text-xl font-semibold">
              Reembolsos ({numberFormatter.format(totals.refunds)})
            </h2>
            {totals.refunds > 0 && refunds.length < totals.refunds ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(refunds.length)} de{" "}
                {numberFormatter.format(totals.refunds)}
              </p>
            ) : null}
          </div>
          {refunds.length === 0 ? (
            <Empty>
              {totals.refunds > 0
                ? `No hay más reembolsos en la página ${page} (${numberFormatter.format(totals.refunds)} en total).`
                : "No hay reembolsos por ejecutar o conciliar."}
            </Empty>
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
          <div>
            <h2 id="compensations" className="text-xl font-semibold">
              Compensaciones por conciliar ({numberFormatter.format(totals.compensations)})
            </h2>
            {totals.compensations > 0 && compensations.length < totals.compensations ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(compensations.length)} de{" "}
                {numberFormatter.format(totals.compensations)}
              </p>
            ) : null}
          </div>
          {compensations.length === 0 ? (
            <Empty>
              {totals.compensations > 0
                ? `No hay más compensaciones en la página ${page} (${numberFormatter.format(totals.compensations)} en total).`
                : "No hay reembolsos o anulaciones con resultado pendiente."}
            </Empty>
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
          <div>
            <h2 id="voids" className="text-xl font-semibold">
              Anulaciones de pagos ({numberFormatter.format(totals.voids)})
            </h2>
            {totals.voids > 0 && successfulAttempts.length < totals.voids ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Mostrando {numberFormatter.format(successfulAttempts.length)} de{" "}
                {numberFormatter.format(totals.voids)}
              </p>
            ) : null}
          </div>
          {successfulAttempts.length === 0 ? (
            <Empty>
              {totals.voids > 0
                ? `No hay más capturas anulables en la página ${page} (${numberFormatter.format(totals.voids)} en total).`
                : "No hay capturas disponibles para anular."}
            </Empty>
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
                    {formatCopCents(attempt.amountCents)} · {maskIdentifier(attempt.reference)}
                  </p>
                  {canWrite ? <VoidPaymentForm paymentAttemptId={attempt.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {maxQueueTotal > 0 ? (
        <nav
          aria-label="Paginación de pagos"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span className="text-sm text-muted-foreground">
            Página {page} de {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={paymentsHref({
                    q,
                    estado,
                    page: page - 1,
                    bloqueosEstado,
                    bloqueosPagina: blockedPage.page,
                  })}
                >
                  Anterior
                </Link>
              </Button>
            ) : null}
            {page < totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={paymentsHref({
                    q,
                    estado,
                    page: page + 1,
                    bloqueosEstado,
                    bloqueosPagina: blockedPage.page,
                  })}
                >
                  Siguiente
                </Link>
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
              Abonos y retiros con libro consecutivo, bloqueos por cliente e idempotencia
              persistente.
            </p>
          </div>
          <StoreCreditAdjustmentForm operationKey={creditOperationKey} />
        </section>
      ) : null}
      <section aria-labelledby="blocked-identities" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="blocked-identities" className="text-xl font-semibold">
            Identidades bloqueadas para COD ({numberFormatter.format(blockedPage.total)})
          </h2>
        </div>
        {canWrite ? (
          <div className="rounded-xl border border-border bg-card p-5">
            <BlockIdentityForm />
          </div>
        ) : null}
        <form
          key={`blocked|${q}|${estado}|${page}|${bloqueosEstado}`}
          action="/admin/pagos"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
        >
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {estado !== "ALL" ? <input type="hidden" name="estado" value={estado} /> : null}
          {page > 1 ? <input type="hidden" name="page" value={String(page)} /> : null}
          <Select
            name="bloqueosEstado"
            defaultValue={bloqueosEstado}
            aria-label="Filtrar identidades bloqueadas"
            fullWidth={false}
          >
            <option value="ALL">Todos los bloqueos</option>
            <option value="ACTIVE">Solo bloqueos activos</option>
          </Select>
          <Button type="submit" variant="outline">
            Filtrar
          </Button>
          {hasBlockedFilters ? (
            <Link
              href={paymentsHref({
                q,
                estado,
                page,
                bloqueosEstado: "ALL",
                bloqueosPagina: 1,
              })}
              className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              Limpiar
            </Link>
          ) : null}
        </form>
        {blockedPage.items.length === 0 ? (
          <Empty>
            {hasBlockedFilters
              ? "No hay identidades con bloqueos activos."
              : "No hay identidades bloqueadas."}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {blockedPage.items.map((identity) => (
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
        {blockedPage.total > 0 ? (
          <nav
            aria-label="Paginación de identidades bloqueadas"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-sm text-muted-foreground">
              Página {blockedPage.page} de {blockedPage.totalPages} ·{" "}
              {numberFormatter.format(blockedPage.total)}{" "}
              {blockedPage.total === 1 ? "identidad bloqueada" : "identidades bloqueadas"}
            </span>
            <div className="flex gap-2">
              {blockedPage.page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={paymentsHref({
                      q,
                      estado,
                      page,
                      bloqueosEstado,
                      bloqueosPagina: blockedPage.page - 1,
                    })}
                  >
                    Anterior
                  </Link>
                </Button>
              ) : null}
              {blockedPage.page < blockedPage.totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={paymentsHref({
                      q,
                      estado,
                      page,
                      bloqueosEstado,
                      bloqueosPagina: blockedPage.page + 1,
                    })}
                  >
                    Siguiente
                  </Link>
                </Button>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
