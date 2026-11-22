import type { IntegrationEnvironment } from "@mundonettech/db";

export class ShippingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingValidationError";
  }
}

export class ShippingNotFoundError extends Error {
  constructor(message = "Shipping record not found.") {
    super(message);
    this.name = "ShippingNotFoundError";
  }
}

export class ShippingAuthorizationError extends Error {
  constructor(message = "The administrator is not authorized for this fulfillment operation.") {
    super(message);
    this.name = "ShippingAuthorizationError";
  }
}

export class ShippingConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_STATE"
      | "PACKAGE_INCOMPLETE"
      | "PROVIDER_UNCERTAIN"
      | "SIBLING_CLAIM_ACTIVE"
      | "IDEMPOTENCY_CONFLICT"
      | "ZONE_UNAVAILABLE" = "INVALID_STATE",
  ) {
    super(message);
    this.name = "ShippingConflictError";
  }
}

export class ShippingProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      "INVALID_CREDENTIAL" | "INVALID_RESPONSE" | "HTTP_ERROR" | "NETWORK_UNCERTAIN" | "REJECTED",
  ) {
    super(message);
    this.name = "ShippingProviderError";
  }
}

export interface ShippingAuditContext {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash?: Uint8Array | null;
  readonly requestId?: string;
}

export interface ShippingPackageInput {
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly items: readonly {
    readonly shipmentItemId: string;
    readonly quantity: number;
  }[];
}

export interface ShippingParty {
  readonly name: string;
  readonly documentNumber: string;
  readonly email: string;
  readonly phoneE164: string;
  readonly addressLine1: string;
  readonly neighborhood: string | null;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly municipalityCode: string;
  readonly municipalityName: string;
}

export interface ShippingLabelRequest {
  readonly packageId: string;
  readonly requestKey: string;
  readonly orderNumber: string;
  readonly origin: ShippingParty;
  readonly destination: ShippingParty;
  readonly declaredValueCents: bigint;
  readonly weightGrams: number;
  readonly lengthMillimeters: number;
  readonly widthMillimeters: number;
  readonly heightMillimeters: number;
  readonly cashOnDeliveryCents: bigint;
  readonly contents: readonly {
    readonly sku: string;
    readonly title: string;
    readonly quantity: number;
    readonly declaredValueCents: bigint;
  }[];
}

export interface ShippingLabelResult {
  readonly providerReference: string;
  readonly trackingCode: string;
  readonly carrier: string;
  readonly labelUrl: string | null;
}

export interface ShippingProvider {
  createLabel(input: ShippingLabelRequest): Promise<ShippingLabelResult>;
  findLabel(requestKey: string): Promise<ShippingLabelResult | null>;
}

export interface AveonlineCredentials {
  readonly username: string;
  readonly password: string;
  readonly companyId: string;
  readonly companyCode: string;
  readonly companyDocument: string;
  readonly originLegalName: string;
  readonly originEmail: string;
  readonly agentId: string;
  readonly carrierId: string;
  readonly authUrl: string;
  readonly labelsUrl: string;
  readonly lookupUrl: string;
}

export interface ShippingServiceOptions {
  readonly vault: {
    list(options: { includeRevoked?: boolean; limit: number }): Promise<{
      items: readonly { id: string; provider: string; revokedAt: Date | null }[];
    }>;
    reveal(id: string): Promise<Uint8Array>;
  };
  readonly environment: IntegrationEnvironment;
  readonly providerFactory?: (credentials: AveonlineCredentials) => ShippingProvider;
  readonly claimSeconds?: number;
}
