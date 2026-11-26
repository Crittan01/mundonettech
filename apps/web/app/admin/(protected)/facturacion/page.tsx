import { formatCopCents, hasAdminPermission, maskEmail, maskIdentifier } from "@mundonettech/core";
import type { FiscalDocumentStatus } from "@mundonettech/db";
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

function fiscalHref(q: string, estado: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (estado) params.set("estado", estado);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/facturacion?${qs}` : "/admin/facturacion";
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
  const requestedPage = Number.parseInt(single(raw.page) ?? "1", 10) || 1;
  const page = Math.max(1, Math.min(10_000, requestedPage));
  const pageSize = 20;
  const skip = (page - 1) * pageSize;
  const take = pageSize + 1;

  const db = getDatabase();
  const [now, pendingOrders, rawInvoices, rawCreditNotes, pendingRefunds] = await Promise.all([
    getDatabaseClock(db),
    db.order.findMany({
      where: {
        taxRegime: "RESPONSABLE_IVA",
        paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] },
        taxInvoice: null,
        ...(q ? { orderNumber: { contains: q, mode: "insensitive" } } : {}),
      },
      select: {
        id: true,
        orderNumber: true,
        totalCents: true,
        emailSnapshot: true,
        buyerDocumentNumberSnapshot: true,
      },
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      take: 50,
    }),
    db.taxInvoice.findMany({
      where: {
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
      },
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
      take,
    }),
    db.creditNote.findMany({
      where: {
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
      },
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
      take,
    }),
    db.orderRefund.findMany({
      where: {
        status: "COMPLETED",
        creditNote: null,
        order: {
          taxInvoice: { status: "ACCEPTED" },
          ...(q ? { orderNumber: { contains: q, mode: "insensitive" } } : {}),
        },
      },
      select: {
        id: true,
        totalCents: true,
        reason: true,
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: [{ processedAt: "asc" }, { id: "asc" }],
      take: 50,
    }),
  ]);

  const hasMore = rawInvoices.length > pageSize || rawCreditNotes.length > pageSize;
  const invoices = rawInvoices.slice(0, pageSize);
  const creditNotes = rawCreditNotes.slice(0, pageSize);

  const mfaAgeMs = session.lastMfaAt ? now.getTime() - session.lastMfaAt.getTime() : null;
  const recentMfa = mfaAgeMs !== null && mfaAgeMs >= -30_000 && mfaAgeMs <= 600_000;
  const canWrite = hasAdminPermission(session.profile.role, "invoices:write");
  const canReadOrders = hasAdminPermission(session.profile.role, "orders:read");
  const hasFilters = Boolean(q || estado);

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
        key={`${q}|${estado}`}
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
      <section aria-labelledby="invoice-preparation" className="space-y-3">
        <h2 id="invoice-preparation" className="text-xl font-semibold">
          Órdenes listas para facturar
        </h2>
        {pendingOrders.length === 0 ? (
          <Empty>No hay órdenes responsables de IVA pendientes de factura.</Empty>
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
      <section aria-labelledby="invoice-list" className="space-y-3">
        <h2 id="invoice-list" className="text-xl font-semibold">
          Facturas
        </h2>
        {invoices.length === 0 ? (
          <Empty>
            {hasFilters
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
                    {canWrite && ["DRAFT", "UNCERTAIN", "TRANSMITTING"].includes(invoice.status) ? (
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
      <section aria-labelledby="credit-note-preparation" className="space-y-3">
        <h2 id="credit-note-preparation" className="text-xl font-semibold">
          Reembolsos listos para nota crédito
        </h2>
        {pendingRefunds.length === 0 ? (
          <Empty>No hay reembolsos pendientes de nota crédito.</Empty>
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
      <section aria-labelledby="credit-note-list" className="space-y-3">
        <h2 id="credit-note-list" className="text-xl font-semibold">
          Notas crédito
        </h2>
        {creditNotes.length === 0 ? (
          <Empty>
            {hasFilters ? "No hay notas crédito con estos criterios." : "Aún no hay notas crédito."}
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
      {page > 1 || hasMore ? (
        <nav aria-label="Paginación de facturación" className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Página {page}</span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={fiscalHref(q, estado, page - 1)}>Anterior</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={fiscalHref(q, estado, page + 1)}>Siguiente</Link>
              </Button>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
