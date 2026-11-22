import type {
  CalculatedOrderTaxLine,
  DeliveryPoint,
  OrderTaxRule,
  StoreTaxRegimeValue,
} from "@mundonettech/core";

import type { CartReference, CartSnapshot } from "./cart-types.js";
import type { OrderStatus, PaymentStatus } from "./generated/client.js";

export interface CheckoutDefaults {
  readonly taxRegime: StoreTaxRegimeValue;
  readonly currency: "COP";
  readonly timeZone: string;
  readonly orderNumberPrefix: string;
  readonly orderNumberPadding: number;
  readonly uvtValueCents: bigint;
  readonly uvtYear: number;
  readonly standardShippingCents: bigint;
  readonly deliveryPromiseDays: number;
  readonly reservationMinutes: number;
  readonly clickAndCollectEnabled: boolean;
}

export interface CheckoutContactInput {
  readonly email: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly buyerDocumentType?: string;
  readonly buyerDocumentNumber?: string;
  readonly buyerTaxRegime?: StoreTaxRegimeValue | null;
  readonly termsVersion: string;
  readonly privacyPolicyVersion: string;
  readonly acceptanceProofHash: Uint8Array;
  readonly acceptanceIpHash?: Uint8Array | null;
  readonly acceptanceUserAgentHash?: Uint8Array | null;
}

export interface HomeDeliveryInput {
  readonly method: "HOME_DELIVERY";
  readonly departmentCode: string;
  readonly municipalityCode: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly neighborhood?: string | null;
  readonly postalCode?: string | null;
  readonly deliveryNotes?: string | null;
}

export interface LocalDeliveryInput extends Omit<HomeDeliveryInput, "method"> {
  readonly method: "LOCAL_DELIVERY";
  readonly zoneId: string;
  readonly point: DeliveryPoint;
}

export interface ClickCollectInput {
  readonly method: "CLICK_COLLECT";
  readonly locationId: string;
  readonly deliveryNotes?: string | null;
}

export type CheckoutFulfillmentInput = HomeDeliveryInput | LocalDeliveryInput | ClickCollectInput;

export interface CheckoutIdempotencyInput {
  readonly keyHash: Uint8Array;
  readonly subjectHash: Uint8Array;
  readonly requestHash: Uint8Array;
  readonly expiresAt: Date;
}

export interface CheckoutConversionInput {
  readonly cart: CartReference;
  readonly contact: CheckoutContactInput;
  readonly fulfillment: CheckoutFulfillmentInput;
  readonly idempotency: CheckoutIdempotencyInput;
  readonly receiptAccessTokenHash: Uint8Array;
  readonly receiptDeliveryReference?: string;
  readonly expectedReviewFingerprint: string;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly receiptNumber: string;
  readonly totalCents: string;
  readonly paymentStatus: PaymentStatus;
  readonly replayed: boolean;
}

export interface CheckoutCustomerSnapshot {
  readonly id: string;
  readonly email: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly phoneE164: string | null;
  readonly authenticated: boolean;
}

export interface PickupLocationSnapshot {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly addressLine1: string;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly municipalityCode: string;
  readonly municipalityName: string;
  readonly phoneE164: string | null;
  readonly instructions: string | null;
  readonly available: boolean;
  readonly reviewFingerprint: string;
}

export interface DaneDepartmentSnapshot {
  readonly code: string;
  readonly name: string;
}

export interface DaneMunicipalitySnapshot {
  readonly code: string;
  readonly departmentCode: string;
  readonly name: string;
  readonly locationType: string;
}

export type CheckoutTaxLineSnapshot = Omit<
  CalculatedOrderTaxLine,
  "uvtValueCents" | "unitValueCents" | "taxableBaseCents" | "taxCents"
> & {
  readonly uvtValueCents: string;
  readonly unitValueCents: string;
  readonly taxableBaseCents: string;
  readonly taxCents: string;
};

export interface LocalDeliveryQuoteSnapshot {
  readonly zoneId: string;
  readonly zoneCode: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly deliveryPromiseAt: string;
  readonly reviewFingerprint: string;
}

export interface CheckoutPreview {
  readonly cart: CartSnapshot;
  readonly customer: CheckoutCustomerSnapshot | null;
  readonly taxRegime: StoreTaxRegimeValue;
  readonly uvtValueCents: string;
  readonly uvtYear: number;
  readonly deliveryPromiseDays: number;
  readonly reservationMinutes: number;
  readonly taxLines: readonly CheckoutTaxLineSnapshot[];
  readonly merchandiseTotalCents: string;
  readonly homeDelivery: {
    readonly shippingCents: string;
    readonly totalCents: string;
    readonly reviewFingerprint: string;
  };
  readonly clickAndCollectEnabled: boolean;
  readonly localDeliveryEnabled: boolean;
  readonly pickupLocations: readonly PickupLocationSnapshot[];
  readonly departments: readonly DaneDepartmentSnapshot[];
  readonly municipalities: readonly DaneMunicipalitySnapshot[];
}

export interface ReceiptTaxLineSnapshot {
  readonly id: string;
  readonly taxGroupCode: string;
  readonly taxGroupName: string;
  readonly treatment: string;
  readonly rule: OrderTaxRule;
  readonly catalogRateBps: number;
  readonly appliedRateBps: number;
  readonly uvtLimit: number | null;
  readonly uvtValueCents: string;
  readonly uvtYear: number;
  readonly unitValueCents: string;
  readonly taxableBaseCents: string;
  readonly taxCents: string;
}

export interface ReceiptItemSnapshot {
  readonly id: string;
  readonly skuSnapshot: string;
  readonly titleSnapshot: string;
  readonly productSlugSnapshot: string;
  readonly quantity: number;
  readonly unitPriceCents: string;
  readonly unitCostWacCents: string;
  readonly discountCents: string;
  readonly lineTotalCents: string;
  readonly taxCents: string;
  readonly totalCents: string;
  readonly taxLines: readonly ReceiptTaxLineSnapshot[];
}

export interface OrderReceiptSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly receiptNumber: string;
  readonly issuedAt: string;
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly fulfillmentMethod: "HOME_DELIVERY" | "CLICK_COLLECT" | "LOCAL_DELIVERY";
  readonly taxRegime: StoreTaxRegimeValue;
  readonly currency: "COP";
  readonly emailSnapshot: string;
  readonly recipientNameSnapshot: string;
  readonly phoneE164Snapshot: string;
  readonly departmentNameSnapshot: string;
  readonly municipalityNameSnapshot: string;
  readonly addressLine1Snapshot: string;
  readonly addressLine2Snapshot: string | null;
  readonly neighborhoodSnapshot: string | null;
  readonly postalCodeSnapshot: string | null;
  readonly deliveryNotesSnapshot: string | null;
  readonly pickupLocationName: string | null;
  readonly couponCodeSnapshot: string | null;
  readonly subtotalCents: string;
  readonly wholesaleDiscountCents: string;
  readonly bundleDiscountCents: string;
  readonly couponDiscountCents: string;
  readonly discountCents: string;
  readonly taxCents: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly deliveryPromiseAt: string;
  readonly items: readonly ReceiptItemSnapshot[];
}

export interface RefundItemRequest {
  readonly orderItemId: string;
  readonly quantity: number;
}

export interface RefundAudit {
  readonly actorAdminUserId: string;
  readonly ipHash: Uint8Array;
  readonly userAgentHash: Uint8Array | null;
}

export interface RefundRequestInput {
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly reason: "RETRACT" | "WARRANTY" | "ADJUSTMENT" | "CUSTOMER_SUPPORT";
  readonly note?: string | null;
  readonly items: readonly RefundItemRequest[];
  readonly includeShipping: boolean;
  readonly audit: RefundAudit;
}

export interface RefundStatusTransitionInput {
  readonly refundId: string;
  readonly note?: string | null;
  readonly audit: RefundAudit;
}

export interface RefundRequestResult {
  readonly id: string;
  readonly orderId: string;
  readonly status: string;
  readonly subtotalCents: string;
  readonly taxCents: string;
  readonly shippingCents: string;
  readonly totalCents: string;
  readonly replayed: boolean;
}
