import "server-only";

import { storeConfig } from "@mundonettech/config/store";
import { IntegrationEnvironment, type PrismaClient } from "@mundonettech/db";
import {
  B2bCopilotService,
  BlockedIdentityService,
  ChannelAccountService,
  ChannelCatalogService,
  ChannelOrderService,
  CodReconciliationService,
  EmailService,
  GuestOrderAccessService,
  IntegrationCredentialVault,
  InvoiceService,
  MetaCapiService,
  PaymentRefundService,
  PaymentService,
  ShippingService,
  StoreCreditService,
  WompiWebhookService,
  loadCredentialKeyRing,
} from "@mundonettech/integrations";

import { getDatabase } from "@/lib/db";
import { getPublicMediaOrigin, getSessionHmacSecret } from "@/lib/env";

const state = globalThis as typeof globalThis & {
  __integrationCredentialVault?: IntegrationCredentialVault;
};

export function getIntegrationEnvironment(): IntegrationEnvironment {
  const configured = process.env.INTEGRATION_ENVIRONMENT;
  const vercelEnvironment = process.env.VERCEL_ENV;
  const inferred =
    vercelEnvironment === "production"
      ? IntegrationEnvironment.PRD
      : vercelEnvironment === "preview"
        ? IntegrationEnvironment.STG
        : IntegrationEnvironment.LOCAL;
  const value = configured ?? inferred;
  if (!Object.values(IntegrationEnvironment).includes(value as IntegrationEnvironment)) {
    throw new Error("INTEGRATION_ENVIRONMENT must be LOCAL, STG or PRD.");
  }
  if (
    value !== inferred &&
    (vercelEnvironment === "production" || vercelEnvironment === "preview")
  ) {
    throw new Error("INTEGRATION_ENVIRONMENT must match the isolated Vercel environment.");
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
  return new PaymentService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("wompi"),
  });
}

export function paymentRefundService(db: PrismaClient = getDatabase()): PaymentRefundService {
  return new PaymentRefundService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("wompi"),
  });
}

export function wompiWebhookService(db: PrismaClient = getDatabase()): WompiWebhookService {
  return new WompiWebhookService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("wompi"),
  });
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
    vault: getIntegrationCredentialVault().forSystemProvider("aveonline"),
    environment: getIntegrationEnvironment(),
  });
}

export function emailService(db: PrismaClient = getDatabase()): EmailService {
  return new EmailService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("resend"),
    publicSiteUrl: getPublicSiteUrl(),
    environment: getIntegrationEnvironment(),
  });
}

export function invoiceService(db: PrismaClient = getDatabase()): InvoiceService {
  return new InvoiceService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("dian"),
    environment: getIntegrationEnvironment(),
  });
}

export function b2bCopilotService(db: PrismaClient = getDatabase()): B2bCopilotService {
  return new B2bCopilotService(db, {
    vault: getIntegrationCredentialVault().forSystemProvider("gemini"),
    environment: getIntegrationEnvironment(),
  });
}

export function guestOrderAccessService(db: PrismaClient = getDatabase()): GuestOrderAccessService {
  return new GuestOrderAccessService(db, {
    secret: getSessionHmacSecret(),
    storeName: storeConfig.name,
    vault: getIntegrationCredentialVault().forSystemProvider("resend"),
    environment: getIntegrationEnvironment(),
  });
}

export function channelAccountService(db: PrismaClient = getDatabase()): ChannelAccountService {
  const environment = getIntegrationEnvironment();
  const tokenUrl = process.env.MERCADO_LIBRE_TOKEN_URL?.trim();
  return new ChannelAccountService(db, {
    ring: loadCredentialKeyRing(environment),
    ...(tokenUrl ? { tokenUrl } : {}),
    allowLoopback: environment === IntegrationEnvironment.LOCAL,
  });
}

export function mercadoLibreOAuthRedirectUri(): string {
  return `${getPublicSiteUrl()}/api/channels/mercado-libre/oauth/callback`;
}

export function channelCatalogService(db: PrismaClient = getDatabase()): ChannelCatalogService {
  const environment = getIntegrationEnvironment();
  const apiUrl = process.env.MERCADO_LIBRE_API_URL?.trim();
  const mediaBaseUrl = getPublicMediaOrigin();
  if (!mediaBaseUrl) {
    throw new Error("MEDIA_BASE_URL is required for Mercado Libre product pictures.");
  }
  return new ChannelCatalogService(db, {
    ring: loadCredentialKeyRing(environment),
    mediaBaseUrl,
    ...(apiUrl ? { apiUrl } : {}),
    allowLoopback: environment === IntegrationEnvironment.LOCAL,
  });
}

export function channelOrderService(db: PrismaClient = getDatabase()): ChannelOrderService {
  const environment = getIntegrationEnvironment();
  const apiUrl = process.env.MERCADO_LIBRE_API_URL?.trim();
  return new ChannelOrderService(db, {
    ring: loadCredentialKeyRing(environment),
    ...(apiUrl ? { apiUrl } : {}),
    allowLoopback: environment === IntegrationEnvironment.LOCAL,
  });
}

export function metaCapiService(db: PrismaClient = getDatabase()): MetaCapiService {
  const environment = getIntegrationEnvironment();
  const apiUrl = process.env.META_CAPI_API_URL?.trim();
  return new MetaCapiService(db, {
    environment,
    publicSiteUrl: getPublicSiteUrl(),
    vault: getIntegrationCredentialVault().forSystemProvider("meta"),
    ...(apiUrl ? { apiUrl } : {}),
    allowLoopback: environment === IntegrationEnvironment.LOCAL,
  });
}
