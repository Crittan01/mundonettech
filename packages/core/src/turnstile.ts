export interface TurnstileVerificationOptions {
  secretKey: string;
  expectedAction: string;
  expectedHostname?: string;
  allowTestingKeyWithoutAction?: boolean;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

interface TurnstileResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  metadata?: { result_with_testing_key?: unknown };
  "error-codes"?: unknown;
}

export async function verifyTurnstile(
  token: string,
  options: TurnstileVerificationOptions,
): Promise<void> {
  if (!token || token.length > 2048 || !/^[A-Za-z0-9._-]+$/.test(token))
    throw new Error("Invalid security challenge.");
  if (!options.secretKey || !/^[a-z0-9_-]{1,60}$/.test(options.expectedAction))
    throw new Error("Invalid Turnstile configuration.");
  const response = await (options.fetchImpl ?? fetch)(
    options.endpoint ?? "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({ secret: options.secretKey, response: token }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    },
  );
  if (!response.ok) throw new Error("Security challenge verification unavailable.");
  const parsed = (await response.json()) as TurnstileResponse;
  const errorCodes = Array.isArray(parsed["error-codes"]) ? parsed["error-codes"] : [];
  const isTestingKeyWithoutAction =
    options.allowTestingKeyWithoutAction === true &&
    parsed.action === undefined &&
    parsed.metadata?.result_with_testing_key === true;
  if (
    parsed.success !== true ||
    (!isTestingKeyWithoutAction && parsed.action !== options.expectedAction) ||
    (options.expectedHostname !== undefined && parsed.hostname !== options.expectedHostname) ||
    errorCodes.length > 0
  ) {
    throw new Error("Invalid security challenge.");
  }
}
