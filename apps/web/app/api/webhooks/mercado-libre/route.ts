import { ChannelOrderError, MercadoLibreCatalogError } from "@mundonettech/integrations";

import { channelOrderService } from "@/lib/integrations";

const maximumBodyBytes = 16_384;
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
  if (!Number.isSafeInteger(declared) || declared > maximumBodyBytes) {
    throw new RangeError("Invalid body size.");
  }
  return declared;
}

async function readBody(request: Request): Promise<string> {
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
      if (total > maximumBodyBytes) {
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

export function GET(): Response {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ error: "JSON is required." }, { status: 415, headers });
  }
  try {
    const url = new URL(request.url);
    const queryDataIds = url.searchParams.getAll("data.id");
    if (queryDataIds.length > 1) {
      return Response.json({ error: "Invalid webhook." }, { status: 400, headers });
    }
    const body = await readBody(request);
    const result = await channelOrderService().enqueueNotification({
      body,
      requestId: request.headers.get("x-request-id"),
      signature: request.headers.get("x-signature"),
      queryDataId: queryDataIds[0] ?? null,
    });
    return Response.json(result, { status: 202, headers });
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: "Payload too large." }, { status: 413, headers });
    }
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid webhook." }, { status: 400, headers });
    }
    if (error instanceof MercadoLibreCatalogError && error.code === "INVALID_INPUT") {
      return Response.json({ error: "Webhook authentication failed." }, { status: 401, headers });
    }
    if (error instanceof MercadoLibreCatalogError) {
      return Response.json({ error: "Invalid webhook." }, { status: 400, headers });
    }
    if (error instanceof ChannelOrderError) {
      if (["NOT_FOUND", "FORBIDDEN", "REAUTH_REQUIRED"].includes(error.code)) {
        return Response.json({ error: "Webhook authentication failed." }, { status: 401, headers });
      }
      return Response.json({ error: "Invalid webhook." }, { status: 400, headers });
    }
    return Response.json({ error: "Webhook processing failed." }, { status: 500, headers });
  }
}
