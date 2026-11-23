import "server-only";

import { storeConfig } from "@mundonettech/config/store";
import { IntegrationEnvironment, type PrismaClient } from "@mundonettech/db";
import {
  B2bCopilotService,
  BlockedIdentityService,
  CodReconciliationService,
  EmailService,
  GuestOrderAccessService,
  IntegrationCredentialVault,
  InvoiceService,
  PaymentRefundService,
  PaymentService,
  ShippingService,
  StoreCreditService,
  WompiWebhookService,
  loadCredentialKeyRing,
} from "@mundonettech/integrations";

import { getDatabase } from "@/lib/db";
import { getSessionHmacSecret } from "@/lib/env";

const state = globalThis as typeof globalThis & {
  __integrationCredentialVault?: IntegrationCredentialVault;
};

export function getIntegrationEnvironment(): IntegrationEnvironment {
  const configured = process.env.INTEGRATION_ENVIRONMENT;
  const inferred =
    process.env.VERCEL_ENV === "production"
      ? IntegrationEnvironment.PRD
      : process.env.VERCEL_ENV === "preview"
        ? IntegrationEnvironment.STG
        : IntegrationEnvironment.LOCAL;
  const value = configured ?? inferred;
  if (!Object.values(IntegrationEnvironment).includes(value as IntegrationEnvironment)) {
    throw new Error("INTEGRATION_ENVIRONMENT must be LOCAL, STG or PRD.");
  }
  return value as IntegrationEnvironment;
}

export function getIntegrationCredentialVault(): IntegrationCredentialVault {
  if (!state.__integrationCredentialVault) {
    const environment = getIntegrationEnvironment();
    state.__integrationCredentialVault = new IntegrationCredentialVault(
      getDatabase(),
      loadCredentialKeyRing(environment),
    );
  }
  return state.__integrationCredentialVault;
}

export function getPublicSiteUrl(): string {
  const raw = (process.env.SITE_URL ?? storeConfig.url).trim();
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("SITE_URL requires HTTPS outside loopback and no credentials or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

export function getBankTransferInstructions(): string | null {
  const value = process.env.BANK_TRANSFER_INSTRUCTIONS?.trim();
  if (!value) return null;
  if (
    value.length < 20 ||
    value.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error("BANK_TRANSFER_INSTRUCTIONS must contain 20 to 2000 printable characters.");
  }
  return value;
}

export function paymentService(db: PrismaClient = getDatabase()): PaymentService {
  return new PaymentService(db, { vault: getIntegrationCredentialVault() });
}

export function paymentRefundService(db: PrismaClient = getDatabase()): PaymentRefundService {
  return new PaymentRefundService(db, { vault: getIntegrationCredentialVault() });
}

export function wompiWebhookService(db: PrismaClient = getDatabase()): WompiWebhookService {
  return new WompiWebhookService(db, { vault: getIntegrationCredentialVault() });
}

export function storeCreditService(db: PrismaClient = getDatabase()): StoreCreditService {
  return new StoreCreditService(db);
}

export function codReconciliationService(
  db: PrismaClient = getDatabase(),
): CodReconciliationService {
  return new CodReconciliationService(db);
}

export function blockedIdentityService(db: PrismaClient = getDatabase()): BlockedIdentityService {
  return new BlockedIdentityService(db);
}

export function shippingService(db: PrismaClient = getDatabase()): ShippingService {
  return new ShippingService(db, {
    vault: getIntegrationCredentialVault(),
    environment: getIntegrationEnvironment(),
  });
}

export function emailService(db: PrismaClient = getDatabase()): EmailService {
  return new EmailService(db, {
    vault: getIntegrationCredentialVault(),
    publicSiteUrl: getPublicSiteUrl(),
  });
}

export function invoiceService(db: PrismaClient = getDatabase()): InvoiceService {
  return new InvoiceService(db, {
    vault: getIntegrationCredentialVault(),
    environment: getIntegrationEnvironment(),
  });
}

export function b2bCopilotService(db: PrismaClient = getDatabase()): B2bCopilotService {
  return new B2bCopilotService(db, { vault: getIntegrationCredentialVault() });
}

export function guestOrderAccessService(db: PrismaClient = getDatabase()): GuestOrderAccessService {
  return new GuestOrderAccessService(db, {
    secret: getSessionHmacSecret(),
    storeName: storeConfig.name,
    vault: getIntegrationCredentialVault(),
  });
}
