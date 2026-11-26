import { formatCopCents, hasAdminPermission, maskEmail, maskIdentifier } from "@mundonettech/core";
import type { FiscalDocumentStatus, Prisma } from "@mundonettech/db";
import Link from "next/link";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { EmptyState as Empty } from "@/components/admin/empty-state";
import { FiscalOperationForm } from "@/components/admin/fiscal-operation-forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { fiscalDocStatusLabels, refundReasonLabels } from "@/lib/admin-presenters";
import { single } from "@/lib/admin-search-params";
import { getDatabaseClock } from "@/lib/database-clock";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Facturación electrónica DIAN" };

const allowedFiscalStates: readonly FiscalDocumentStatus[] = [
  "DRAFT",
  "TRANSMITTING",
  "ACCEPTED",
  "REJECTED",
  "UNCERTAIN",
  "CANCELLED",
];

const allowedQueues = [
  "ALL",
  "PENDING_ORDERS",
  "INVOICES",
  "PENDING_REFUNDS",
  "CREDIT_NOTES",
] as const;
type FiscalQueue = (typeof allowedQueues)[number];

const queueLabels: Record<FiscalQueue, string> = {
  ALL: "Todas las colas",
  PENDING_ORDERS: "Órdenes por facturar",
  INVOICES: "Facturas",
  PENDING_REFUNDS: "Reembolsos por nota crédito",
  CREDIT_NOTES: "Notas crédito",
};

function fiscalHref(q: string, estado: string, cola: FiscalQueue, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado) params.set("estado", estado);
  if (cola !== "ALL") params.set("cola", cola);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/facturacion?${qs}` : "/admin/facturacion";
}

function queueSummary(shown: number, total: number, page: number): string {
  if (total === 0) return "0 registros";
  if (shown === 0) {
    return `Mostrando 0 de ${total} en la página ${page} (los registros están en páginas anteriores)`;
  }
  return `Mostrando ${shown} de ${total}`;
}

export default async function InvoicesPage({ searchParams }: PageProps<"/admin/facturacion">) {
  const session = await requireAdminPage("invoices:read");
  const raw = await searchParams;
  const q = (single(raw.q) ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
  const rawEstado = single(raw.estado) ?? "";
  const estado = allowedFiscalStates.includes(rawEstado as FiscalDocumentStatus)
    ? (rawEstado as FiscalDocumentStatus)
    : "";
  const rawCola = single(raw.cola) ?? "";
  const cola: FiscalQueue = (allowedQueues as readonly string[]).includes(rawCola)
    ? (rawCola as FiscalQueue)
    : "ALL";
  const rawPage = single(raw.page)?.trim() ?? "";
  const parsedPage = /^[1-9]\d*$/.test(rawPage) ? Number.parseInt(rawPage, 10) : 1;
  const requestedPage = Math.max(
    1,
    Math.min(10_000, Number.isSafeInteger(parsedPage) ? parsedPage : 1),
  );
  const pageSize = 20;

  const pendingOrdersWhere: Prisma.OrderWhereInput = {
    taxRegime: "RESPONSABLE_IVA",
    paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] },
    taxInvoice: null,
    ...(q ? { orderNumber: { contains: q, mode: "insensitive" } } : {}),
  };
  const invoicesWhere: Prisma.TaxInvoiceWhereInput = {
    ...(estado ? { status: estado } : {}),
    ...(q
      ? {
          OR: [
            { fullNumber: { contains: q, mode: "insensitive" } },
            { cufe: { contains: q, mode: "insensitive" } },
            { order: { orderNumber: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const pendingRefundsWhere: Prisma.OrderRefundWhereInput = {
    status: "COMPLETED",
    creditNote: null,
    order: {
      taxInvoice: { status: "ACCEPTED" },
      ...(q ? { orderNumber: { contains: q, mode: "insensitive" } } : {}),
    },
  };
  const creditNotesWhere: Prisma.CreditNoteWhereInput = {
    ...(estado ? { status: estado } : {}),
    ...(q
      ? {
          OR: [
            { fullNumber: { contains: q, mode: "insensitive" } },
            { cude: { contains: q, mode: "insensitive" } },
            { invoice: { order: { orderNumber: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const db = getDatabase();
  const [now, pendingOrdersTotal, invoicesTotal, pendingRefundsTotal, creditNotesTotal] =
    await Promise.all([
      getDatabaseClock(db),
      db.order.count({ where: pendingOrdersWhere }),
      db.taxInvoice.count({ where: invoicesWhere }),
      db.orderRefund.count({ where: pendingRefundsWhere }),
      db.creditNote.count({ where: creditNotesWhere }),
    ]);

  const pendingOrdersTotalPages = Math.max(1, Math.ceil(pendingOrdersTotal / pageSize));
  const invoicesTotalPages = Math.max(1, Math.ceil(invoicesTotal / pageSize));
  const pendingRefundsTotalPages = Math.max(1, Math.ceil(pendingRefundsTotal / pageSize));
  const creditNotesTotalPages = Math.max(1, Math.ceil(creditNotesTotal / pageSize));

  const activeTotalPages =
    cola === "PENDING_ORDERS"
      ? pendingOrdersTotalPages
      : cola === "INVOICES"
        ? invoicesTotalPages
        : cola === "PENDING_REFUNDS"
          ? pendingRefundsTotalPages
          : cola === "CREDIT_NOTES"
            ? creditNotesTotalPages
            : Math.max(
                pendingOrdersTotalPages,
                invoicesTotalPages,
                pendingRefundsTotalPages,
                creditNotesTotalPages,
              );
  const page = Math.min(requestedPage, activeTotalPages);
  const skip = (page - 1) * pageSize;

  const showPendingOrders = cola === "ALL" || cola === "PENDING_ORDERS";
  const showInvoices = cola === "ALL" || cola === "INVOICES";
  const showPendingRefunds = cola === "ALL" || cola === "PENDING_REFUNDS";
  const showCreditNotes = cola === "ALL" || cola === "CREDIT_NOTES";

  const [pendingOrders, invoices, pendingRefunds, creditNotes] = await Promise.all([
    showPendingOrders && pendingOrdersTotal > skip
      ? db.order.findMany({
          where: pendingOrdersWhere,
          select: {
            id: true,
            orderNumber: true,
            totalCents: true,
            emailSnapshot: true,
            buyerDocumentNumberSnapshot: true,
          },
          orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
    showInvoices && invoicesTotal > skip
      ? db.taxInvoice.findMany({
          where: invoicesWhere,
          select: {
            id: true,
            fullNumber: true,
            status: true,
            totalCents: true,
            failureCode: true,
            cufe: true,
            order: {
              select: {
                id: true,
                orderNumber: true,
                emailSnapshot: true,
                buyerDocumentNumberSnapshot: true,
              },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
    showPendingRefunds && pendingRefundsTotal > skip
      ? db.orderRefund.findMany({
          where: pendingRefundsWhere,
          select: {
            id: true,
            totalCents: true,
            reason: true,
            order: { select: { id: true, orderNumber: true } },
          },
          orderBy: [{ processedAt: "asc" }, { id: "asc" }],
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
    showCreditNotes && creditNotesTotal > skip
      ? db.creditNote.findMany({
          where: creditNotesWhere,
          select: {
            id: true,
            fullNumber: true,
            status: true,
            totalCents: true,
            failureCode: true,
            cude: true,
            invoice: { select: { order: { select: { id: true, orderNumber: true } } } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: pageSize,
        })
      : Promise.resolve([]),
  ]);

  const mfaAgeMs = session.lastMfaAt ? now.getTime() - session.lastMfaAt.getTime() : null;
  const recentMfa = mfaAgeMs !== null && mfaAgeMs >= -30_000 && mfaAgeMs <= 600_000;
  const canWrite = hasAdminPermission(session.profile.role, "invoices:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const hasFilters = Boolean(q || estado || cola !== "ALL");

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Facturación electrónica DIAN</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          UBL 2.1, CUFE/CUDE SHA-384, consecutivos serializados y XML firmado por el proveedor
          autorizado. Los resultados inciertos se concilian antes de retransmitir.
        </p>
      </div>
      <CmsStepUp session={session} />
      <form
        key={`${q}|${estado}|${cola}`}
        action="/admin/facturacion"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4"
      >
        <label htmlFor="fiscal-q" className="sr-only">
          Buscar documentos fiscales
        </label>
        <Input
          id="fiscal-q"
          name="q"
          defaultValue={q}
          maxLength={100}
          placeholder="Pedido, consecutivo, CUFE o CUDE"
          className="min-w-60 flex-1"
        />
        <Select
          name="cola"
          defaultValue={cola}
          aria-label="Filtrar por cola de facturación"
          fullWidth={false}
        >
          {allowedQueues.map((item) => (
            <option key={item} value={item}>
              {queueLabels[item]}
            </option>
          ))}
        </Select>
        <Select
          name="estado"
          defaultValue={estado}
          aria-label="Filtrar por estado DIAN"
          fullWidth={false}
        >
          <option value="">Todos los estados</option>
          {allowedFiscalStates.map((st) => (
            <option key={st} value={st}>
              {fiscalDocStatusLabels[st]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
        {hasFilters ? (
          <Link
            href="/admin/facturacion"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-primary underline underline-offset-4"
          >
            Limpiar
          </Link>
        ) : null}
      </form>
      {showPendingOrders ? (
        <section aria-labelledby="invoice-preparation" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="invoice-preparation" className="text-xl font-semibold">
              Órdenes listas para facturar
            </h2>
            <p className="text-sm text-muted-foreground">
              {queueSummary(pendingOrders.length, pendingOrdersTotal, page)}
            </p>
          </div>
          {pendingOrders.length === 0 ? (
            <Empty>
              {pendingOrdersTotal > 0
                ? `No hay más órdenes por facturar en la página ${page}; revisa las páginas anteriores o filtra por esta cola.`
                : "No hay órdenes responsables de IVA pendientes de factura."}
            </Empty>
          ) : (
            <ul className="space-y-3">
              {pendingOrders.map((order) => (
                <li key={order.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">
                        {canReadOrders ? (
                          <Link href={`/admin/pedidos/${order.id}`} className="underline">
                            {order.orderNumber}
                          </Link>
                        ) : (
                          order.orderNumber
                        )}{" "}
                        · {formatCopCents(order.totalCents)}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {order.emailSnapshot ? maskEmail(order.emailSnapshot) : "Sin correo"} ·{" "}
                        {order.buyerDocumentNumberSnapshot
                          ? maskIdentifier(order.buyerDocumentNumberSnapshot)
                          : "Documento incompleto"}
                      </p>
                    </div>
                    {canWrite ? (
                      <FiscalOperationForm
                        kind="prepare-invoice"
                        id={order.id}
                        label="Preparar factura"
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showInvoices ? (
        <section aria-labelledby="invoice-list" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="invoice-list" className="text-xl font-semibold">
              Facturas
            </h2>
            <p className="text-sm text-muted-foreground">
              {queueSummary(invoices.length, invoicesTotal, page)}
            </p>
          </div>
          {invoices.length === 0 ? (
            <Empty>
              {invoicesTotal > 0
                ? `No hay más facturas en la página ${page}; revisa las páginas anteriores o filtra por esta cola.`
                : hasFilters
                  ? "No hay facturas electrónicas con estos criterios."
                  : "Aún no hay facturas electrónicas."}
            </Empty>
          ) : (
            <ul className="space-y-3">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold">
                        {invoice.fullNumber} ·{" "}
                        {canReadOrders ? (
                          <Link href={`/admin/pedidos/${invoice.order.id}`} className="underline">
                            {invoice.order.orderNumber}
                          </Link>
                        ) : (
                          invoice.order.orderNumber
                        )}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {invoice.order.emailSnapshot
                          ? maskEmail(invoice.order.emailSnapshot)
                          : "Sin correo"}{" "}
                        ·{" "}
                        {invoice.order.buyerDocumentNumberSnapshot
                          ? maskIdentifier(invoice.order.buyerDocumentNumberSnapshot)
                          : "Documento incompleto"}
                      </p>
                      <p className="mt-1 text-sm wrap-break-word">
                        {fiscalDocStatusLabels[invoice.status] ?? invoice.status} ·{" "}
                        {formatCopCents(invoice.totalCents)}
                        {invoice.failureCode ? ` · ${invoice.failureCode}` : ""}
                      </p>
                      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                        {invoice.cufe}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canWrite &&
                      ["DRAFT", "UNCERTAIN", "TRANSMITTING"].includes(invoice.status) ? (
                        <FiscalOperationForm
                          kind="transmit-invoice"
                          id={invoice.id}
                          label={invoice.status === "DRAFT" ? "Transmitir" : "Conciliar"}
                        />
                      ) : null}
                      {invoice.status === "ACCEPTED" ? (
                        recentMfa ? (
                          <a
                            href={`/admin/facturacion/documentos/invoice/${invoice.id}`}
                            download
                            className="text-sm font-medium text-primary underline"
                          >
                            Descargar XML
                          </a>
                        ) : (
                          <a
                            href="#admin-step-up-prompt"
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground underline underline-offset-4"
                          >
                            Confirma MFA arriba para descargar XML
                          </a>
                        )
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showPendingRefunds ? (
        <section aria-labelledby="credit-note-preparation" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="credit-note-preparation" className="text-xl font-semibold">
              Reembolsos listos para nota crédito
            </h2>
            <p className="text-sm text-muted-foreground">
              {queueSummary(pendingRefunds.length, pendingRefundsTotal, page)}
            </p>
          </div>
          {pendingRefunds.length === 0 ? (
            <Empty>
              {pendingRefundsTotal > 0
                ? `No hay más reembolsos pendientes en la página ${page}; revisa las páginas anteriores o filtra por esta cola.`
                : "No hay reembolsos pendientes de nota crédito."}
            </Empty>
          ) : (
            <ul className="space-y-3">
              {pendingRefunds.map((refund) => (
                <li
                  key={refund.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
                >
                  <div>
                    <h3 className="font-semibold">
                      {canReadOrders ? (
                        <Link href={`/admin/pedidos/${refund.order.id}`} className="underline">
                          {refund.order.orderNumber}
                        </Link>
                      ) : (
                        refund.order.orderNumber
                      )}{" "}
                      · {formatCopCents(refund.totalCents)}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {refundReasonLabels[refund.reason] ?? refund.reason}
                    </p>
                  </div>
                  {canWrite ? (
                    <FiscalOperationForm
                      kind="prepare-credit-note"
                      id={refund.id}
                      label="Preparar nota crédito"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showCreditNotes ? (
        <section aria-labelledby="credit-note-list" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="credit-note-list" className="text-xl font-semibold">
              Notas crédito
            </h2>
            <p className="text-sm text-muted-foreground">
              {queueSummary(creditNotes.length, creditNotesTotal, page)}
            </p>
          </div>
          {creditNotes.length === 0 ? (
            <Empty>
              {creditNotesTotal > 0
                ? `No hay más notas crédito en la página ${page}; revisa las páginas anteriores o filtra por esta cola.`
                : hasFilters
                  ? "No hay notas crédito con estos criterios."
                  : "Aún no hay notas crédito."}
            </Empty>
          ) : (
            <ul className="space-y-3">
              {creditNotes.map((note) => (
                <li key={note.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold">
                        {note.fullNumber} ·{" "}
                        {canReadOrders ? (
                          <Link
                            href={`/admin/pedidos/${note.invoice.order.id}`}
                            className="underline"
                          >
                            {note.invoice.order.orderNumber}
                          </Link>
                        ) : (
                          note.invoice.order.orderNumber
                        )}
                      </h3>
                      <p className="mt-1 text-sm wrap-break-word">
                        {fiscalDocStatusLabels[note.status] ?? note.status} ·{" "}
                        {formatCopCents(note.totalCents)}
                        {note.failureCode ? ` · ${note.failureCode}` : ""}
                      </p>
                      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                        {note.cude}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canWrite && ["DRAFT", "UNCERTAIN", "TRANSMITTING"].includes(note.status) ? (
                        <FiscalOperationForm
                          kind="transmit-credit-note"
                          id={note.id}
                          label={note.status === "DRAFT" ? "Transmitir" : "Conciliar"}
                        />
                      ) : null}
                      {note.status === "ACCEPTED" ? (
                        recentMfa ? (
                          <a
                            href={`/admin/facturacion/documentos/credit-note/${note.id}`}
                            download
                            className="text-sm font-medium text-primary underline"
                          >
                            Descargar XML
                          </a>
                        ) : (
                          <a
                            href="#admin-step-up-prompt"
                            className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground underline underline-offset-4"
                          >
                            Confirma MFA arriba para descargar XML
                          </a>
                        )
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {activeTotalPages > 1 ? (
        <nav aria-label="Paginación de facturación" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Página {page} de {activeTotalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={fiscalHref(q, estado, cola, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {page < activeTotalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={fiscalHref(q, estado, cola, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
