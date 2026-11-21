import { createHash, timingSafeEqual } from "node:crypto";

import { OrderLifecycleService } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

function matchesSecret(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const secret = process.env.ORDER_CRON_SECRET?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (secret.length < 16) {
    return Response.json(
      { error: "Order scheduler is not configured." },
      { status: 503, headers: noStoreHeaders },
    );
  }
  if (!authorization.startsWith("Bearer ") || !matchesSecret(authorization.slice(7), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
  }
  const service = new OrderLifecycleService(getDatabase());
  const abandoned = await service.captureAbandonedCarts();
  const reservations = await service.releaseExpiredOrderReservations();
  return Response.json(
    {
      abandonedCarts: abandoned,
      expiredReservations: reservations,
    },
    { headers: noStoreHeaders },
  );
}
