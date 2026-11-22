import { formatCopCents, hasAdminPermission, maskEmail, maskIdentifier } from "@mundonettech/core";

import { CmsStepUp } from "@/components/admin/cms-step-up";
import { FiscalOperationForm } from "@/components/admin/fiscal-operation-forms";
import { getDatabase } from "@/lib/db";
import { requireAdminPage } from "@/lib/security/admin-auth";

export const metadata = { title: "Facturación electrónica DIAN" };

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export default async function InvoicesPage() {
  const session = await requireAdminPage("invoices:read");
  const db = getDatabase();
  const [pendingOrders, invoices, creditNotes, pendingRefunds] = await Promise.all([
    db.order.findMany({
      where: {
        taxRegime: "RESPONSABLE_IVA",
        paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] },
        taxInvoice: null,
      },
      orderBy: [{ confirmedAt: "asc" }, { id: "asc" }],
      take: 50,
    }),
    db.taxInvoice.findMany({
      include: {
        order: {
          select: { orderNumber: true, emailSnapshot: true, buyerDocumentNumberSnapshot: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    db.creditNote.findMany({
      include: { invoice: { include: { order: { select: { orderNumber: true } } } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    db.orderRefund.findMany({
      where: {
        status: "COMPLETED",
        creditNote: null,
        order: { taxInvoice: { status: "ACCEPTED" } },
      },
      include: { order: { select: { orderNumber: true } } },
      orderBy: [{ processedAt: "asc" }, { id: "asc" }],
      take: 50,
    }),
  ]);
  const canWrite = hasAdminPermission(session.profile.role, "invoices:write");
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Facturación electrónica DIAN</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          UBL 2.1, CUFE/CUDE SHA-384, consecutivos serializados y XML firmado por el proveedor
          autorizado. Los resultados inciertos se concilian antes de retransmitir.
        </p>
      </div>
      {canWrite ? <CmsStepUp session={session} /> : null}
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
                      {order.orderNumber} · {formatCopCents(order.totalCents)}
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
          <Empty>Aún no hay facturas electrónicas.</Empty>
        ) : (
          <ul className="space-y-3">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {invoice.fullNumber} · {invoice.order.orderNumber}
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
                    <p className="mt-1 text-sm">
                      {invoice.status} · {formatCopCents(invoice.totalCents)}
                      {invoice.failureCode ? ` · ${invoice.failureCode}` : ""}
                    </p>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {invoice.cufe}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canWrite && ["DRAFT", "UNCERTAIN", "TRANSMITTING"].includes(invoice.status) ? (
                      <FiscalOperationForm
                        kind="transmit-invoice"
                        id={invoice.id}
                        label={invoice.status === "UNCERTAIN" ? "Conciliar" : "Transmitir"}
                      />
                    ) : null}
                    {invoice.status === "ACCEPTED" ? (
                      <a
                        href={`/admin/facturacion/documentos/invoice/${invoice.id}`}
                        className="text-sm text-primary underline"
                      >
                        Descargar XML
                      </a>
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
                    {refund.order.orderNumber} · {formatCopCents(refund.totalCents)}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{refund.reason}</p>
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
          <Empty>Aún no hay notas crédito.</Empty>
        ) : (
          <ul className="space-y-3">
            {creditNotes.map((note) => (
              <li key={note.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {note.fullNumber} · {note.invoice.order.orderNumber}
                    </h3>
                    <p className="mt-1 text-sm">
                      {note.status} · {formatCopCents(note.totalCents)}
                      {note.failureCode ? ` · ${note.failureCode}` : ""}
                    </p>
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {note.cude}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canWrite && ["DRAFT", "UNCERTAIN", "TRANSMITTING"].includes(note.status) ? (
                      <FiscalOperationForm
                        kind="transmit-credit-note"
                        id={note.id}
                        label={note.status === "UNCERTAIN" ? "Conciliar" : "Transmitir"}
                      />
                    ) : null}
                    {note.status === "ACCEPTED" ? (
                      <a
                        href={`/admin/facturacion/documentos/credit-note/${note.id}`}
                        className="text-sm text-primary underline"
                      >
                        Descargar XML
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
