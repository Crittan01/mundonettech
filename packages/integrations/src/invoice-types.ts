import type { IntegrationEnvironment } from "@mundonettech/db";

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

export class InvoiceConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_STATE"
      | "NOT_READY"
      | "PROVIDER_UNCERTAIN"
      | "IDEMPOTENCY_CONFLICT" = "INVALID_STATE",
  ) {
    super(message);
    this.name = "InvoiceConflictError";
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(message = "Fiscal document not found.") {
    super(message);
    this.name = "InvoiceNotFoundError";
  }
}

export class InvoiceProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      "INVALID_CREDENTIAL" | "INVALID_RESPONSE" | "HTTP_ERROR" | "NETWORK_UNCERTAIN" | "REJECTED",
  ) {
    super(message);
    this.name = "InvoiceProviderError";
  }
}

export interface InvoiceAuditContext {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface DianCredentials {
  readonly bearerToken: string;
  readonly providerUrl: string;
  readonly issuerNit: string;
  readonly issuerDv: string;
  readonly issuerLegalName: string;
  readonly issuerEmail: string;
  readonly issuerAddress: string;
  readonly issuerDepartmentCode: string;
  readonly issuerDepartmentName: string;
  readonly issuerMunicipalityCode: string;
  readonly issuerMunicipalityName: string;
  readonly issuerPostalCode: string;
  readonly issuerPhoneE164: string;
  readonly softwareId: string;
  readonly softwarePin: string;
  readonly signatureTrustAnchorPem: string | null;
  readonly invoicePrefix: string;
  readonly invoiceResolutionNumber: string;
  readonly invoiceResolutionStart: number;
  readonly invoiceResolutionEnd: number;
  readonly invoiceResolutionDate: string;
  readonly invoiceResolutionValidFrom: string;
  readonly invoiceResolutionValidTo: string;
  readonly creditNotePrefix: string;
}

export interface FiscalParty {
  readonly taxRegime?: "NO_RESPONSABLE_IVA" | "RESPONSABLE_IVA";
  readonly documentType: string;
  readonly documentNumber: string;
  readonly legalName: string;
  readonly email: string;
  readonly phoneE164: string;
  readonly addressLine1: string;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly municipalityCode: string;
  readonly municipalityName: string;
  readonly postalCode: string | null;
}

export interface FiscalLine {
  readonly sku: string;
  readonly title: string;
  readonly quantity: number;
  readonly unitPriceCents: bigint;
  readonly discountCents: bigint;
  readonly lineTotalCents: bigint;
  readonly taxCents: bigint;
  readonly taxRateBps: number;
  readonly taxCategory?: "STANDARD" | "EXEMPT" | "EXCLUDED";
}

interface FiscalResolution {
  readonly authorizationNumber: string;
  readonly prefix: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly validFrom: string;
  readonly validTo: string;
}

export interface InvoiceDocumentInput {
  readonly fullNumber: string;
  readonly issueDate: Date;
  readonly cufe: string;
  readonly resolution: FiscalResolution;
  readonly issuer: FiscalParty;
  readonly buyer: FiscalParty;
  readonly lines: readonly FiscalLine[];
  readonly subtotalCents: bigint;
  readonly discountCents: bigint;
  readonly taxCents: bigint;
  readonly shippingCents: bigint;
  readonly totalCents: bigint;
}

export interface CreditNoteDocumentInput extends Omit<InvoiceDocumentInput, "cufe" | "resolution"> {
  readonly cude: string;
  readonly invoiceFullNumber: string;
  readonly invoiceCufe: string;
  readonly invoiceIssueDate: Date;
  readonly reasonCode: number;
}

export interface FiscalTransmissionInput {
  readonly documentId: string;
  readonly idempotencyKey: string;
  readonly documentType: "INVOICE" | "CREDIT_NOTE";
  readonly documentNumber: string;
  readonly documentHash: string;
  readonly unsignedXml: string;
}

export interface FiscalTransmissionResult {
  readonly providerDocumentId: string;
  readonly signedXml: string;
}

export interface InvoiceProvider {
  transmit(input: FiscalTransmissionInput): Promise<FiscalTransmissionResult>;
  find(
    documentHash: string,
    documentNumber?: string,
    documentType?: "INVOICE" | "CREDIT_NOTE",
  ): Promise<FiscalTransmissionResult | null>;
}

export interface InvoiceServiceOptions {
  readonly vault: {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: readonly { id: string; provider: string; revokedAt: Date | null }[];
    }>;
    reveal(id: string): Promise<Uint8Array>;
  };
  readonly environment: IntegrationEnvironment;
  readonly providerFactory?: (credentials: DianCredentials) => InvoiceProvider;
}
