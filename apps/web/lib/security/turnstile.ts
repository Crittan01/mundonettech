import "server-only";

import { verifyTurnstile } from "@mundonettech/core";
import { storeConfig } from "@mundonettech/config/store";
import { getTurnstileKeys } from "@/lib/env";

export interface TurnstileVerificationOptions {
  expectedAction: string;
  expectedHostname?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export async function verifyTurnstileToken(
  token: string,
  options: TurnstileVerificationOptions,
): Promise<void> {
  try {
    const expectedHostname =
      options.expectedHostname ??
      (process.env.NODE_ENV === "production"
        ? (process.env.TURNSTILE_EXPECTED_HOSTNAME ?? storeConfig.domain)
        : undefined);
    await verifyTurnstile(token, {
      ...options,
      ...(expectedHostname ? { expectedHostname } : {}),
      secretKey: getTurnstileKeys().secretKey,
    });
  } catch {
    throw new Error(
      "La validación de seguridad no es válida o no está disponible. Inténtalo de nuevo.",
    );
  }
}
