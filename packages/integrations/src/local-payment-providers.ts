import type { PaymentProviderCode } from "./payment-types.js";
import type {
  PaymentProvider,
  ProviderOperationInput,
  ProviderOperationResult,
  ProviderStartInput,
  ProviderStartResult,
} from "./payment-types.js";

export class OfflinePaymentProvider implements PaymentProvider {
  constructor(readonly code: Extract<PaymentProviderCode, "COD" | "BANK_TRANSFER">) {}

  async start(input: ProviderStartInput): Promise<ProviderStartResult> {
    void input;
    return { checkoutUrl: null };
  }

  async refund(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    void input;
    return {
      status: "PENDING",
      externalId: null,
      providerReference: null,
      message: "Manual settlement requires verified evidence.",
    };
  }

  async void(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    return {
      status: "SUCCEEDED",
      externalId: `offline-void:${input.transactionId}`,
      providerReference: input.paymentReference,
      message: "Pending offline payment cancelled without a financial capture.",
    };
  }
}

export class StoreCreditPaymentProvider implements PaymentProvider {
  readonly code = "STORE_CREDIT" as const;

  async start(input: ProviderStartInput): Promise<ProviderStartResult> {
    void input;
    return { checkoutUrl: null };
  }

  async refund(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    return {
      status: "SUCCEEDED",
      externalId: `store-credit-refund:${input.transactionId}`,
      providerReference: input.paymentReference,
      message: "Store credit restored in the customer ledger.",
    };
  }

  async void(input: ProviderOperationInput): Promise<ProviderOperationResult> {
    void input;
    return {
      status: "FAILED",
      externalId: null,
      providerReference: null,
      message: "Captured store credit must be reversed through an order refund.",
    };
  }
}
