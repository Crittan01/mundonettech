import { FunnelService } from "@mundonettech/db";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
import { hasCanonicalSameOrigin } from "@/lib/security/origin";
import { getRequestSecurityContext } from "@/lib/security/request-context";

const maximumBodyBytes = 16_384;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

const counter = z.number().int().min(0).max(1000).optional();
const batchSchema = z
  .object({
    pageViews: counter,
    productViews: counter,
    cartAdditions: counter,
    checkoutStarts: counter,
  })
  .strict()
  .refine((value) => {
    const sum = [
      value.pageViews,
      value.productViews,
      value.cartAdditions,
      value.checkoutStarts,
    ].reduce<number>((total, entry) => total + (entry ?? 0), 0);
    return sum >= 1 && sum <= 2000;
  });

const rateState = globalThis as typeof globalThis & {
  __funnelMetricWindow?: {
    readonly startedAt: number;
    globalCount: number;
    readonly perClient: Map<string, number>;
  };
};

function acceptRate(clientKey: string): boolean {
  const now = Date.now();
  if (!rateState.__funnelMetricWindow || now - rateState.__funnelMetricWindow.startedAt >= 60_000) {
    rateState.__funnelMetricWindow = {
      startedAt: now,
      globalCount: 1,
      perClient: new Map([[clientKey, 1]]),
    };
    return true;
  }
  const window = rateState.__funnelMetricWindow;
  if (window.globalCount >= 6_000) return false;
  const current = window.perClient.get(clientKey) ?? 0;
  if (current >= 60) return false;
  if (!window.perClient.has(clientKey) && window.perClient.size >= 5_000) return false;
  window.globalCount += 1;
  window.perClient.set(clientKey, current + 1);
  return true;
}

function hasValidOrigin(request: Request): boolean {
  return hasCanonicalSameOrigin(request);
}

function declaredBodyLength(request: Request): number {
  const value = request.headers.get("content-length");
  if (value === null || !/^[0-9]+$/.test(value)) throw new RangeError("Invalid body size.");
  const declared = Number(value);
  if (!Number.isSafeInteger(declared) || declared < 2 || declared > maximumBodyBytes) {
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
  if (!hasValidOrigin(request)) {
    return Response.json({ error: "Invalid origin." }, { status: 403, headers });
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return Response.json({ error: "JSON is required." }, { status: 415, headers });
  }
  try {
    declaredBodyLength(request);
  } catch {
    return Response.json({ error: "Invalid batch size." }, { status: 413, headers });
  }
  let clientKey: string;
  try {
    const context = await getRequestSecurityContext();
    clientKey = Buffer.from(context.ipHash).toString("hex");
  } catch {
    return Response.json({ error: "Metrics are unavailable." }, { status: 503, headers });
  }
  if (!acceptRate(clientKey)) {
    return Response.json(
      { error: "Rate limit exceeded." },
      { status: 429, headers: { ...headers, "Retry-After": "60" } },
    );
  }
  try {
    const text = await readBody(request);
    const batch = batchSchema.parse(JSON.parse(text));
    await new FunnelService(getDatabase()).recordPublicBatch({
      ...(batch.pageViews === undefined ? {} : { pageViews: BigInt(batch.pageViews) }),
      ...(batch.productViews === undefined ? {} : { productViews: BigInt(batch.productViews) }),
      ...(batch.cartAdditions === undefined ? {} : { cartAdditions: BigInt(batch.cartAdditions) }),
      ...(batch.checkoutStarts === undefined
        ? {}
        : { checkoutStarts: BigInt(batch.checkoutStarts) }),
    });
    return Response.json({ accepted: true }, { status: 202, headers });
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: "Invalid batch size." }, { status: 413, headers });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json({ error: "Invalid aggregate batch." }, { status: 400, headers });
    }
    return Response.json({ error: "Metrics could not be recorded." }, { status: 500, headers });
  }
}
