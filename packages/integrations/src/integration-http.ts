export class IntegrationTransportError extends Error {
  constructor(
    message: string,
    readonly code: "RESPONSE_TOO_LARGE" | "NETWORK_UNCERTAIN" = "NETWORK_UNCERTAIN",
  ) {
    super(message);
    this.name = "IntegrationTransportError";
  }
}

export interface LimitedHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Headers;
}

export async function fetchWithLimit(options: {
  readonly url: string;
  readonly init: RequestInit;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly maximumBytes?: number;
}): Promise<LimitedHttpResponse> {
  const maximumBytes = options.maximumBytes ?? 1_000_000;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 50_000_000) {
    throw new TypeError("maximumBytes must be an integer between 1 and 50000000.");
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 60_000
  ) {
    throw new TypeError("timeoutMs must be between 100 and 60000.");
  }
  const controller = new AbortController();
  const callerSignal = options.init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(options.url, {
      ...options.init,
      redirect: "error",
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maximumBytes) {
      await response.body?.cancel();
      throw new IntegrationTransportError(
        "Provider response exceeds the configured resource limit.",
        "RESPONSE_TOO_LARGE",
      );
    }
    if (!response.body) return { status: response.status, body: "", headers: response.headers };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new IntegrationTransportError(
          "Provider response exceeds the configured resource limit.",
          "RESPONSE_TOO_LARGE",
        );
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      body: new TextDecoder("utf-8", { fatal: true }).decode(merged),
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof IntegrationTransportError) throw error;
    throw new IntegrationTransportError(
      "Provider communication did not produce a deterministic response.",
    );
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function parseHttpJson(body: string): Record<string, unknown> {
  if (!body) throw new IntegrationTransportError("Provider returned an empty response.");
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new IntegrationTransportError("Provider returned invalid JSON.");
  }
}
