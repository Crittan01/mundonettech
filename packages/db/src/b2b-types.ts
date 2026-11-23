import type { StoreTaxRegimeValue } from "@mundonettech/core";

import type { CrmAudit } from "./crm-shared.js";
import type {
  OpportunityProposalStatus,
  OpportunityStatus,
  PriceListStatus,
} from "./generated/client.js";

export type B2bAudit = CrmAudit;

export interface PriceListInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
  readonly validFrom?: Date | null;
  readonly validTo?: Date | null;
}

export interface PriceListItemInput {
  readonly sku: string;
  readonly unitPriceCents: string;
}

export interface B2bLeadInput {
  readonly legalName: string;
  readonly commercialName?: string | null;
  readonly taxId: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly email: string;
  readonly phoneE164: string;
  readonly requirements: string;
  readonly privacyPolicyVersion: string;
  readonly acceptanceProofHash: Uint8Array;
  readonly acceptanceIpHash?: Uint8Array | null;
  readonly acceptanceUserAgentHash?: Uint8Array | null;
  readonly idempotency: {
    readonly keyHash: Uint8Array;
    readonly subjectHash: Uint8Array;
    readonly requestHash: Uint8Array;
    readonly expiresAt: Date;
  };
}

export interface B2bProposalLineInput {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents?: string;
}

export interface CreateB2bProposalInput {
  readonly opportunityId: string;
  readonly expectedVersion: number;
  readonly expiresAt: Date;
  readonly commercialNotes?: string | null;
  readonly items: readonly B2bProposalLineInput[];
  readonly audit: B2bAudit;
}

export interface B2bProposalAcceptance {
  readonly proposalId: string;
  readonly signerName: string;
  readonly signerDocumentType: string;
  readonly signerDocumentNumber: string;
}

export interface B2bProposalLineSnapshot {
  readonly variantId: string;
  readonly sku: string;
  readonly title: string;
  readonly productSlug: string;
  readonly quantity: number;
  readonly catalogUnitPriceCents: string;
  readonly unitPriceCents: string;
  readonly discountCents: string;
  readonly lineTotalCents: string;
  readonly taxCents: string;
}

export interface PublicB2bProposal {
  readonly id: string;
  readonly opportunityId: string;
  readonly version: number;
  readonly status: OpportunityProposalStatus;
  readonly available: boolean;
  readonly unavailableReason: "EXPIRED" | "SUPERSEDED" | "CANCELLED" | "CONVERTED" | null;
  readonly organizationName: string;
  readonly contact: {
    readonly givenName: string;
    readonly familyName: string;
    readonly email: string;
    readonly phoneE164: string;
    readonly documentNumber: string;
  };
  readonly currency: "COP";
  readonly taxRegime: StoreTaxRegimeValue;
  readonly commercialNotes: string | null;
  readonly expiresAt: string;
  readonly orderId: string | null;
  readonly cartId: string | null;
  readonly subtotalCents: string;
  readonly discountCents: string;
  readonly taxCents: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly items: readonly B2bProposalLineSnapshot[];
}

export interface B2bOpportunityListItem {
  readonly id: string;
  readonly status: OpportunityStatus;
  readonly source: string;
  readonly requirements: string;
  readonly currentVersion: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly organization: {
    readonly id: string;
    readonly legalName: string;
    readonly taxId: string | null;
    readonly priceListId: string | null;
  };
  readonly contact: {
    readonly id: string;
    readonly givenName: string | null;
    readonly familyName: string | null;
    readonly email: string | null;
    readonly phoneE164: string | null;
  };
}

export interface B2bPriceListView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: PriceListStatus;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  readonly version: number;
  readonly itemCount: number;
  readonly organizationCount: number;
}
