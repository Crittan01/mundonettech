import { FunnelService } from "@mundonettech/db";
import { z } from "zod";

import { getDatabase } from "@/lib/db";

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
  .refine(
    (value) =>
      [
        value.pageViews,
        value.productViews,
        value.cartAdditions,
        value.checkoutStarts,
      ].reduce<number>((sum, entry) => sum + (entry ?? 0), 0) <= 2000,
  );

const rateState = globalThis as typeof globalThis & {
  __funnelMetricWindow?: { readonly startedAt: number; count: number };
};

function acceptRate(): boolean {
  const now = Date.now();
  if (!rateState.__funnelMetricWindow || now - rateState.__funnelMetricWindow.startedAt >= 60_000) {
    rateState.__funnelMetricWindow = { startedAt: now, count: 1 };
    return true;
  }
  if (rateState.__funnelMetricWindow.count >= 120) return false;
  rateState.__funnelMetricWindow.count += 1;
  return true;
}

export async function GET() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function POST(request: Request) {
  if (!acceptRate())
    return Response.json({ error: "Rate limit exceeded." }, { status: 429, headers });
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).host !== request.headers.get("host")) {
      return Response.json({ error: "Invalid origin." }, { status: 403, headers });
    }
  } catch {
    return Response.json({ error: "Invalid origin." }, { status: 403, headers });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Response.json({ error: "JSON is required." }, { status: 415, headers });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 2 || length > 16_384) {
    return Response.json({ error: "Invalid batch size." }, { status: 413, headers });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    return Response.json({ error: "Invalid batch size." }, { status: 413, headers });
  }
  try {
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
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      return Response.json({ error: "Invalid aggregate batch." }, { status: 400, headers });
    }
    throw error;
  }
}
