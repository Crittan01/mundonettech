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

function testVerificationEndpoint(): string | undefined {
  const value = process.env.TURNSTILE_VERIFY_ENDPOINT?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("TURNSTILE_VERIFY_ENDPOINT is restricted to a loopback URL.");
  }
  return url.toString();
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
    const endpoint = options.endpoint ?? testVerificationEndpoint();
    await verifyTurnstile(token, {
      ...options,
      ...(expectedHostname ? { expectedHostname } : {}),
      ...(endpoint ? { endpoint } : {}),
      secretKey: getTurnstileKeys().secretKey,
    });
  } catch {
    throw new Error(
      "La validación de seguridad no es válida o no está disponible. Inténtalo de nuevo.",
    );
  }
}
