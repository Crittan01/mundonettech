import { ChannelOrderError, MercadoLibreCatalogError } from "@mundonettech/integrations";

import { channelOrderService } from "@/lib/integrations";

const maximumBodyBytes = 16_384;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maximumBodyBytes) {
    throw new RangeError("Invalid body size.");
  }
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
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
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
    const body = await readBody(request);
    const result = await channelOrderService().enqueueNotification({
      body,
      requestId: request.headers.get("x-request-id"),
      signature: request.headers.get("x-signature"),
    });
    return Response.json(result, { status: 202, headers });
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: "Payload too large." }, { status: 413, headers });
    }
    if (error instanceof MercadoLibreCatalogError && error.code === "INVALID_INPUT") {
      return Response.json({ error: "Webhook authentication failed." }, { status: 401, headers });
    }
    if (error instanceof MercadoLibreCatalogError) {
      return Response.json({ error: "Invalid webhook." }, { status: 400, headers });
    }
    if (error instanceof ChannelOrderError) {
      const status =
        error.code === "NOT_FOUND" ? 404 : error.code === "REAUTH_REQUIRED" ? 409 : 400;
      return Response.json({ error: "Webhook could not be accepted." }, { status, headers });
    }
    return Response.json({ error: "Webhook processing failed." }, { status: 500, headers });
  }
}
