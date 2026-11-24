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
  metaCapiService,
  shippingService,
} from "@/lib/integrations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function domainEventWorker(): DomainEventWorker {
  const db = getDatabase();
  return new DomainEventWorker(db, {
    workerId: `worker:${randomUUID()}`,
    shipping: shippingService(db),
    email: emailService(db),
    invoice: invoiceService(db),
    metaCapi: metaCapiService(db),
    vault: getIntegrationCredentialVault(),
    publicSiteUrl: getPublicSiteUrl(),
    storeName: storeConfig.name,
    receiptTokenForSubmission,
    eraseAuthUser: async (authUserId) => {
      const { error } = await createSupabaseAdminClient().auth.admin.deleteUser(authUserId);
      if (error && error.code !== "user_not_found") throw error;
    },
  });
}
