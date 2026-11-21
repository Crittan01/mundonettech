import "server-only";

import { createHmac } from "node:crypto";

import { storeConfig } from "@mundonettech/config/store";
import { OrderService, type CheckoutPreview } from "@mundonettech/db";

import { checkoutCartReference, existingCartReference } from "@/lib/cart";
import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";

export function orderService(): OrderService {
  return new OrderService(getDatabase(), {
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
  });
}

export async function readCheckoutPreview(): Promise<CheckoutPreview | null> {
  const reference = await existingCartReference();
  if (!reference) return null;
  return orderService().preview(reference);
}

export async function readCheckoutCartReference() {
  return checkoutCartReference();
}

export function receiptTokenForSubmission(submissionId: string): string {
  return createHmac("sha256", getSessionHmacSecret())
    .update(`order-receipt:${submissionId}`, "utf8")
    .digest("base64url");
}
