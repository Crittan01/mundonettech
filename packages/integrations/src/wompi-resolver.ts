import type { IntegrationCredential, IntegrationEnvironment, PrismaClient } from "@mundonettech/db";

import type { IntegrationCredentialVault } from "./credential-vault.js";
import { PaymentConflictError, PaymentNotFoundError } from "./payment-types.js";
import { parseWompiCredentials, WompiPaymentProvider } from "./wompi.js";

export interface WompiResolution {
  readonly credential: IntegrationCredential;
  readonly provider: WompiPaymentProvider;
}

export async function resolveWompiProvider(options: {
  db: PrismaClient;
  vault: Pick<IntegrationCredentialVault, "reveal">;
  environment: IntegrationEnvironment;
  credentialId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WompiResolution> {
  const credentials = await options.db.integrationCredential.findMany({
    where: {
      ...(options.credentialId ? { id: options.credentialId } : {}),
      provider: "wompi",
      environment: options.environment,
      revokedAt: null,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 2,
  });
  const credential = credentials[0];
  if (!credential)
    throw new PaymentNotFoundError("No active Wompi credential exists for this environment.");
  if (credentials.length > 1) {
    throw new PaymentConflictError("Select an explicit Wompi credential for this payment account.");
  }
  const plaintext = await options.vault.reveal(credential.id);
  try {
    const parsed = parseWompiCredentials(plaintext, options.environment);
    return {
      credential,
      provider: new WompiPaymentProvider(parsed, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }),
    };
  } finally {
    plaintext.fill(0);
  }
}
