export class EmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailValidationError";
  }
}

export class EmailConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_STATE"
      | "SUPPRESSED"
      | "IDEMPOTENCY_CONFLICT"
      | "PROVIDER_UNCERTAIN" = "INVALID_STATE",
  ) {
    super(message);
    this.name = "EmailConflictError";
  }
}

export class EmailNotFoundError extends Error {
  constructor(message = "Email record not found.") {
    super(message);
    this.name = "EmailNotFoundError";
  }
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      "INVALID_CREDENTIAL" | "INVALID_RESPONSE" | "HTTP_ERROR" | "NETWORK_UNCERTAIN" | "REJECTED",
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

export interface EmailAuditContext {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface EmailCredentials {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly replyTo: string | null;
  readonly svixSecret: string;
  readonly unsubscribeSecret: string;
  readonly apiUrl: string;
}

export interface EmailSendInput {
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly unsubscribeUrl?: string;
}

export interface EmailSendResult {
  readonly providerMessageId: string;
}

export interface EmailProvider {
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

export interface EmailTemplateInput {
  readonly templateKey: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: readonly string[];
  readonly publish: boolean;
  readonly idempotencyKey: string;
}

export interface EmailQueueInput {
  readonly orderId?: string;
  readonly customerId?: string;
  readonly abandonedCartId?: string;
  readonly lifecycleMessageId?: string;
  readonly credentialId: string;
  readonly templateKey: string;
  readonly topic: string;
  readonly recipientEmail: string;
  readonly idempotencyKey: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly templateSnapshot?: import("./email-templates.js").EmailTemplateDefinition;
}

export interface EmailServiceOptions {
  readonly vault: {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: readonly { id: string; provider: string; revokedAt: Date | null }[];
    }>;
    reveal(id: string): Promise<Uint8Array>;
  };
  readonly publicSiteUrl: string;
  readonly providerFactory?: (credentials: EmailCredentials) => EmailProvider;
}
