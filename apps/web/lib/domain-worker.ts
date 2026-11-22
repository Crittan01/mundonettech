import "server-only";

import { randomUUID } from "node:crypto";

import { storeConfig } from "@mundonettech/config/store";
import { DomainEventWorker } from "@mundonettech/integrations";

import { receiptTokenForSubmission } from "@/lib/checkout";
import { getDatabase } from "@/lib/db";
import {
  emailService,
  getIntegrationCredentialVault,
  getPublicSiteUrl,
  invoiceService,
  shippingService,
} from "@/lib/integrations";

export function domainEventWorker(): DomainEventWorker {
  const db = getDatabase();
  return new DomainEventWorker(db, {
    workerId: `worker:${randomUUID()}`,
    shipping: shippingService(db),
    email: emailService(db),
    invoice: invoiceService(db),
    vault: getIntegrationCredentialVault(),
    publicSiteUrl: getPublicSiteUrl(),
    storeName: storeConfig.name,
    receiptTokenForSubmission,
  });
}
