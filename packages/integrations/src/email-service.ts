import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { normalizeEmail } from "@mundonettech/core";
import {
  IdempotencyStatus,
  LifecycleService,
  acquireIdempotencyKey,
  acquireOperationLocks,
  completeIdempotencyKey,
  hasUniqueViolation,
  marketingEmailConsentGranted,
  type EmailEvent,
  type EmailEventStatus,
} from "@mundonettech/db";

import {
  defaultEmailTemplate,
  renderEmailTemplate,
  validateEmailTemplate,
} from "./email-templates.js";
import {
  EmailConflictError,
  EmailNotFoundError,
  EmailProviderError,
  EmailValidationError,
  type EmailAuditContext,
  type EmailCredentials,
  type EmailProvider,
  type EmailQueueInput,
  type EmailServiceOptions,
  type EmailTemplateInput,
} from "./email-types.js";
import {
  assertIntegrationKey,
  assertIntegrationUuid,
  hash32,
  integrationDigest,
  publicHttpsUrl,
} from "./integration-utils.js";
import { parseEmailCredentials, ResendEmailProvider } from "./resend.js";
import { verifySvixWebhook } from "./svix.js";

export interface EmailSendOutcome {
  readonly id: string;
  readonly status: string;
  readonly providerMessageId: string | null;
  readonly nextAttemptAt: Date | null;
  readonly deferredByPause?: boolean;
}

const templateWriters = new Set(["SUPERADMIN", "OPERATIONS_MANAGER", "STORE_MANAGER"]);
const finalStatuses = new Set(["BOUNCED", "COMPLAINED", "SUPPRESSED", "CANCELLED", "FAILED"]);

function templateKey(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{1,79}$/.test(value))
    throw new EmailValidationError("templateKey is invalid.");
  return value;
}

function topicKey(value: string): string {
  return templateKey(value);
}

function statusRank(status: string): number {
  const ranks: Record<string, number> = {
    QUEUED: 0,
    SENDING: 10,
    SENT: 20,
    DELIVERY_DELAYED: 25,
    DELIVERED: 30,
    BOUNCED: 50,
    COMPLAINED: 60,
    SUPPRESSED: 70,
    CANCELLED: 70,
    FAILED: 70,
  };
  const rank = ranks[status];
  if (rank === undefined) throw new EmailValidationError("Unsupported email status.");
  return rank;
}

function errorCode(error: unknown): string {
  return error instanceof EmailProviderError ? error.code : "PROVIDER_FAILURE";
}

function matchesPayloadHash(stored: Uint8Array, incoming: Uint8Array): boolean {
  const left = Buffer.from(stored);
  const right = Buffer.from(incoming);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSvixEventUniqueConflict(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "P2002" ||
    !("meta" in error) ||
    typeof error.meta !== "object" ||
    error.meta === null ||
    !("target" in error.meta)
  ) {
    return false;
  }
  const rawTarget = error.meta.target;
  const target = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
  if (target.some((entry) => typeof entry !== "string")) return false;
  const fields = target.map((entry) => String(entry).trim());
  if (fields.length === 2 && fields.includes("credentialId") && fields.includes("svixEventId")) {
    return true;
  }
  if (fields.length !== 1) return false;
  return [
    "EmailWebhookEvent_credentialId_svixEventId_key",
    "credentialId_svixEventId",
    "credentialId,svixEventId",
    "credentialId, svixEventId",
  ].includes(fields[0]!);
}

export class EmailService {
  constructor(
    private readonly db: import("@mundonettech/db").PrismaClient,
    private readonly options: EmailServiceOptions,
  ) {
    this.options = {
      ...options,
      publicSiteUrl: publicHttpsUrl(options.publicSiteUrl, "publicSiteUrl").replace(/\/$/, ""),
    };
  }

  private async credentials(credentialId: string): Promise<EmailCredentials> {
    const plaintext = await this.options.vault.reveal(credentialId);
    try {
      return parseEmailCredentials(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  private provider(credentials: EmailCredentials): EmailProvider {
    return this.options.providerFactory?.(credentials) ?? new ResendEmailProvider(credentials);
  }

  private async assertWriter(actorAdminUserId: string): Promise<void> {
    const actor = await this.db.adminUser.findFirst({
      where: { id: actorAdminUserId, status: "ACTIVE", deletedAt: null },
      select: { role: true },
    });
    if (!actor || !templateWriters.has(actor.role))
      throw new EmailValidationError("Administrator is not authorized to manage email templates.");
  }

  async saveTemplate(input: EmailTemplateInput, audit: EmailAuditContext): Promise<string> {
    const key = templateKey(input.templateKey);
    if (key === "lifecycle.campaign") {
      throw new EmailValidationError(
        "Lifecycle campaign templates are sealed per journey step and do not accept overrides.",
      );
    }
    assertIntegrationKey(input.idempotencyKey, "idempotencyKey");
    assertIntegrationUuid(audit.actorAdminUserId, "actorAdminUserId");
    if (typeof input.publish !== "boolean") {
      throw new EmailValidationError("publish must be boolean.");
    }
    const template = validateEmailTemplate({
      templateKey: key,
      subject: input.subject,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      variables: input.variables,
    });
    await this.assertWriter(audit.actorAdminUserId);
    const scope = "email-template-save";
    const idempotency = {
      keyHash: createHash("sha256").update(input.idempotencyKey, "utf8").digest(),
      subjectHash: integrationDigest({ actorAdminUserId: audit.actorAdminUserId }),
      requestHash: integrationDigest({ ...template, publish: input.publish }),
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    };
    return this.db.$transaction(async (tx) => {
      let acquired;
      try {
        acquired = await acquireIdempotencyKey(tx, { scope, ...idempotency });
      } catch (error) {
        if (hasUniqueViolation(error)) {
          throw new EmailConflictError(
            "Email template idempotency key was already used for another request.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        throw error;
      }
      if (!acquired.acquired) {
        if (
          acquired.status === IdempotencyStatus.SUCCEEDED &&
          acquired.resultType === "EmailTemplateOverride" &&
          acquired.resultId
        ) {
          const existing = await tx.emailTemplateOverride.findUnique({
            where: { id: acquired.resultId },
          });
          if (existing?.templateKey === key && existing.locale === "es-CO") return existing.id;
        }
        throw new EmailConflictError(
          "The email template request is already in progress or its replay is inconsistent.",
          "INVALID_STATE",
        );
      }
      await acquireOperationLocks(tx, [`email-template:${key}:es-CO`]);
      const latest = await tx.emailTemplateOverride.aggregate({
        where: { templateKey: key, locale: "es-CO" },
        _max: { version: true },
      });
      const version = (latest._max.version ?? 0) + 1;
      if (version > 2_147_483_647)
        throw new EmailConflictError("Email template version sequence is exhausted.");
      if (input.publish) {
        await tx.emailTemplateOverride.updateMany({
          where: { templateKey: key, locale: "es-CO", status: "PUBLISHED" },
          data: { status: "ARCHIVED" },
        });
      }
      const created = await tx.emailTemplateOverride.create({
        data: {
          templateKey: key,
          locale: "es-CO",
          version,
          status: input.publish ? "PUBLISHED" : "DRAFT",
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          variables: [...template.variables],
          createdByAdminUserId: audit.actorAdminUserId,
        },
      });
      await tx.adminActionLog.create({
        data: {
          actorAdminUserId: audit.actorAdminUserId,
          action: input.publish ? "EMAIL_TEMPLATE_PUBLISHED" : "EMAIL_TEMPLATE_DRAFT_CREATED",
          targetType: "EmailTemplateOverride",
          targetId: created.id,
          requestId: audit.requestId ?? null,
          ipHash: hash32(audit.ipHash, "ipHash"),
          userAgentHash: audit.userAgentHash ? hash32(audit.userAgentHash, "userAgentHash") : null,
          metadata: { templateKey: key, version },
        },
      });
      const completed = await completeIdempotencyKey(tx, {
        scope,
        ...idempotency,
        status: IdempotencyStatus.SUCCEEDED,
        responseStatus: 201,
        resultType: "EmailTemplateOverride",
        resultId: created.id,
      });
      if (!completed) {
        throw new EmailConflictError("Unable to seal email template idempotency.", "INVALID_STATE");
      }
      return created.id;
    });
  }

  private unsubscribeToken(
    secret: string,
    eventId: string,
    recipientHash: Uint8Array,
    topic: string,
  ): string {
    const key = Buffer.from(secret, "base64");
    if (key.length < 32)
      throw new EmailValidationError("unsubscribeSecret must decode to at least 32 bytes.");
    const signature = createHmac("sha256", key)
      .update(`${eventId}.${Buffer.from(recipientHash).toString("hex")}.${topic}`)
      .digest("base64url");
    return `${eventId}.${signature}`;
  }

  async queue(input: EmailQueueInput): Promise<{ id: string; status: string }> {
    const key = templateKey(input.templateKey);
    const topic = topicKey(input.topic);
    assertIntegrationKey(input.idempotencyKey);
    assertIntegrationUuid(input.credentialId, "credentialId");
    if (input.orderId !== undefined) assertIntegrationUuid(input.orderId, "orderId");
    if (input.customerId !== undefined) assertIntegrationUuid(input.customerId, "customerId");
    if (input.abandonedCartId !== undefined)
      assertIntegrationUuid(input.abandonedCartId, "abandonedCartId");
    if (input.lifecycleMessageId !== undefined) {
      assertIntegrationUuid(input.lifecycleMessageId, "lifecycleMessageId");
    }
    if (
      (key === "cart.recovery" &&
        (topic !== "cart-recovery" ||
          input.orderId !== undefined ||
          input.customerId === undefined ||
          input.abandonedCartId === undefined ||
          input.lifecycleMessageId !== undefined)) ||
      (key === "lifecycle.campaign" &&
        (topic !== "lifecycle" ||
          input.orderId !== undefined ||
          input.abandonedCartId !== undefined ||
          input.customerId === undefined ||
          input.lifecycleMessageId === undefined ||
          input.templateSnapshot === undefined)) ||
      (!["cart.recovery", "lifecycle.campaign"].includes(key) &&
        (input.abandonedCartId !== undefined || input.lifecycleMessageId !== undefined)) ||
      (key !== "lifecycle.campaign" && input.templateSnapshot !== undefined)
    ) {
      throw new EmailValidationError("Email relations or template snapshot are inconsistent.");
    }
    const snapshot = input.templateSnapshot
      ? validateEmailTemplate({ ...input.templateSnapshot, templateKey: key })
      : null;
    let recipientEmail: string;
    try {
      recipientEmail = normalizeEmail(input.recipientEmail);
    } catch {
      throw new EmailValidationError("recipientEmail must be a valid normalized address.");
    }
    const recipientHash = createHash("sha256").update(recipientEmail, "utf8").digest();
    const existing = await this.db.emailEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      let sameSnapshot = true;
      if (snapshot) {
        const unsubscribeUrl = (existing.variablesSnapshot as Record<string, unknown>)
          .unsubscribeUrl;
        if (typeof unsubscribeUrl !== "string") {
          throw new EmailConflictError(
            "Stored lifecycle email is missing its unsubscribe URL.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        const rendered = renderEmailTemplate(snapshot, {
          ...input.variables,
          unsubscribeUrl,
        });
        sameSnapshot =
          existing.subjectSnapshot === rendered.subject &&
          existing.htmlBodySnapshot === rendered.htmlBody &&
          existing.textBodySnapshot === rendered.textBody;
      }
      const same =
        existing.templateKey === key &&
        existing.topic === topic &&
        existing.recipientEmail === recipientEmail &&
        existing.credentialId === input.credentialId &&
        (existing.orderId ?? null) === (input.orderId ?? null) &&
        (existing.customerId ?? null) === (input.customerId ?? null) &&
        (existing.abandonedCartId ?? null) === (input.abandonedCartId ?? null) &&
        (existing.lifecycleMessageId ?? null) === (input.lifecycleMessageId ?? null) &&
        sameSnapshot &&
        Object.entries(input.variables).every(
          ([name, value]) =>
            (existing.variablesSnapshot as Record<string, unknown>)[name] === value,
        );
      if (!same)
        throw new EmailConflictError(
          "Email idempotency key was already used for another message.",
          "IDEMPOTENCY_CONFLICT",
        );
      if (input.lifecycleMessageId) {
        await new LifecycleService(this.db).markQueued(
          input.lifecycleMessageId,
          existing.id,
          existing.status,
        );
      }
      return { id: existing.id, status: existing.status };
    }
    const credentials = await this.credentials(input.credentialId);
    const override = snapshot
      ? null
      : await this.db.emailTemplateOverride.findFirst({
          where: { templateKey: key, locale: "es-CO", status: "PUBLISHED" },
        });
    let variables: readonly string[];
    if (override) {
      if (
        !Array.isArray(override.variables) ||
        override.variables.some((value) => typeof value !== "string")
      )
        throw new EmailValidationError("Stored email template variables are invalid.");
      variables = override.variables as string[];
    } else {
      variables = snapshot?.variables ?? defaultEmailTemplate(key).variables;
    }
    const baseTemplate = snapshot
      ? snapshot
      : override
        ? {
            templateKey: key,
            subject: override.subject,
            htmlBody: override.htmlBody,
            textBody: override.textBody,
            variables,
          }
        : defaultEmailTemplate(key);
    const eventId = randomUUID();
    const token = this.unsubscribeToken(
      credentials.unsubscribeSecret,
      eventId,
      recipientHash,
      topic,
    );
    const unsubscribeUrl = `${this.options.publicSiteUrl}/email/baja/${encodeURIComponent(token)}`;
    const values = { ...input.variables, unsubscribeUrl };
    for (const [name, value] of Object.entries(values)) {
      if (name.endsWith("Url")) publicHttpsUrl(value, `variables.${name}`);
    }
    const rendered = renderEmailTemplate(baseTemplate, values);
    const suppression = await this.db.emailSuppression.findUnique({
      where: { recipientHash_topic: { recipientHash, topic } },
    });
    return this.db.$transaction(async (tx) => {
      const created = await tx.emailEvent.create({
        data: {
          id: eventId,
          orderId: input.orderId ?? null,
          customerId: input.customerId ?? null,
          abandonedCartId: input.abandonedCartId ?? null,
          lifecycleMessageId: input.lifecycleMessageId ?? null,
          credentialId: input.credentialId,
          templateKey: key,
          topic,
          subjectSnapshot: rendered.subject,
          htmlBodySnapshot: rendered.htmlBody,
          textBodySnapshot: rendered.textBody,
          variablesSnapshot: values,
          recipientEmail,
          recipientHash,
          idempotencyKey: input.idempotencyKey,
          unsubscribeTokenHash: createHash("sha256").update(token).digest(),
          status: suppression ? "SUPPRESSED" : "QUEUED",
          statusRank: suppression ? statusRank("SUPPRESSED") : statusRank("QUEUED"),
          finalAt: suppression ? new Date() : null,
        },
      });
      if (!suppression) {
        await tx.domainOutbox.create({
          data: {
            eventType: "email.requested.v1",
            aggregateType: "EmailEvent",
            aggregateId: created.id,
            deduplicationKey: `email:${created.id}:requested:v1`,
            payload: {
              emailEventId: created.id,
              ...(input.orderId ? { orderId: input.orderId } : {}),
              ...(input.lifecycleMessageId ? { lifecycleMessageId: input.lifecycleMessageId } : {}),
            },
          },
        });
      }
      if (input.lifecycleMessageId) {
        await new LifecycleService(tx).markQueued(
          input.lifecycleMessageId,
          created.id,
          created.status,
        );
      }
      return { id: created.id, status: created.status };
    });
  }

  async queueLifecycle(options: {
    readonly lifecycleMessageId: string;
    readonly dispatchVersion?: number;
    readonly credentialId: string;
    readonly storeName: string;
    readonly accountUrl: string;
  }): Promise<{ id: string; status: string } | null> {
    assertIntegrationUuid(options.lifecycleMessageId, "lifecycleMessageId");
    assertIntegrationUuid(options.credentialId, "credentialId");
    publicHttpsUrl(options.accountUrl, "accountUrl");
    const idempotencyKey = `domain:lifecycle.campaign:${options.lifecycleMessageId}`;
    const existing = await this.db.emailEvent.findUnique({ where: { idempotencyKey } });
    if (existing) {
      await new LifecycleService(this.db).markQueued(
        options.lifecycleMessageId,
        existing.id,
        existing.status,
      );
      return { id: existing.id, status: existing.status };
    }
    const credentials = await this.credentials(options.credentialId);
    return this.db.$transaction(async (tx) => {
      const lifecycle = new LifecycleService(tx);
      const alreadyQueued = await tx.emailEvent.findUnique({ where: { idempotencyKey } });
      if (alreadyQueued) {
        await lifecycle.markQueued(
          options.lifecycleMessageId,
          alreadyQueued.id,
          alreadyQueued.status,
        );
        return { id: alreadyQueued.id, status: alreadyQueued.status };
      }
      const message = await lifecycle.dispatch(options.lifecycleMessageId, options.dispatchVersion);
      if (!message) return null;
      const snapshot = validateEmailTemplate({
        templateKey: "lifecycle.campaign",
        subject: message.step.subject,
        htmlBody: message.step.htmlBody,
        textBody: message.step.textBody,
        variables: message.step.variables,
      });
      let recipientEmail: string;
      try {
        recipientEmail = normalizeEmail(message.recipientEmail);
      } catch {
        throw new EmailValidationError("recipientEmail must be a valid normalized address.");
      }
      const recipientHash = createHash("sha256").update(recipientEmail, "utf8").digest();
      const eventId = randomUUID();
      const token = this.unsubscribeToken(
        credentials.unsubscribeSecret,
        eventId,
        recipientHash,
        "lifecycle",
      );
      const unsubscribeUrl = `${this.options.publicSiteUrl}/email/baja/${encodeURIComponent(token)}`;
      const availableValues: Record<string, string> = {
        storeName: options.storeName,
        customerFirstName: message.customerFirstName,
        accountUrl: options.accountUrl,
        unsubscribeUrl,
      };
      const values = Object.fromEntries(
        snapshot.variables.map((variable) => {
          const value = availableValues[variable];
          if (typeof value !== "string") {
            throw new EmailValidationError(`Missing lifecycle email variable ${variable}.`);
          }
          if (variable.endsWith("Url")) publicHttpsUrl(value, `variables.${variable}`);
          return [variable, value];
        }),
      );
      const rendered = renderEmailTemplate(snapshot, values);
      const suppression = await tx.emailSuppression.findUnique({
        where: { recipientHash_topic: { recipientHash, topic: "lifecycle" } },
      });
      const created = await tx.emailEvent.create({
        data: {
          id: eventId,
          customerId: message.customerId,
          lifecycleMessageId: message.id,
          credentialId: options.credentialId,
          templateKey: "lifecycle.campaign",
          topic: "lifecycle",
          subjectSnapshot: rendered.subject,
          htmlBodySnapshot: rendered.htmlBody,
          textBodySnapshot: rendered.textBody,
          variablesSnapshot: values,
          recipientEmail,
          recipientHash,
          idempotencyKey,
          unsubscribeTokenHash: createHash("sha256").update(token).digest(),
          status: suppression ? "SUPPRESSED" : "QUEUED",
          statusRank: suppression ? statusRank("SUPPRESSED") : statusRank("QUEUED"),
          finalAt: suppression ? new Date() : null,
        },
      });
      if (!suppression) {
        await tx.domainOutbox.create({
          data: {
            eventType: "email.requested.v1",
            aggregateType: "EmailEvent",
            aggregateId: created.id,
            deduplicationKey: `email:${created.id}:requested:v1`,
            payload: {
              emailEventId: created.id,
              lifecycleMessageId: message.id,
            },
          },
        });
      }
      await lifecycle.markQueued(message.id, created.id, created.status);
      return { id: created.id, status: created.status };
    });
  }

  private async suppressedBeforeSend(claimed: EmailEvent): Promise<EmailSendOutcome | null> {
    const suppression = await this.db.emailSuppression.findUnique({
      where: {
        recipientHash_topic: { recipientHash: claimed.recipientHash, topic: claimed.topic },
      },
      select: { id: true },
    });
    let outcome: "SUPPRESSED" | "NO_CONSENT" | "STALE" | null = suppression ? "SUPPRESSED" : null;
    let abandonedCartId: string | null = null;
    let lastActivityAt: Date | null = null;
    let lifecycleReason:
      | "CONSENT_REVOKED"
      | "CUSTOMER_INACTIVE"
      | "SEGMENT_EXITED"
      | "JOURNEY_ARCHIVED"
      | "SUPPRESSED"
      | null = null;
    const lifecycle = new LifecycleService(this.db);
    if (!outcome && claimed.templateKey === "lifecycle.campaign" && claimed.lifecycleMessageId) {
      const eligibility = await lifecycle.messageEligibility(claimed.lifecycleMessageId);
      if (eligibility.reason !== "ELIGIBLE") {
        outcome = "SUPPRESSED";
        lifecycleReason =
          eligibility.reason === "CUSTOMER_INACTIVE"
            ? "CUSTOMER_INACTIVE"
            : eligibility.reason === "SEGMENT_EXITED"
              ? "SEGMENT_EXITED"
              : eligibility.reason === "JOURNEY_ARCHIVED"
                ? "JOURNEY_ARCHIVED"
                : eligibility.reason === "SUPPRESSED"
                  ? "SUPPRESSED"
                  : "CONSENT_REVOKED";
      }
    }
    if (!outcome && claimed.templateKey === "cart.recovery") {
      const abandoned = claimed.abandonedCartId
        ? await this.db.abandonedCart.findUnique({
            where: { id: claimed.abandonedCartId },
            include: {
              customer: true,
              cart: { select: { status: true, order: { select: { id: true } } } },
            },
          })
        : null;
      const activityPrefix = `domain:cart.recovery:${claimed.abandonedCartId}:`;
      const activityAt = claimed.idempotencyKey.startsWith(activityPrefix)
        ? claimed.idempotencyKey.slice(activityPrefix.length)
        : null;
      abandonedCartId = abandoned?.id ?? null;
      lastActivityAt = abandoned?.lastActivityAt ?? null;
      const stale =
        !abandoned ||
        abandoned.status !== "DETECTED" ||
        abandoned.cart.status !== "ACTIVE" ||
        abandoned.cart.order !== null ||
        !abandoned.customer ||
        abandoned.customer.id !== claimed.customerId ||
        abandoned.customer.status !== "ACTIVE" ||
        abandoned.customer.deletedAt !== null ||
        abandoned.customer.email !== claimed.recipientEmail ||
        typeof activityAt !== "string" ||
        abandoned.lastActivityAt.toISOString() !== activityAt;
      if (stale) {
        outcome = "STALE";
      } else if (!(await marketingEmailConsentGranted(this.db, abandoned.customer!.id))) {
        outcome = "NO_CONSENT";
      }
    }
    if (!outcome) return null;
    const nowRows = await this.db.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const now = nowRows[0]!.now;
    const current = await this.db.$transaction(async (tx) => {
      await tx.emailEvent.updateMany({
        where: { id: claimed.id, status: { in: ["QUEUED", "SENDING"] } },
        data: {
          status: "SUPPRESSED",
          statusRank: statusRank("SUPPRESSED"),
          finalAt: now,
          nextAttemptAt: null,
        },
      });
      if (abandonedCartId && lastActivityAt) {
        await tx.abandonedCart.updateMany({
          where: { id: abandonedCartId, lastActivityAt },
          data: { lastReminderActivityAt: lastActivityAt, lastReminderOutcome: outcome },
        });
      }
      return tx.emailEvent.findUniqueOrThrow({ where: { id: claimed.id } });
    });
    if (claimed.templateKey === "lifecycle.campaign" && claimed.lifecycleMessageId) {
      await lifecycle.markEmailSuppressed(
        claimed.lifecycleMessageId,
        lifecycleReason ?? "SUPPRESSED",
      );
    }
    return {
      id: current.id,
      status: current.status,
      providerMessageId: current.providerMessageId,
      nextAttemptAt: current.nextAttemptAt,
    };
  }

  private async reconcileLifecycleTerminal(claimed: EmailEvent): Promise<void> {
    if (!claimed.lifecycleMessageId) return;
    const lifecycle = new LifecycleService(this.db);
    if (["SENT", "DELIVERY_DELAYED", "DELIVERED"].includes(claimed.status)) {
      await lifecycle.markEmailSent(claimed.lifecycleMessageId, claimed.id);
    } else if (claimed.status === "FAILED") {
      await lifecycle.markEmailFailed(
        claimed.lifecycleMessageId,
        claimed.id,
        claimed.lastError ?? "PROVIDER_FAILURE",
      );
    } else if (["BOUNCED", "COMPLAINED", "SUPPRESSED"].includes(claimed.status)) {
      await lifecycle.markEmailSuppressed(claimed.lifecycleMessageId, "SUPPRESSED");
    }
  }

  async send(emailEventId: string): Promise<EmailSendOutcome> {
    assertIntegrationUuid(emailEventId, "emailEventId");
    const claimResult = await this.db.$transaction(async (tx) => {
      const current = await tx.emailEvent.findUnique({ where: { id: emailEventId } });
      if (!current) throw new EmailNotFoundError();
      if (current.status !== "QUEUED" && current.status !== "SENDING") {
        return { event: current, deferredByPause: false };
      }
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = nowRows[0]!.now;
      if (current.nextAttemptAt && current.nextAttemptAt > now) {
        return { event: current, deferredByPause: false };
      }
      if (current.templateKey === "lifecycle.campaign" && current.lifecycleMessageId) {
        const pausedUntil = await new LifecycleService(tx).deferEmailIfPaused(
          current.lifecycleMessageId,
        );
        if (pausedUntil) {
          const deferred = await tx.emailEvent.update({
            where: { id: emailEventId },
            data: {
              status: "SENDING",
              statusRank: statusRank("SENDING"),
              nextAttemptAt: pausedUntil,
            },
          });
          return { event: deferred, deferredByPause: true };
        }
      }
      const updated = await tx.emailEvent.updateMany({
        where: {
          id: emailEventId,
          status: { in: ["QUEUED", "SENDING"] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        data: {
          status: "SENDING",
          statusRank: statusRank("SENDING"),
          attemptCount: { increment: 1 },
          nextAttemptAt: null,
          lastError: null,
        },
      });
      if (updated.count === 0) {
        return {
          event: await tx.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } }),
          deferredByPause: false,
        };
      }
      return {
        event: await tx.emailEvent.findUniqueOrThrow({ where: { id: emailEventId } }),
        deferredByPause: false,
      };
    });
    const claimed = claimResult.event;
    if (claimResult.deferredByPause) {
      return {
        id: claimed.id,
        status: claimed.status,
        providerMessageId: claimed.providerMessageId,
        nextAttemptAt: claimed.nextAttemptAt,
        deferredByPause: true,
      };
    }
    if (
      claimed.status !== "SENDING" ||
      (claimed.nextAttemptAt && claimed.nextAttemptAt > new Date())
    ) {
      await this.reconcileLifecycleTerminal(claimed);
      return {
        id: claimed.id,
        status: claimed.status,
        providerMessageId: claimed.providerMessageId,
        nextAttemptAt: claimed.nextAttemptAt,
      };
    }
    const suppressed = await this.suppressedBeforeSend(claimed);
    if (suppressed) return suppressed;
    try {
      const credentials = await this.credentials(claimed.credentialId);
      const tokenEventUrl = (claimed.variablesSnapshot as Record<string, unknown>).unsubscribeUrl;
      if (typeof tokenEventUrl !== "string")
        throw new EmailValidationError("Stored unsubscribe URL is missing.");
      const result = await this.provider(credentials).send({
        idempotencyKey: claimed.idempotencyKey,
        to: claimed.recipientEmail,
        subject: claimed.subjectSnapshot,
        html: claimed.htmlBodySnapshot,
        text: claimed.textBodySnapshot,
        unsubscribeUrl: tokenEventUrl,
      });
      const sent = await this.db.emailEvent.update({
        where: { id: emailEventId },
        data: {
          status: "SENT",
          statusRank: statusRank("SENT"),
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
      if (sent.lifecycleMessageId) {
        await new LifecycleService(this.db).markEmailSent(sent.lifecycleMessageId, sent.id);
      }
      return {
        id: sent.id,
        status: sent.status,
        providerMessageId: sent.providerMessageId,
        nextAttemptAt: null,
      };
    } catch (error) {
      if (!(error instanceof EmailProviderError)) throw error;
      const transient = ["NETWORK_UNCERTAIN", "INVALID_RESPONSE"].includes(error.code);
      const code = errorCode(error);
      if (transient) {
        const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(claimed.attemptCount, 8));
        const nextAttemptAt = new Date(Date.now() + delay);
        const retry = await this.db.emailEvent.update({
          where: { id: emailEventId },
          data: {
            status: "SENDING",
            statusRank: statusRank("SENDING"),
            nextAttemptAt,
            lastError: code,
          },
        });
        return {
          id: retry.id,
          status: retry.status,
          providerMessageId: retry.providerMessageId,
          nextAttemptAt,
        };
      }
      const failed = await this.db.emailEvent.update({
        where: { id: emailEventId },
        data: {
          status: "FAILED",
          statusRank: statusRank("FAILED"),
          finalAt: new Date(),
          lastError: code,
          nextAttemptAt: null,
        },
      });
      if (failed.lifecycleMessageId) {
        await new LifecycleService(this.db).markEmailFailed(
          failed.lifecycleMessageId,
          failed.id,
          code,
        );
      }
      return {
        id: failed.id,
        status: failed.status,
        providerMessageId: failed.providerMessageId,
        nextAttemptAt: null,
      };
    }
  }

  private validUnsubscribeEvent(token: string) {
    const [eventId, signature, extra] = token.split(".");
    if (!eventId || !signature || extra !== undefined)
      throw new EmailValidationError("Unsubscribe token is malformed.");
    assertIntegrationUuid(eventId, "eventId");
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(signature))
      throw new EmailValidationError("Unsubscribe token signature is malformed.");
    return eventId;
  }

  async unsubscribe(token: string): Promise<{ eventId: string; topic: string; replayed: boolean }> {
    const eventId = this.validUnsubscribeEvent(token);
    const event = await this.db.emailEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new EmailNotFoundError("Unsubscribe link is no longer available.");
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(event.unsubscribeTokenHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new EmailValidationError("Unsubscribe token is invalid.");
    return this.db.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "EmailSuppression" ("recipientHash", "topic", "reason", "sourceEventId")
        VALUES (${event.recipientHash}, ${event.topic}, 'UNSUBSCRIBE', ${event.id}::uuid)
        ON CONFLICT ("recipientHash", "topic") DO NOTHING RETURNING "id"
      `;
      if (["QUEUED", "SENDING"].includes(event.status)) {
        await tx.emailEvent.update({
          where: { id: event.id },
          data: {
            status: "SUPPRESSED",
            statusRank: statusRank("SUPPRESSED"),
            finalAt: new Date(),
            nextAttemptAt: null,
          },
        });
      }
      if (event.abandonedCartId) {
        await tx.$executeRaw`
          UPDATE "AbandonedCart" SET
            "lastReminderActivityAt" = COALESCE("lastReminderActivityAt", "lastActivityAt"),
            "lastReminderOutcome" = 'SUPPRESSED'
          WHERE "id" = ${event.abandonedCartId}::uuid
        `;
      }
      if (event.lifecycleMessageId) {
        await new LifecycleService(tx).markEmailSuppressed(event.lifecycleMessageId, "SUPPRESSED");
      } else if (event.topic === "lifecycle" && event.customerId) {
        await new LifecycleService(tx).suppressCustomerTopic(event.customerId, "SUPPRESSED");
      }
      return { eventId: event.id, topic: event.topic, replayed: inserted.length === 0 };
    });
  }

  async unsubscribeTopic(token: string): Promise<string> {
    const eventId = this.validUnsubscribeEvent(token);
    const event = await this.db.emailEvent.findUnique({
      where: { id: eventId },
      select: { topic: true, unsubscribeTokenHash: true },
    });
    if (!event) throw new EmailNotFoundError("Unsubscribe link is no longer available.");
    const actual = createHash("sha256").update(token).digest();
    if (!timingSafeEqual(actual, Buffer.from(event.unsubscribeTokenHash)))
      throw new EmailValidationError("Unsubscribe token is invalid.");
    return event.topic;
  }

  async processWebhook(options: {
    body: string;
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  }): Promise<{ eventId: string | null; status: string; replayed: boolean }> {
    const credentials = await this.options.vault.list({ includeRevoked: false, limit: 100 });
    const active = credentials.items.filter(
      (item) => item.provider === "resend" && !item.revokedAt,
    );
    if (active.length === 0 || credentials.items.length === 100)
      throw new EmailValidationError("An unambiguous active Resend credential is required.");
    let lastError: unknown;
    let verified: { credentialId: string; event: import("./svix.js").VerifiedSvixEvent } | null =
      null;
    for (const descriptor of active) {
      try {
        const secret = await this.credentials(descriptor.id);
        const event = verifySvixWebhook({
          body: options.body,
          secret: secret.svixSecret,
          id: options.id,
          timestamp: options.timestamp,
          signature: options.signature,
        });
        verified = { credentialId: descriptor.id, event };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (verified) return this.persistWebhook(verified.credentialId, verified.event);
    throw lastError instanceof Error
      ? lastError
      : new EmailValidationError("No Resend credential accepted the webhook.");
  }

  private async webhookReplay(
    credentialId: string,
    event: import("./svix.js").VerifiedSvixEvent,
    payloadHash: Uint8Array,
  ): Promise<{ eventId: string | null; status: string; replayed: true } | null> {
    const existing = await this.db.emailWebhookEvent.findUnique({
      where: { credentialId_svixEventId: { credentialId, svixEventId: event.svixEventId } },
      include: { emailEvent: { select: { id: true, status: true } } },
    });
    if (!existing) return null;
    if (!matchesPayloadHash(existing.payloadHash, payloadHash)) {
      throw new EmailConflictError(
        "Svix event ID was already used for a different payload.",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return {
      eventId: existing.emailEvent?.id ?? null,
      status: existing.emailEvent?.status ?? "IGNORED",
      replayed: true,
    };
  }

  private async persistWebhook(
    credentialId: string,
    event: import("./svix.js").VerifiedSvixEvent,
  ): Promise<{ eventId: string | null; status: string; replayed: boolean }> {
    const payloadHash = createHash("sha256").update(event.payloadHashInput).digest();
    const existing = await this.webhookReplay(credentialId, event, payloadHash);
    if (existing) return existing;
    try {
      return await this.db.$transaction(async (tx) => {
        const email = await tx.emailEvent.findUnique({
          where: {
            credentialId_providerMessageId: {
              credentialId,
              providerMessageId: event.providerMessageId,
            },
          },
        });
        await tx.emailWebhookEvent.create({
          data: {
            credentialId,
            emailEventId: email?.id ?? null,
            svixEventId: event.svixEventId,
            eventType: event.eventType,
            payloadHash,
            occurredAt: event.occurredAt,
            processedAt: new Date(),
          },
        });
        if (!email) return { eventId: null, status: "IGNORED", replayed: false };
        const targetStatus = {
          "email.sent": "SENT",
          "email.delivered": "DELIVERED",
          "email.delivery_delayed": "DELIVERY_DELAYED",
          "email.bounced": "BOUNCED",
          "email.complained": "COMPLAINED",
        }[event.eventType] as EmailEventStatus | undefined;
        if (!targetStatus) return { eventId: email.id, status: email.status, replayed: false };
        const rank = statusRank(targetStatus);
        if (email.statusRank > rank || finalStatuses.has(email.status))
          return { eventId: email.id, status: email.status, replayed: false };
        await tx.emailEvent.update({
          where: { id: email.id },
          data: {
            status: targetStatus,
            statusRank: rank,
            sentAt: ["SENT", "DELIVERY_DELAYED", "DELIVERED", "BOUNCED", "COMPLAINED"].includes(
              targetStatus,
            )
              ? (email.sentAt ?? event.occurredAt)
              : email.sentAt,
            deliveredAt: targetStatus === "DELIVERED" ? event.occurredAt : email.deliveredAt,
            finalAt: ["BOUNCED", "COMPLAINED"].includes(targetStatus)
              ? event.occurredAt
              : email.finalAt,
            nextAttemptAt: null,
          },
        });
        if (["BOUNCED", "COMPLAINED"].includes(targetStatus)) {
          await tx.$executeRaw`
            INSERT INTO "EmailSuppression" ("recipientHash", "topic", "reason", "sourceEventId")
            VALUES (${email.recipientHash}, ${email.topic}, ${targetStatus === "BOUNCED" ? "BOUNCE" : "COMPLAINT"}::"EmailSuppressionReason", ${email.id}::uuid)
            ON CONFLICT ("recipientHash", "topic") DO NOTHING
          `;
        }
        if (email.lifecycleMessageId) {
          const lifecycle = new LifecycleService(tx);
          if (["SENT", "DELIVERY_DELAYED", "DELIVERED"].includes(targetStatus)) {
            await lifecycle.markEmailSent(email.lifecycleMessageId, email.id);
          } else {
            await lifecycle.markEmailSuppressed(email.lifecycleMessageId, "SUPPRESSED");
          }
        } else if (
          email.topic === "lifecycle" &&
          email.customerId &&
          ["BOUNCED", "COMPLAINED"].includes(targetStatus)
        ) {
          await new LifecycleService(tx).suppressCustomerTopic(email.customerId, "SUPPRESSED");
        }
        return { eventId: email.id, status: targetStatus, replayed: false };
      });
    } catch (error) {
      if (!isSvixEventUniqueConflict(error)) throw error;
      const replay = await this.webhookReplay(credentialId, event, payloadHash);
      if (replay) return replay;
      throw new EmailConflictError(
        "The Svix event insertion conflict could not be reconciled.",
        "PROVIDER_UNCERTAIN",
      );
    }
  }
}
