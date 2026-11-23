import { randomUUID } from "node:crypto";

import {
  formatCopCents,
  maskEmail,
  maskIdentifier,
  maskName,
  maskPhone,
  opportunityProposalStatusLabels,
} from "@mundonettech/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { ProposalAcceptanceForm } from "@/components/b2b/proposal-acceptance-form";
import { b2bService, hashProposalToken, receiptTokenForProposal } from "@/lib/b2b";
import { orderService } from "@/lib/checkout";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  dateStyle: "long",
  timeStyle: "short",
});

export async function generateMetadata() {
  return { title: "Propuesta comercial", robots: { index: false, follow: false, nocache: true } };
}

export default async function ProposalPage({ params }: PageProps<"/propuesta/[token]">) {
  await connection();
  const { token } = await params;
  let proposal;
  try {
    proposal = await b2bService().getPublicProposal(hashProposalToken(token));
  } catch (error) {
    if (error instanceof TypeError) notFound();
    throw error;
  }
  if (!proposal) notFound();
  const preview =
    proposal.available && proposal.cartId
      ? await orderService().preview({ cartId: proposal.cartId })
      : null;
  const canAccept = Boolean(preview?.cart.canContinue);
  if (preview && preview.homeDelivery.totalCents !== proposal.totalCents) {
    throw new Error("Proposal and checkout totals diverge.");
  }
  const maskedContactName = `${maskName(proposal.contact.givenName)} ${maskName(proposal.contact.familyName)}`;
  const maskedEmail = maskEmail(proposal.contact.email);
  const maskedPhone = maskPhone(proposal.contact.phoneE164);
  const maskedTaxId = maskIdentifier(proposal.contact.documentNumber);
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <p className="text-sm font-medium text-primary">
          Propuesta comercial · versión {proposal.version}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{proposal.organizationName}</h1>
        <p className="mt-2 text-muted-foreground">
          Vigente hasta {dateFormatter.format(new Date(proposal.expiresAt))} (hora de Colombia).
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Estado: {opportunityProposalStatusLabels[proposal.status]}
        </p>
      </div>
      <section
        aria-labelledby="proposal-lines"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <h2 id="proposal-lines" className="sr-only">
          Detalle de la propuesta
        </h2>
        <ul className="divide-y divide-border">
          {proposal.items.map((item) => (
            <li
              key={item.variantId}
              className="flex flex-wrap items-start justify-between gap-4 p-5"
            >
              <div>
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{item.sku}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {item.quantity} × {formatCopCents(item.unitPriceCents)}
                </p>
                {BigInt(item.discountCents) > 0n ? (
                  <p className="text-xs text-success">
                    Descuento: {formatCopCents(item.discountCents)}
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="font-semibold">{formatCopCents(item.lineTotalCents)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  IVA: {formatCopCents(item.taxCents)}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <dl className="space-y-3 border-t border-border bg-secondary/30 p-5 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal de catálogo</dt>
            <dd>{formatCopCents(proposal.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Descuento comercial</dt>
            <dd>−{formatCopCents(proposal.discountCents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>
              Impuestos (
              {proposal.taxRegime === "RESPONSABLE_IVA"
                ? "régimen responsable de IVA"
                : "régimen no responsable de IVA"}
              )
            </dt>
            <dd>{formatCopCents(proposal.taxCents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Envío estándar</dt>
            <dd>{formatCopCents(proposal.shippingCents)}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-3 text-xl font-bold">
            <dt>Total</dt>
            <dd>{formatCopCents(proposal.totalCents)}</dd>
          </div>
        </dl>
      </section>
      {proposal.commercialNotes ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">Condiciones comerciales</h2>
          <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">
            {proposal.commercialNotes}
          </p>
        </section>
      ) : null}
      {proposal.status === "CONVERTED" ? (
        <section className="rounded-xl border border-success bg-card p-6">
          <h2 className="text-xl font-semibold">Propuesta convertida en pedido</h2>
          <p className="mt-2 text-muted-foreground">
            La aceptación quedó registrada. Consulta el estado actual y el comprobante del pedido en
            tu recibo.
          </p>
          <Link
            href={`/recibo/${receiptTokenForProposal(token)}`}
            className="mt-4 inline-flex font-medium text-primary underline"
          >
            Abrir recibo del pedido
          </Link>
        </section>
      ) : !proposal.available ? (
        <section role="alert" className="rounded-xl border border-warning bg-card p-6">
          <h2 className="text-xl font-semibold">Esta versión no admite aceptación</h2>
          <p className="mt-2 text-muted-foreground">
            Solicita a tu asesor un enlace vigente. No se creó ningún pedido desde esta pantalla.
          </p>
        </section>
      ) : !canAccept || !preview ? (
        <section role="alert" className="rounded-xl border border-warning bg-card p-6">
          <h2 className="text-xl font-semibold">La disponibilidad cambió</h2>
          <p className="mt-2 text-muted-foreground">
            No hay existencias suficientes para toda la propuesta. Solicita una nueva versión; no se
            reservó stock ni se creó un pedido.
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-6 sm:p-8">
          <div className="mb-6 text-sm text-muted-foreground">
            <p>
              Contacto registrado: {maskedContactName} · {maskedEmail} · {maskedPhone}
            </p>
            <p className="mt-1">Documento fiscal de la empresa: {maskedTaxId}</p>
          </div>
          <ProposalAcceptanceForm
            proposalId={proposal.id}
            token={token}
            reviewFingerprint={preview.homeDelivery.reviewFingerprint}
            submissionId={randomUUID()}
            departments={preview.departments}
            municipalities={preview.municipalities}
          />
        </section>
      )}
    </div>
  );
}
