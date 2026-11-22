import { FunnelService } from "@mundonettech/db";
import { z } from "zod";

import { getDatabase } from "@/lib/db";
import { getRequestSecurityContext } from "@/lib/security/request-context";

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

export async function GET() {
  return Response.json(
    { error: "Method not allowed." },
    { status: 405, headers: { ...headers, Allow: "POST" } },
  );
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).host !== request.headers.get("host")) {
      return Response.json({ error: "Invalid origin." }, { status: 403, headers });
    }
  } catch {
    return Response.json({ error: "Invalid origin." }, { status: 403, headers });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return Response.json({ error: "JSON is required." }, { status: 415, headers });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 2 || length > 16_384) {
    return Response.json({ error: "Invalid batch size." }, { status: 413, headers });
  }
  let clientKey = "loopback";
  try {
    const context = await getRequestSecurityContext();
    clientKey = Buffer.from(context.ipHash).toString("hex");
  } catch {
    clientKey = "unverified";
  }
  if (!acceptRate(clientKey)) {
    return Response.json({ error: "Rate limit exceeded." }, { status: 429, headers });
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
