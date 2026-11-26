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
  readonly savedAddresses: readonly {
    readonly id: string;
    readonly label: string;
    readonly recipientName: string;
    readonly phoneE164: string;
    readonly departmentCode: string;
    readonly municipalityCode: string;
    readonly addressLine1: string;
    readonly addressLine2: string | null;
    readonly neighborhood: string | null;
    readonly postalCode: string | null;
    readonly deliveryNotes: string | null;
    readonly isDefault: boolean;
  }[];
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
  const [credentials, credit, savedAddresses] = await Promise.all([
    getIntegrationCredentialVault().forSystemProvider("wompi").list({ limit: 100 }),
    preview.customer?.authenticated
      ? storeCreditService().get(preview.customer.id)
      : Promise.resolve(null),
    preview.customer?.authenticated
      ? getDatabase()
          .customer.findFirst({
            where: { id: preview.customer.id, status: "ACTIVE", deletedAt: null },
            select: {
              addresses: {
                where: { deletedAt: null },
                orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
                take: 20,
                select: {
                  id: true,
                  label: true,
                  recipientName: true,
                  phoneE164: true,
                  departmentCode: true,
                  municipalityCode: true,
                  addressLine1: true,
                  addressLine2: true,
                  neighborhood: true,
                  postalCode: true,
                  deliveryNotes: true,
                  isDefault: true,
                },
              },
            },
          })
          .then((record) => record?.addresses ?? [])
      : Promise.resolve([]),
  ]);
  return {
    ...preview,
    savedAddresses,
    paymentMethods: {
      wompiAccounts: credentials.items
        .filter((credential) => credential.provider === "wompi" && !credential.revokedAt)
        .map((credential, index) => ({
          id: credential.id,
          accountName: `Cuenta Wompi ${index + 1}`,
        })),
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
