import {
  EmailConflictError,
  EmailProviderError,
  EmailValidationError,
} from "@mundonettech/integrations";

import { emailService } from "@/lib/integrations";

const maxWebhookBytes = 1_000_000;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

function declaredBodyLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new RangeError("Invalid body size.");
  const declared = Number(value);
  if (!Number.isSafeInteger(declared) || declared > maxWebhookBytes) {
    throw new RangeError("Invalid body size.");
  }
  return declared;
}

async function readBoundedBody(request: Request): Promise<string> {
  declaredBodyLength(request);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxWebhookBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("Invalid body size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new SyntaxError("Invalid UTF-8 body.");
  }
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function GET() {
  return methodNotAllowed();
}

export async function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ error: "JSON is required." }, { status: 415, headers });
  }
  try {
    const body = await readBoundedBody(request);
    const result = await emailService().processWebhook({
      body,
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    });
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: "Payload too large." }, { status: 413, headers });
    }
    if (error instanceof EmailConflictError && error.code === "IDEMPOTENCY_CONFLICT") {
      return Response.json(
        { error: "Webhook conflicts with a previously processed event." },
        { status: 409, headers },
      );
    }
    if (error instanceof EmailProviderError && error.code === "NETWORK_UNCERTAIN") {
      return Response.json(
        { error: "Temporary delivery synchronization conflict. Retry webhook." },
        { status: 503, headers },
      );
    }
    if (error instanceof EmailValidationError || error instanceof SyntaxError) {
      return Response.json({ error: "Invalid webhook." }, { status: 401, headers });
    }
    return Response.json({ error: "Webhook processing failed." }, { status: 500, headers });
  }
}
