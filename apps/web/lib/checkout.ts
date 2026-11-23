import "server-only";

import { createHmac } from "node:crypto";

import { storeConfig } from "@mundonettech/config/store";
import { OrderService, type CheckoutDefaults, type CheckoutPreview } from "@mundonettech/db";

import { checkoutCartReference, existingCartReference } from "@/lib/cart";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";
import {
  getBankTransferInstructions,
  getIntegrationCredentialVault,
  storeCreditService,
} from "@/lib/integrations";

export interface StorefrontCheckoutPreview extends CheckoutPreview {
  readonly paymentMethods: {
    readonly wompiAccounts: readonly { id: string; accountName: string }[];
    readonly bankTransferEnabled: boolean;
    readonly storeCreditAvailableCents: string | null;
  };
}

export function checkoutDefaults(): CheckoutDefaults {
  return {
    taxRegime: storeConfig.tax.regime,
    currency: storeConfig.currency,
    timeZone: storeConfig.timeZone,
    orderNumberPrefix: storeConfig.orderNumber.prefix,
    orderNumberPadding: 4,
    uvtValueCents: BigInt(storeConfig.tax.uvtValueCents),
    uvtYear: storeConfig.tax.uvtYear,
    standardShippingCents: BigInt(storeConfig.checkout.standardShippingCents),
    deliveryPromiseDays: storeConfig.checkout.deliveryPromiseDays,
    reservationMinutes: storeConfig.checkout.reservationMinutes,
    clickAndCollectEnabled: false,
  };
}

export function orderService(): OrderService {
  return new OrderService(getDatabase(), checkoutDefaults());
}

export async function readCheckoutPreview(): Promise<StorefrontCheckoutPreview | null> {
  const reference = await existingCartReference();
  if (!reference) return null;
  const preview = await orderService().preview(reference);
  if (!preview) return null;
  const [credentials, credit] = await Promise.all([
    getIntegrationCredentialVault().list({ limit: 100 }),
    preview.customer?.authenticated
      ? storeCreditService().get(preview.customer.id)
      : Promise.resolve(null),
  ]);
  return {
    ...preview,
    paymentMethods: {
      wompiAccounts: credentials.items
        .filter((credential) => credential.provider === "wompi" && !credential.revokedAt)
        .map((credential) => ({ id: credential.id, accountName: credential.accountName })),
      bankTransferEnabled: getBankTransferInstructions() !== null,
      storeCreditAvailableCents:
        credit?.active && BigInt(credit.availableCents) > 0n ? credit.availableCents : null,
    },
  };
}

export async function readCheckoutCartReference() {
  return checkoutCartReference();
}

export function receiptTokenForSubmission(submissionId: string): string {
  return createHmac("sha256", getSessionHmacSecret())
    .update(`order-receipt:${submissionId}`, "utf8")
    .digest("base64url");
}
