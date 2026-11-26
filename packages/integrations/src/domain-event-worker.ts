import { formatCopCents } from "@mundonettech/core";
import {
  claimDomainOutboxEvents,
  completeDomainOutbox,
  failDomainOutbox,
  GrowthService,
  LifecycleService,
  OperationsService,
  retryDomainOutbox,
  type DomainOutbox,
} from "@mundonettech/db";

import { EmailService } from "./email-service.js";
import {
  InvoiceConflictError,
  InvoiceNotFoundError,
  InvoiceProviderError,
  InvoiceValidationError,
} from "./invoice-types.js";
import { InvoiceService } from "./invoice-service.js";
import {
  assertIntegrationKey,
  databaseTimestamp,
  publicHttpsUrl,
  recordValue,
} from "./integration-utils.js";
import {
  ShippingConflictError,
  ShippingProviderError,
  ShippingValidationError,
} from "./shipping-types.js";
import { ShippingService } from "./shipping-service.js";
import { EmailConflictError, EmailProviderError, EmailValidationError } from "./email-types.js";
import type { MetaCapiService } from "./meta-capi-service.js";
import { MetaCapiServiceError } from "./meta-capi-service.js";

const supportedEvents = [
  "cart.abandoned.v1",
  "cart.expired.v1",
  "lifecycle.enrollment.started.v1",
  "lifecycle.message.dispatch.v1",
  "order.confirmed.v1",
  "order.cancelled.v1",
  "order.payment.paid.v1",
  "order.payment.partial-expired-review-required.v1",
  "order.receipt.emission_blocked.v1",
  "order.receipt.integrity_failed.v1",
  "payment.late-review-required.v1",
  "meta.capi.dispatch.v1",
  "order.refund.requested.v1",
  "order.refund.completed.v1",
  "shipping.fulfillment.created.v1",
  "shipping.label.requested.v1",
  "shipping.label.generated.v1",
  "shipping.provider.uncertain.v1",
  "shipping.shipment.shipped.v1",
  "shipping.shipment.delivered.v1",
  "email.requested.v1",
  "invoice.transmission.requested.v1",
  "invoice.accepted.v1",
  "invoice.rejected.v1",
  "credit-note.transmission.requested.v1",
  "credit-note.accepted.v1",
  "credit-note.rejected.v1",
  "customer.auth-erasure.requested.v1",
  "postsale.return.requested.v1",
  "postsale.return.status.v1",
  "postsale.warranty.requested.v1",
  "postsale.warranty.status.v1",
  "support.ticket.created.v1",
  "support.ticket.updated.v1",
] as const;

class RetryableDomainEventError extends Error {
  constructor(readonly availableAt: Date) {
    super("Domain event requires a scheduled retry.");
    this.name = "RetryableDomainEventError";
  }
}

class PausedDomainEventError extends Error {
  constructor(readonly availableAt: Date) {
    super("Domain event is deferred while its lifecycle journey is paused.");
    this.name = "PausedDomainEventError";
  }
}

export interface DomainEventWorkerOptions {
  readonly workerId: string;
  readonly shipping: ShippingService;
  readonly email: EmailService;
  readonly invoice: InvoiceService;
  readonly vault: {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: readonly { id: string; provider: string; revokedAt: Date | null }[];
    }>;
  };
  readonly publicSiteUrl: string;
  readonly allowLoopback?: boolean;
  readonly storeName: string;
  readonly receiptTokenForSubmission: (reference: string) => string;
  readonly metaCapi?: MetaCapiService;
  readonly eraseAuthUser?: (authUserId: string) => Promise<void>;
  readonly maximumAttempts?: number;
}

export interface DomainEventBatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retries: number;
  readonly failed: number;
}

export class DomainEventWorker {
  private readonly publicSiteUrl: string;
  private readonly maximumAttempts: number;

  constructor(
    private readonly db: import("@mundonettech/db").PrismaClient,
    private readonly options: DomainEventWorkerOptions,
  ) {
    this.publicSiteUrl = publicHttpsUrl(options.publicSiteUrl, "publicSiteUrl", {
      allowLoopback: options.allowLoopback === true,
    }).replace(/\/$/, "");
    this.maximumAttempts = options.maximumAttempts ?? 10;
    assertIntegrationKey(options.workerId, "workerId");
    if (
      !Number.isInteger(this.maximumAttempts) ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 100
    )
      throw new TypeError("maximumAttempts must be between 1 and 100.");
  }

  private payload(event: DomainOutbox): Record<string, unknown> {
    const payload = recordValue(event.payload);
    if (!payload) throw new EmailValidationError("Domain event payload must be an object.");
    return payload;
  }

  private id(event: DomainOutbox, field: string): string {
    const value = this.payload(event)[field];
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))
      throw new EmailValidationError(`Domain event ${field} must be a UUID.`);
    return value;
  }

  private async emailCredentialId(): Promise<string> {
    const credentials = await this.options.vault.list({ includeRevoked: false, limit: 100 });
    const active = credentials.items.filter(
      (item) => item.provider === "resend" && !item.revokedAt,
    );
    if (active.length !== 1 || credentials.items.length === 100)
      throw new EmailValidationError(
        "Exactly one active Resend credential is required for domain emails.",
      );
    return active[0]!.id;
  }

  private async receiptUrl(
    orderId: string,
    document?: { kind: "invoice" | "credit-note"; id: string },
  ): Promise<string> {
    const event = await this.db.domainOutbox.findFirst({
      where: { aggregateType: "Order", aggregateId: orderId, eventType: "order.confirmed.v1" },
    });
    const payload = recordValue(event?.payload);
    const reference = payload?.receiptDeliveryReference;
    if (typeof reference !== "string")
      throw new EmailValidationError("Order receipt delivery reference is unavailable.");
    const token = this.options.receiptTokenForSubmission(reference);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
      throw new EmailValidationError("Receipt token derivation returned an invalid token.");
    if (document)
      return `${this.publicSiteUrl}/api/recibos/${encodeURIComponent(token)}/documentos/${document.kind}/${document.id}`;
    return `${this.publicSiteUrl}/recibo/${encodeURIComponent(token)}`;
  }

  private async queueOrderEmail(options: {
    orderId: string;
    templateKey:
      | "order.confirmed"
      | "order.paid"
      | "shipment.shipped"
      | "shipment.delivered"
      | "invoice.accepted"
      | "credit-note.accepted"
      | "refund.completed";
    topic: "orders" | "fulfillment" | "fiscal";
    operationId: string;
    shipmentId?: string;
    refundId?: string;
    document?: { kind: "invoice" | "credit-note"; id: string; fullNumber: string };
  }): Promise<void> {
    const order = await this.db.order.findUnique({
      where: { id: options.orderId },
      include: { shipments: true },
    });
    if (order?.anonymizedAt) return;
    if (!order?.emailSnapshot)
      throw new EmailValidationError("Order has no recipient email snapshot.");
    const receiptUrl = await this.receiptUrl(order.id);
    const variables: Record<string, string> = {
      orderNumber: order.orderNumber,
      storeName: this.options.storeName,
      totalCop: formatCopCents(order.totalCents),
      receiptUrl,
      trackingCode: "",
      documentNumber: "",
      documentUrl: "",
    };
    if (options.shipmentId) {
      const shipment = order.shipments.find((candidate) => candidate.id === options.shipmentId);
      if (!shipment) throw new EmailValidationError("Shipment does not belong to the order.");
      if (options.templateKey === "shipment.shipped" && !shipment.trackingCode)
        throw new EmailValidationError(
          "Shipment tracking code is unavailable for its notification.",
        );
      variables.trackingCode = shipment.trackingCode ?? "";
    }
    if (options.document) {
      variables.documentNumber = options.document.fullNumber;
      variables.documentUrl = await this.receiptUrl(order.id, options.document);
    }
    if (options.refundId) {
      const refund = await this.db.orderRefund.findUniqueOrThrow({
        where: { id: options.refundId },
      });
      variables.totalCop = formatCopCents(refund.totalCents);
    }
    const template = (await import("./email-templates.js")).defaultEmailTemplate(
      options.templateKey,
    );
    const values = Object.fromEntries(
      template.variables
        .filter((key) => key !== "unsubscribeUrl")
        .map((key) => {
          const value = variables[key];
          if (typeof value !== "string" || !value)
            throw new EmailValidationError(`Missing domain email variable ${key}.`);
          return [key, value];
        }),
    );
    await this.options.email.queue({
      orderId: order.id,
      credentialId: await this.emailCredentialId(),
      templateKey: options.templateKey,
      topic: options.topic,
      recipientEmail: order.emailSnapshot,
      idempotencyKey: `domain:${options.templateKey}:${options.operationId}`,
      variables: values,
    });
  }

  private async queueCartRecoveryEmail(event: DomainOutbox): Promise<void> {
    const cartId = this.id(event, "cartId");
    const activityValue = this.payload(event).lastActivityAt;
    if (typeof activityValue !== "string") {
      throw new EmailValidationError("Cart abandonment activity timestamp is missing.");
    }
    const activityAt = new Date(activityValue);
    if (Number.isNaN(activityAt.getTime()) || activityAt.toISOString() !== activityValue) {
      throw new EmailValidationError("Cart abandonment activity timestamp is invalid.");
    }
    const abandoned = await this.db.abandonedCart.findUnique({
      where: { cartId },
      include: {
        customer: true,
        cart: {
          select: {
            status: true,
            kind: true,
            itemCount: true,
            totalCents: true,
            order: { select: { id: true } },
          },
        },
      },
    });
    const growth = new GrowthService(this.db);
    if (!abandoned) return;
    const record = (outcome: "QUEUED" | "NO_CONTACT" | "NO_CONSENT" | "SUPPRESSED" | "STALE") =>
      growth.recordCartReminderOutcome({
        abandonedCartId: abandoned.id,
        lastActivityAt: abandoned.lastActivityAt,
        outcome,
      });
    if (
      abandoned.status !== "DETECTED" ||
      abandoned.lastActivityAt.toISOString() !== activityValue ||
      abandoned.cart.status !== "ACTIVE" ||
      abandoned.cart.kind === "B2B" ||
      abandoned.cart.order !== null
    ) {
      await record("STALE");
      return;
    }
    if (
      !abandoned.customer ||
      abandoned.customer.status !== "ACTIVE" ||
      abandoned.customer.deletedAt !== null ||
      abandoned.contactEmail !== abandoned.customer.email
    ) {
      await record("NO_CONTACT");
      return;
    }
    if (!(await growth.marketingEmailGranted(abandoned.customer.id))) {
      await record("NO_CONSENT");
      return;
    }
    try {
      const queued = await this.options.email.queue({
        customerId: abandoned.customer.id,
        abandonedCartId: abandoned.id,
        credentialId: await this.emailCredentialId(),
        templateKey: "cart.recovery",
        topic: "cart-recovery",
        recipientEmail: abandoned.customer.email,
        idempotencyKey: `domain:cart.recovery:${abandoned.id}:${activityValue}`,
        variables: {
          storeName: this.options.storeName,
          itemCount: String(abandoned.cart.itemCount),
          totalCop: formatCopCents(abandoned.cart.totalCents),
          cartUrl: `${this.publicSiteUrl}/carrito`,
        },
      });
      await record(queued.status === "SUPPRESSED" ? "SUPPRESSED" : "QUEUED");
    } catch (error) {
      if (
        !(error instanceof EmailConflictError) ||
        !["NO_CONTACT", "NO_CONSENT", "STALE"].includes(error.code)
      ) {
        throw error;
      }
      await record(error.code as "NO_CONTACT" | "NO_CONSENT" | "STALE");
    }
  }

  private async queueLifecycleEmail(event: DomainOutbox): Promise<void> {
    const dispatchVersion = this.payload(event).dispatchVersion;
    if (
      typeof dispatchVersion !== "number" ||
      !Number.isInteger(dispatchVersion) ||
      dispatchVersion < 1
    ) {
      throw new EmailValidationError("Lifecycle dispatch version is invalid.");
    }
    await this.options.email.queueLifecycle({
      lifecycleMessageId: this.id(event, "lifecycleMessageId"),
      ...(dispatchVersion !== undefined ? { dispatchVersion: dispatchVersion as number } : {}),
      credentialId: await this.emailCredentialId(),
      storeName: this.options.storeName,
      accountUrl: `${this.publicSiteUrl}/mi-cuenta`,
    });
  }

  private statusLabel(status: string): string {
    const labels: Record<string, string> = {
      REQUESTED: "Solicitud recibida",
      AWAITING_RETURN: "Aprobada, pendiente de recibir el producto",
      RECEIVED: "Producto recibido",
      COMPLETED: "Completada",
      REJECTED: "Rechazada",
      CANCELLED: "Cancelada",
      UNDER_REVIEW: "En revisión técnica",
      APPROVED: "Aprobada",
      RESOLVED: "Resuelta",
      OPEN: "Abierta",
      IN_PROGRESS: "En gestión",
      WAITING_CUSTOMER: "En espera de tu respuesta",
      CLOSED: "Cerrada",
    };
    const label = labels[status];
    if (!label) throw new EmailValidationError(`Unsupported post-sale status ${status}.`);
    return label;
  }

  private async queuePostsaleEmail(event: DomainOutbox): Promise<void> {
    const isReturn = event.eventType.startsWith("postsale.return.");
    const entity = isReturn
      ? await this.db.returnRequest.findUnique({
          where: { id: this.id(event, "returnRequestId") },
          include: { order: true },
        })
      : await this.db.warrantyClaim.findUnique({
          where: { id: this.id(event, "warrantyClaimId") },
          include: { order: true },
        });
    if (!entity?.order.emailSnapshot || entity.order.anonymizedAt) return;
    const caseKind = isReturn
      ? "kind" in entity && entity.kind === "EXCHANGE"
        ? "cambio"
        : "devolución"
      : "garantía";
    const accessUrl = (await this.receiptUrl(entity.orderId)).replace("/recibo/", "/pedido/");
    await this.options.email.queue({
      orderId: entity.orderId,
      credentialId: await this.emailCredentialId(),
      templateKey: "postsale.updated",
      topic: "support",
      recipientEmail: entity.order.emailSnapshot,
      idempotencyKey: `domain:postsale.updated:${event.id}`,
      variables: {
        caseId: entity.id,
        caseKind,
        orderNumber: entity.order.orderNumber,
        statusLabel: this.statusLabel(entity.status),
        storeName: this.options.storeName,
        accessUrl,
      },
    });
  }

  private async queueSupportEmail(event: DomainOutbox): Promise<void> {
    const ticket = await this.db.supportTicket.findUnique({
      where: { id: this.id(event, "supportTicketId") },
    });
    if (!ticket || ticket.contactEmailSnapshot.endsWith("@anonymized.invalid")) return;
    const supportUrl = ticket.orderId
      ? (await this.receiptUrl(ticket.orderId)).replace("/recibo/", "/pedido/")
      : `${this.publicSiteUrl}/mi-cuenta/soporte`;
    await this.options.email.queue({
      ...(ticket.orderId ? { orderId: ticket.orderId } : {}),
      credentialId: await this.emailCredentialId(),
      templateKey: "support.ticket",
      topic: "support",
      recipientEmail: ticket.contactEmailSnapshot,
      idempotencyKey: `domain:support.ticket:${event.id}`,
      variables: {
        ticketNumber: ticket.ticketNumber,
        statusLabel: this.statusLabel(ticket.status),
        storeName: this.options.storeName,
        supportUrl,
      },
    });
  }

  private async prepareInvoiceIfRequired(orderId: string): Promise<void> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: { taxRegime: true },
    });
    if (order?.taxRegime === "RESPONSABLE_IVA") await this.options.invoice.prepareInvoice(orderId);
  }

  private async prepareCreditNoteIfRequired(refundId: string): Promise<void> {
    const refund = await this.db.orderRefund.findUnique({
      where: { id: refundId },
      select: {
        order: {
          select: {
            taxRegime: true,
            taxInvoice: { select: { id: true } },
          },
        },
      },
    });
    if (!refund) throw new InvoiceNotFoundError("Order refund not found.");
    if (refund.order.taxRegime === "RESPONSABLE_IVA" || refund.order.taxInvoice !== null) {
      await this.options.invoice.prepareCreditNote(refundId);
    }
  }

  private async independently(operations: readonly (() => Promise<void>)[]): Promise<void> {
    let firstError: unknown = null;
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async handle(event: DomainOutbox): Promise<void> {
    switch (event.eventType) {
      case "cart.abandoned.v1":
        await this.queueCartRecoveryEmail(event);
        return;
      case "lifecycle.enrollment.started.v1":
        return;
      case "lifecycle.message.dispatch.v1":
        await this.queueLifecycleEmail(event);
        return;
      case "order.confirmed.v1":
        await this.queueOrderEmail({
          orderId: this.id(event, "orderId"),
          templateKey: "order.confirmed",
          topic: "orders",
          operationId: event.aggregateId,
        });
        return;
      case "order.payment.paid.v1": {
        const orderId = this.id(event, "orderId");
        const paidAtValue = this.payload(event).paidAt;
        if (typeof paidAtValue !== "string") {
          throw new EmailValidationError("Order payment timestamp is missing.");
        }
        const paidAt = new Date(paidAtValue);
        if (Number.isNaN(paidAt.getTime()) || paidAt.toISOString() !== paidAtValue) {
          throw new EmailValidationError("Order payment timestamp is invalid.");
        }
        await this.independently([
          () => this.options.shipping.ensureFulfillments(orderId).then(() => undefined),
          () => this.prepareInvoiceIfRequired(orderId),
          () =>
            this.queueOrderEmail({
              orderId,
              templateKey: "order.paid",
              topic: "orders",
              operationId: event.aggregateId,
            }),
          async () => {
            await this.options.metaCapi?.enqueuePurchase({ orderId, paidAt });
          },
        ]);
        return;
      }
      case "payment.late-review-required.v1": {
        const match = /^payment-webhook:([0-9a-f]{64}):late-review:v1$/.exec(
          event.deduplicationKey,
        );
        if (!match?.[1]) {
          throw new EmailValidationError("Late payment review event key is invalid.");
        }
        await new OperationsService(this.db).openLatePaymentReview({
          attemptId: this.id(event, "attemptId"),
          orderId: this.id(event, "orderId"),
          eventKey: match[1],
        });
        return;
      }
      case "order.payment.partial-expired-review-required.v1":
        await new OperationsService(this.db).openPartialPaymentReview({
          orderId: this.id(event, "orderId"),
        });
        return;
      case "order.receipt.emission_blocked.v1":
        await new OperationsService(this.db).openOrderReceiptAlert({
          orderId: this.id(event, "orderId"),
          kind: "emission_blocked",
        });
        return;
      case "order.receipt.integrity_failed.v1":
        await new OperationsService(this.db).openOrderReceiptAlert({
          orderId: this.id(event, "orderId"),
          kind: "integrity_failed",
        });
        return;
      case "meta.capi.dispatch.v1": {
        if (!this.options.metaCapi) {
          throw new MetaCapiServiceError("VALIDATION", "Meta CAPI worker is not configured.");
        }
        const result = await this.options.metaCapi.dispatch(
          this.id(event, "metaEventId"),
          this.options.workerId,
        );
        if (
          (result.status === "PENDING" ||
            result.status === "IN_FLIGHT" ||
            result.status === "DEFERRED") &&
          result.nextAttemptAt
        ) {
          throw new RetryableDomainEventError(result.nextAttemptAt);
        }
        return;
      }
      case "order.refund.completed.v1": {
        const orderId = this.id(event, "orderId");
        const refundId = this.id(event, "refundId");
        await this.independently([
          () => this.prepareCreditNoteIfRequired(refundId),
          () =>
            this.queueOrderEmail({
              orderId,
              refundId,
              templateKey: "refund.completed",
              topic: "orders",
              operationId: refundId,
            }),
        ]);
        return;
      }
      case "shipping.label.requested.v1": {
        try {
          const result = await this.options.shipping.processLabel(
            this.id(event, "packageId"),
            this.options.workerId,
          );
          if (result.status === "RECONCILING") return;
          return;
        } catch (error) {
          if (error instanceof ShippingConflictError && error.code === "SIBLING_CLAIM_ACTIVE") {
            throw new RetryableDomainEventError(new Date(Date.now() + 30_000));
          }
          throw error;
        }
      }
      case "shipping.provider.uncertain.v1":
        await this.options.shipping.reconcileLabel(
          this.id(event, "packageId"),
          this.options.workerId,
        );
        return;
      case "shipping.shipment.shipped.v1":
      case "shipping.shipment.delivered.v1": {
        const orderId = this.id(event, "orderId");
        const shipmentId = this.id(event, "shipmentId");
        await this.queueOrderEmail({
          orderId,
          shipmentId,
          templateKey:
            event.eventType === "shipping.shipment.shipped.v1"
              ? "shipment.shipped"
              : "shipment.delivered",
          topic: "fulfillment",
          operationId: shipmentId,
        });
        return;
      }
      case "email.requested.v1": {
        const outcome = await this.options.email.send(this.id(event, "emailEventId"));
        if (outcome.deferredByPause && outcome.nextAttemptAt)
          throw new PausedDomainEventError(outcome.nextAttemptAt);
        if (outcome.status === "SENDING" && outcome.nextAttemptAt)
          throw new RetryableDomainEventError(outcome.nextAttemptAt);
        return;
      }
      case "invoice.transmission.requested.v1": {
        const result = await this.options.invoice.transmitInvoice(
          this.id(event, "invoiceId"),
          this.options.workerId,
        );
        if (result.status === "UNCERTAIN")
          throw new RetryableDomainEventError(new Date(Date.now() + 60_000));
        return;
      }
      case "credit-note.transmission.requested.v1": {
        const result = await this.options.invoice.transmitCreditNote(
          this.id(event, "creditNoteId"),
          this.options.workerId,
        );
        if (result.status === "UNCERTAIN")
          throw new RetryableDomainEventError(new Date(Date.now() + 60_000));
        return;
      }
      case "invoice.accepted.v1": {
        const invoice = await this.db.taxInvoice.findUniqueOrThrow({
          where: { id: this.id(event, "invoiceId") },
        });
        await this.queueOrderEmail({
          orderId: invoice.orderId,
          templateKey: "invoice.accepted",
          topic: "fiscal",
          operationId: invoice.id,
          document: { kind: "invoice", id: invoice.id, fullNumber: invoice.fullNumber },
        });
        return;
      }
      case "credit-note.accepted.v1": {
        const note = await this.db.creditNote.findUniqueOrThrow({
          where: { id: this.id(event, "creditNoteId") },
          include: { invoice: true },
        });
        await this.queueOrderEmail({
          orderId: note.invoice.orderId,
          templateKey: "credit-note.accepted",
          topic: "fiscal",
          operationId: note.id,
          document: { kind: "credit-note", id: note.id, fullNumber: note.fullNumber },
        });
        return;
      }
      case "postsale.return.requested.v1":
      case "postsale.return.status.v1":
      case "postsale.warranty.requested.v1":
      case "postsale.warranty.status.v1":
        await this.queuePostsaleEmail(event);
        return;
      case "support.ticket.created.v1":
      case "support.ticket.updated.v1":
        await this.queueSupportEmail(event);
        return;
      case "customer.auth-erasure.requested.v1": {
        if (!this.options.eraseAuthUser) {
          throw new EmailValidationError("Auth erasure is not configured in the domain worker.");
        }
        await this.options.eraseAuthUser(this.id(event, "authUserId"));
        return;
      }
      case "cart.expired.v1":
      case "order.cancelled.v1":
      case "order.refund.requested.v1":
      case "shipping.fulfillment.created.v1":
      case "shipping.label.generated.v1":
      case "invoice.rejected.v1":
      case "credit-note.rejected.v1":
        return;
      default:
        throw new EmailValidationError(`Unsupported domain event type ${event.eventType}.`);
    }
  }

  private retryAt(attempts: number): Date {
    return new Date(Date.now() + Math.min(900_000, 5_000 * 2 ** Math.min(attempts, 8)));
  }

  private errorText(error: unknown): string {
    if (
      error instanceof ShippingProviderError ||
      error instanceof EmailProviderError ||
      error instanceof InvoiceProviderError ||
      error instanceof MetaCapiServiceError ||
      error instanceof ShippingConflictError ||
      error instanceof InvoiceConflictError
    )
      return `${error.name}:${error.code}`.slice(0, 500);
    if (
      error instanceof ShippingValidationError ||
      error instanceof EmailValidationError ||
      error instanceof InvoiceValidationError
    )
      return error.name;
    if (error instanceof Error) return error.name.slice(0, 500);
    return "Error";
  }

  async runBatch(limit = 25): Promise<DomainEventBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("limit must be between 1 and 100.");
    const events = await claimDomainOutboxEvents(this.db, {
      workerId: this.options.workerId,
      eventTypes: supportedEvents,
      limit,
    });
    const batchStartedAtMs = Date.now();
    const leaseSafetyMarginMs = 5_000;
    let completed = 0;
    let retries = 0;
    let failed = 0;
    for (const event of events) {
      const estimatedNowMs = event.claimedAt
        ? event.claimedAt.getTime() + Math.max(0, Date.now() - batchStartedAtMs)
        : Date.now();
      if (
        event.claimExpiresAt &&
        event.claimExpiresAt.getTime() <= estimatedNowMs + leaseSafetyMarginMs
      ) {
        break;
      }
      try {
        await this.handle(event);
        if (
          !(await completeDomainOutbox(this.db, { id: event.id, workerId: this.options.workerId }))
        )
          throw new Error("Domain outbox claim expired before completion.");
        completed += 1;
      } catch (error) {
        if (error instanceof PausedDomainEventError) {
          const deferredCount = await this.db.$executeRaw`
            UPDATE "DomainOutbox"
            SET "availableAt" = ${error.availableAt},
                "claimedAt" = NULL,
                "claimedBy" = NULL,
                "claimExpiresAt" = NULL,
                "attempts" = GREATEST(0, "attempts" - 1),
                "lastError" = 'PAUSED'
            WHERE "id" = ${event.id}::uuid
              AND "claimedBy" = ${this.options.workerId}
              AND "claimExpiresAt" > CURRENT_TIMESTAMP
              AND "processedAt" IS NULL
              AND "failedAt" IS NULL
          `;
          if (deferredCount > 0) retries += 1;
        } else if (event.attempts >= this.maximumAttempts) {
          const failedNow = await failDomainOutbox(this.db, {
            id: event.id,
            workerId: this.options.workerId,
            error: this.errorText(error),
          });
          if (failedNow) {
            if (event.eventType === "lifecycle.message.dispatch.v1") {
              const messageId = recordValue(event.payload)?.lifecycleMessageId;
              if (typeof messageId === "string") {
                await new LifecycleService(this.db).markDispatchFailed(
                  messageId,
                  this.errorText(error),
                );
              }
            } else if (event.eventType === "email.requested.v1") {
              const payload = recordValue(event.payload);
              const emailEventId = payload?.emailEventId;
              const messageId = payload?.lifecycleMessageId;
              if (typeof emailEventId === "string" && /^[0-9a-f-]{36}$/i.test(emailEventId)) {
                const failureCode = this.errorText(error);
                await this.db.emailEvent.updateMany({
                  where: { id: emailEventId, status: { in: ["QUEUED", "SENDING"] } },
                  data: {
                    status: "FAILED",
                    statusRank: 70,
                    finalAt: new Date(),
                    nextAttemptAt: null,
                    lastError: failureCode,
                  },
                });
                if (typeof messageId === "string" && /^[0-9a-f-]{36}$/i.test(messageId)) {
                  await new LifecycleService(this.db).markEmailFailed(
                    messageId,
                    emailEventId,
                    failureCode,
                  );
                }
              }
            }
            failed += 1;
          }
        } else {
          const requestedAt =
            error instanceof RetryableDomainEventError
              ? error.availableAt
              : this.retryAt(event.attempts);
          const pgNow = await databaseTimestamp(this.db);
          const minAvailableMs = pgNow.getTime() + 5_000;
          const maxAvailableMs = pgNow.getTime() + 23 * 3_600_000;
          const availableAt = new Date(
            Math.min(maxAvailableMs, Math.max(minAvailableMs, requestedAt.getTime())),
          );
          const retriedNow = await retryDomainOutbox(this.db, {
            id: event.id,
            workerId: this.options.workerId,
            availableAt,
            error: this.errorText(error),
          });
          if (retriedNow) retries += 1;
        }
      }
    }
    return { claimed: events.length, completed, retries, failed };
  }
}
