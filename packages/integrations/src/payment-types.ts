import type {
  BlockedIdentityKind,
  IntegrationEnvironment,
  PaymentAttemptStatus,
  PaymentProvider as PaymentProviderValue,
} from "@mundonettech/db";

export type PaymentProviderCode = PaymentProviderValue;

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor(message = "Payment record not found.") {
    super(message);
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_STATE"
      | "AMOUNT_EXCEEDED"
      | "BLOCKED_IDENTITY"
      | "INSUFFICIENT_CREDIT"
      | "PROVIDER_UNCERTAIN"
      | "DUPLICATE_REFERENCE" = "INVALID_STATE",
  ) {
    super(message);
    this.name = "PaymentConflictError";
  }
}

export class PaymentAuthorizationError extends Error {
  constructor(message = "The administrator is not authorized for this payment operation.") {
    super(message);
    this.name = "PaymentAuthorizationError";
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_CREDENTIAL" | "INVALID_RESPONSE" | "HTTP_ERROR" | "NETWORK_UNCERTAIN",
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export interface PaymentAuditContext {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface PaymentStartInput {
  readonly orderId: string;
  readonly provider: PaymentProviderCode;
  readonly environment: IntegrationEnvironment;
  readonly idempotencyKey: string;
  readonly amountCents?: bigint;
  readonly credentialId?: string;
  readonly returnUrl?: string;
  readonly expiresAt?: Date;
  readonly identityHashes?: Partial<Record<BlockedIdentityKind, Uint8Array>>;
}

export interface PaymentAttemptSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly provider: PaymentProviderCode;
  readonly status: PaymentAttemptStatus;
  readonly reference: string;
  readonly amountCents: string;
  readonly currency: "COP";
  readonly expiresAt: string | null;
  readonly replayed: boolean;
  readonly checkoutUrl: string | null;
}

export interface ProviderStartInput {
  readonly attemptId: string;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly returnUrl?: string;
  readonly expiresAt?: Date;
}

export interface ProviderStartResult {
  readonly checkoutUrl: string | null;
}

export interface ProviderOperationInput {
  readonly transactionId: string;
  readonly paymentReference: string;
  readonly externalCaptureId: string | null;
  readonly amountCents: bigint;
  readonly reason: string;
}

export interface ProviderOperationResult {
  readonly status: "PENDING" | "SUCCEEDED" | "FAILED";
  readonly externalId: string | null;
  readonly providerReference: string | null;
  readonly message: string | null;
}

export interface PaymentProvider {
  readonly code: PaymentProviderCode;
  start(input: ProviderStartInput): Promise<ProviderStartResult>;
  refund(input: ProviderOperationInput): Promise<ProviderOperationResult>;
  void(input: ProviderOperationInput): Promise<ProviderOperationResult>;
}

export interface WompiTransactionEvent {
  readonly eventKey: string;
  readonly payloadHash: Uint8Array<ArrayBuffer>;
  readonly supported: boolean;
  readonly occurredAt: Date;
  readonly transaction: {
    readonly id: string;
    readonly reference: string;
    readonly amountCents: bigint;
    readonly currency: "COP";
    readonly status: "PENDING" | "APPROVED" | "DECLINED" | "VOIDED" | "ERROR";
    readonly statusMessage: string | null;
  } | null;
}

export interface WompiCredentials {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly integritySecret: string;
  readonly eventsSecret: string;
  readonly mode: "test" | "prod";
}

export interface PaymentStatusTransition {
  readonly previousStatus: string;
  readonly status: string;
  readonly paidCents: string;
  readonly totalCents: string;
  readonly fulfilledStock: boolean;
}

export interface StoreCreditAdjustmentInput {
  readonly customerId: string;
  readonly type: "GRANT" | "WITHDRAWAL";
  readonly amountCents: bigint;
  readonly operationKey: string;
  readonly reason: string;
  readonly audit: PaymentAuditContext;
}

export interface StoreCreditSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly availableCents: string;
  readonly heldCents: string;
  readonly active: boolean;
  readonly version: number;
}

export interface RemittanceItemInput {
  readonly paymentAttemptId: string;
  readonly collectedCents: bigint;
  readonly remittedCents: bigint;
  readonly carrierReference: string;
}

export interface RemittanceInput {
  readonly carrier: string;
  readonly reference: string;
  readonly items: readonly RemittanceItemInput[];
  readonly audit: PaymentAuditContext;
}

export interface RemittanceResult {
  readonly batchId: string;
  readonly status: string;
  readonly expectedCents: string;
  readonly receivedCents: string;
  readonly reconciledAttemptIds: readonly string[];
  readonly discrepancyAttemptIds: readonly string[];
  readonly replayed: boolean;
}

export interface RefundExecutionResult {
  readonly refundId: string;
  readonly status: string;
  readonly transactionIds: readonly string[];
  readonly pendingTransactionIds: readonly string[];
}
